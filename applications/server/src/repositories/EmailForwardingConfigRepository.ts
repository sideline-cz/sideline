import { randomBytes } from 'node:crypto';
import { Discord, Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

export class EmailForwardingConfigRow extends Schema.Class<EmailForwardingConfigRow>(
  'EmailForwardingConfigRow',
)({
  team_id: Team.TeamId,
  enabled: Schema.Boolean,
  target_channel_id: Discord.Snowflake,
  coach_channel_id: Discord.Snowflake,
  monitored_addresses: Schema.Array(Schema.String),
  inbound_token: Schema.String,
  created_at: Schema.DateTimeUtc,
  updated_at: Schema.DateTimeUtc,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: EmailForwardingConfigRow,
    execute: (teamId) => sql`
      SELECT team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token, created_at, updated_at
      FROM email_forwarding_config
      WHERE team_id = ${teamId}::uuid
    `,
  });

  const findByInboundTokenQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EmailForwardingConfigRow,
    execute: (token) => sql`
      SELECT team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token, created_at, updated_at
      FROM email_forwarding_config
      WHERE inbound_token = ${token}
    `,
  });

  const upsertQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      enabled: Schema.Boolean,
      target_channel_id: Schema.String,
      coach_channel_id: Schema.String,
      monitored_addresses: Schema.Array(Schema.String),
    }),
    Result: EmailForwardingConfigRow,
    execute: (input) => sql`
      INSERT INTO email_forwarding_config (team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token)
      VALUES (${input.team_id}::uuid, ${input.enabled}, ${input.target_channel_id}, ${input.coach_channel_id}, ${input.monitored_addresses}, ${randomBytes(32).toString('base64url')})
      ON CONFLICT (team_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        target_channel_id = EXCLUDED.target_channel_id,
        coach_channel_id = EXCLUDED.coach_channel_id,
        monitored_addresses = EXCLUDED.monitored_addresses,
        updated_at = now()
      RETURNING team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token, created_at, updated_at
    `,
  });

  const regenerateTokenQuery = SqlSchema.findOne({
    Request: Team.TeamId,
    Result: EmailForwardingConfigRow,
    execute: (teamId) => sql`
      UPDATE email_forwarding_config
      SET inbound_token = ${randomBytes(32).toString('base64url')},
          updated_at = now()
      WHERE team_id = ${teamId}::uuid
      RETURNING team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token, created_at, updated_at
    `,
  });

  const findByTeam = (teamId: Team.TeamId) => findByTeamQuery(teamId).pipe(catchSqlErrors);

  const upsert = (input: {
    readonly team_id: Team.TeamId;
    readonly enabled: boolean;
    readonly target_channel_id: string;
    readonly coach_channel_id: string;
    readonly monitored_addresses: readonly string[];
  }) =>
    upsertQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die(`Failed upserting email_forwarding_config for team ${input.team_id}`),
      ),
    );

  const findByInboundToken = (token: string) => findByInboundTokenQuery(token).pipe(catchSqlErrors);

  const regenerateToken = (teamId: Team.TeamId) =>
    regenerateTokenQuery(teamId).pipe(
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die(`Failed regenerating token for team ${teamId} — no row returned`),
      ),
    );

  return {
    findByTeam,
    upsert,
    findByInboundToken,
    regenerateToken,
  } as const;
});

export class EmailForwardingConfigRepository extends ServiceMap.Service<
  EmailForwardingConfigRepository,
  Effect.Success<typeof make>
>()('api/EmailForwardingConfigRepository') {
  static readonly Default = Layer.effect(EmailForwardingConfigRepository, make);
}
