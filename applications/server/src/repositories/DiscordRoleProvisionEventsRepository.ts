import { Discord, RoleProvisionRpcGroup, Team } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const MAX_ATTEMPTS = 5;

export class DiscordRoleProvisionEventRow extends Schema.Class<DiscordRoleProvisionEventRow>(
  'DiscordRoleProvisionEventRow',
)({
  id: RoleProvisionRpcGroup.RoleProvisionEventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  kind: RoleProvisionRpcGroup.RoleProvisionKind,
  ref_id: Schema.String,
  desired_name: Schema.String,
}) {}

const EnqueueInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  kind: RoleProvisionRpcGroup.RoleProvisionKind,
  ref_id: Schema.String,
  desired_name: Schema.String,
});

const MarkProcessedInput = Schema.Struct({
  id: RoleProvisionRpcGroup.RoleProvisionEventId,
});

const MarkAttemptFailedInput = Schema.Struct({
  id: RoleProvisionRpcGroup.RoleProvisionEventId,
  error: Schema.String,
  maxAttempts: Schema.Number,
});

const SupersedeInput = Schema.Struct({
  team_id: Team.TeamId,
  kind: RoleProvisionRpcGroup.RoleProvisionKind,
  ref_id: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const enqueueQuery = SqlSchema.void({
    Request: EnqueueInput,
    execute: (input) => sql`
      INSERT INTO discord_role_provision_events (team_id, guild_id, kind, ref_id, desired_name)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.kind}, ${input.ref_id}, ${input.desired_name})
      ON CONFLICT (team_id, kind, ref_id) DO NOTHING
    `,
  });

  const findUnprocessedQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: DiscordRoleProvisionEventRow,
    execute: (teamId) => sql`
      SELECT id, team_id, guild_id, kind, ref_id, desired_name
      FROM discord_role_provision_events
      WHERE processed_at IS NULL AND team_id = ${teamId}
      ORDER BY created_at ASC
    `,
  });

  const findUnprocessedAllQuery = SqlSchema.findAll({
    Request: Schema.Number,
    Result: DiscordRoleProvisionEventRow,
    execute: (limit) => sql`
      SELECT id, team_id, guild_id, kind, ref_id, desired_name
      FROM discord_role_provision_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  const markProcessedQuery = SqlSchema.void({
    Request: MarkProcessedInput,
    execute: (input) => sql`
      UPDATE discord_role_provision_events SET processed_at = now() WHERE id = ${input.id}
    `,
  });

  const markAttemptFailedQuery = SqlSchema.void({
    Request: MarkAttemptFailedInput,
    execute: (input) => sql`
      UPDATE discord_role_provision_events
      SET
        attempts = attempts + 1,
        error = ${input.error},
        processed_at = CASE WHEN attempts + 1 >= ${input.maxAttempts} THEN now() ELSE NULL END
      WHERE id = ${input.id}
    `,
  });

  const supersedeQuery = SqlSchema.void({
    Request: SupersedeInput,
    execute: (input) => sql`
      UPDATE discord_role_provision_events
      SET processed_at = now(), error = 'superseded_by_user'
      WHERE team_id = ${input.team_id}
        AND kind = ${input.kind}
        AND ref_id = ${input.ref_id}
        AND processed_at IS NULL
    `,
  });

  const enqueue = (
    teamId: Team.TeamId,
    guildId: Discord.Snowflake,
    kind: RoleProvisionRpcGroup.RoleProvisionKind,
    refId: string,
    desiredName: string,
  ): Effect.Effect<void> =>
    enqueueQuery({
      team_id: teamId,
      guild_id: guildId,
      kind,
      ref_id: refId,
      desired_name: desiredName,
    }).pipe(catchSqlErrors);

  const findUnprocessed = (
    teamId: Team.TeamId,
  ): Effect.Effect<ReadonlyArray<DiscordRoleProvisionEventRow>> =>
    findUnprocessedQuery(teamId).pipe(catchSqlErrors);

  const findUnprocessedAll = (
    limit: number,
  ): Effect.Effect<ReadonlyArray<DiscordRoleProvisionEventRow>> =>
    findUnprocessedAllQuery(limit).pipe(catchSqlErrors);

  const markProcessed = (id: RoleProvisionRpcGroup.RoleProvisionEventId): Effect.Effect<void> =>
    markProcessedQuery({ id }).pipe(catchSqlErrors);

  const markFailed = (
    id: RoleProvisionRpcGroup.RoleProvisionEventId,
    error: string,
  ): Effect.Effect<void> =>
    markAttemptFailedQuery({ id, error, maxAttempts: MAX_ATTEMPTS }).pipe(catchSqlErrors);

  const supersede = (
    teamId: Team.TeamId,
    kind: RoleProvisionRpcGroup.RoleProvisionKind,
    refId: string,
  ): Effect.Effect<void> =>
    supersedeQuery({ team_id: teamId, kind, ref_id: refId }).pipe(catchSqlErrors);

  return {
    enqueue,
    findUnprocessed,
    findUnprocessedAll,
    markProcessed,
    markFailed,
    supersede,
  };
});

export class DiscordRoleProvisionEventsRepository extends ServiceMap.Service<
  DiscordRoleProvisionEventsRepository,
  Effect.Success<typeof make>
>()('api/DiscordRoleProvisionEventsRepository') {
  static readonly Default = Layer.effect(DiscordRoleProvisionEventsRepository, make);
}
