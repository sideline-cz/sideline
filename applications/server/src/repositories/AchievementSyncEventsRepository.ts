import { Achievement, AchievementSyncEvent, Discord, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class GuildLookupResult extends Schema.Class<GuildLookupResult>('AchievementGuildLookupResult')({
  guild_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  team_member_id: TeamMember.TeamMemberId,
  achievement_slug: Achievement.AchievementSlug,
});

export class AchievementSyncEventRow extends Schema.Class<AchievementSyncEventRow>(
  'AchievementSyncEventRow',
)({
  id: AchievementSyncEvent.AchievementSyncEventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  team_member_id: TeamMember.TeamMemberId,
  achievement_slug: Achievement.AchievementSlug,
  discord_user_id: Discord.Snowflake,
  achievement_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const MarkProcessedInput = Schema.Struct({
  id: AchievementSyncEvent.AchievementSyncEventId,
});

const MarkFailedInput = Schema.Struct({
  id: AchievementSyncEvent.AchievementSyncEventId,
  error: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const lookupGuildId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GuildLookupResult,
    execute: (teamId) => sql`SELECT guild_id FROM teams WHERE id = ${teamId}`,
  });

  const insertEvent = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO achievement_sync_events (team_id, guild_id, team_member_id, achievement_slug)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.team_member_id}, ${input.achievement_slug})
    `,
  });

  const findUnprocessedQuery = SqlSchema.findAll({
    Request: Schema.Number,
    Result: AchievementSyncEventRow,
    execute: (limit) => sql`
      SELECT
        ase.id, ase.team_id, ase.guild_id, ase.team_member_id, ase.achievement_slug,
        u.discord_id AS discord_user_id,
        t.achievement_channel_id AS achievement_channel_id,
        arm.discord_role_id AS discord_role_id
      FROM achievement_sync_events ase
      JOIN team_members tm ON tm.id = ase.team_member_id
      JOIN users u ON u.id = tm.user_id
      JOIN teams t ON t.id = ase.team_id
      LEFT JOIN achievement_role_mappings arm ON arm.team_id = ase.team_id AND arm.achievement_slug = ase.achievement_slug
      WHERE ase.processed_at IS NULL
      ORDER BY ase.created_at ASC
      LIMIT ${limit}
    `,
  });

  const markEventProcessed = SqlSchema.void({
    Request: MarkProcessedInput,
    execute: (input) => sql`
      UPDATE achievement_sync_events SET processed_at = now() WHERE id = ${input.id}
    `,
  });

  const markEventFailed = SqlSchema.void({
    Request: MarkFailedInput,
    execute: (input) => sql`
      UPDATE achievement_sync_events SET processed_at = now(), error = ${input.error} WHERE id = ${input.id}
    `,
  });

  const emit = (
    teamId: Team.TeamId,
    teamMemberId: TeamMember.TeamMemberId,
    slug: Achievement.AchievementSlug,
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            Option.match(guild_id, {
              onNone: () => Effect.void,
              onSome: (guildId) =>
                insertEvent({
                  team_id: teamId,
                  guild_id: guildId,
                  team_member_id: teamMemberId,
                  achievement_slug: slug,
                }),
            }),
        }),
      ),
      catchSqlErrors,
    );

  const findUnprocessed = (limit: number) => findUnprocessedQuery(limit).pipe(catchSqlErrors);

  const markProcessed = (id: AchievementSyncEvent.AchievementSyncEventId | undefined) =>
    id !== undefined ? markEventProcessed({ id }).pipe(catchSqlErrors) : Effect.void;

  const markFailed = (
    id: AchievementSyncEvent.AchievementSyncEventId | undefined,
    error: string,
  ) => (id !== undefined ? markEventFailed({ id, error }).pipe(catchSqlErrors) : Effect.void);

  return {
    emit,
    findUnprocessed,
    markProcessed,
    markFailed,
  };
});

export class AchievementSyncEventsRepository extends ServiceMap.Service<
  AchievementSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/AchievementSyncEventsRepository') {
  static readonly Default = Layer.effect(AchievementSyncEventsRepository, make);
}
