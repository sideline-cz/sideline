import { randomBytes } from 'node:crypto';
import { Discord, Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
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
  imap_enabled: Schema.Boolean,
  imap_host: Schema.OptionFromNullOr(Schema.String),
  imap_port: Schema.OptionFromNullOr(Schema.Int),
  imap_username: Schema.OptionFromNullOr(Schema.String),
  imap_secret_encrypted: Schema.OptionFromNullOr(Schema.String),
  imap_use_tls: Schema.Boolean,
  imap_folder: Schema.OptionFromNullOr(Schema.String),
  imap_last_seen_uid: Schema.Int,
  imap_uid_validity: Schema.OptionFromNullOr(Schema.Int),
  imap_last_synced_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromDate),
  created_at: Schema.DateTimeUtcFromDate,
  updated_at: Schema.DateTimeUtcFromDate,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const SELECT_COLUMNS = sql`
    team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token,
    imap_enabled, imap_host, imap_port, imap_username, imap_secret_encrypted, imap_use_tls,
    imap_folder, imap_last_seen_uid, imap_uid_validity, imap_last_synced_at,
    created_at, updated_at
  `;

  const findByTeamQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: EmailForwardingConfigRow,
    execute: (teamId) => sql`
      SELECT ${SELECT_COLUMNS}
      FROM email_forwarding_config
      WHERE team_id = ${teamId}::uuid
    `,
  });

  const findByInboundTokenQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: EmailForwardingConfigRow,
    execute: (token) => sql`
      SELECT ${SELECT_COLUMNS}
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
      imap_enabled: Schema.Boolean,
      imap_host: Schema.OptionFromNullOr(Schema.String),
      imap_port: Schema.OptionFromNullOr(Schema.Int),
      imap_username: Schema.OptionFromNullOr(Schema.String),
      imap_secret_encrypted: Schema.OptionFromNullOr(Schema.String),
      imap_use_tls: Schema.Boolean,
      imap_folder: Schema.OptionFromNullOr(Schema.String),
    }),
    Result: EmailForwardingConfigRow,
    execute: (input) => sql`
      INSERT INTO email_forwarding_config (
        team_id, enabled, target_channel_id, coach_channel_id, monitored_addresses, inbound_token,
        imap_enabled, imap_host, imap_port, imap_username, imap_secret_encrypted, imap_use_tls, imap_folder
      )
      VALUES (
        ${input.team_id}::uuid, ${input.enabled}, ${input.target_channel_id}, ${input.coach_channel_id},
        ${input.monitored_addresses}, ${randomBytes(32).toString('base64url')},
        ${input.imap_enabled},
        ${input.imap_host},
        ${input.imap_port},
        ${input.imap_username},
        ${input.imap_secret_encrypted},
        ${input.imap_use_tls},
        COALESCE(${input.imap_folder}, 'INBOX')
      )
      ON CONFLICT (team_id) DO UPDATE SET
        enabled = EXCLUDED.enabled,
        target_channel_id = EXCLUDED.target_channel_id,
        coach_channel_id = EXCLUDED.coach_channel_id,
        monitored_addresses = EXCLUDED.monitored_addresses,
        imap_enabled = EXCLUDED.imap_enabled,
        imap_host = EXCLUDED.imap_host,
        imap_port = EXCLUDED.imap_port,
        imap_username = EXCLUDED.imap_username,
        imap_secret_encrypted = COALESCE(${input.imap_secret_encrypted}, email_forwarding_config.imap_secret_encrypted),
        imap_use_tls = EXCLUDED.imap_use_tls,
        imap_folder = COALESCE(${input.imap_folder}, email_forwarding_config.imap_folder, 'INBOX'),
        updated_at = now()
      RETURNING ${SELECT_COLUMNS}
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
      RETURNING ${SELECT_COLUMNS}
    `,
  });

  const findImapEnabledQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: EmailForwardingConfigRow,
    execute: () => sql`
      SELECT ${SELECT_COLUMNS}
      FROM email_forwarding_config
      WHERE imap_enabled = true AND enabled = true AND imap_secret_encrypted IS NOT NULL
    `,
  });

  const updateImapSyncQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      last_seen_uid: Schema.Int,
      uid_validity: Schema.Int,
      synced_at: Schema.DateTimeUtcFromDate,
    }),
    execute: (input) => sql`
      UPDATE email_forwarding_config
      SET imap_last_seen_uid = ${input.last_seen_uid},
          imap_uid_validity = ${input.uid_validity},
          imap_last_synced_at = ${input.synced_at},
          updated_at = now()
      WHERE team_id = ${input.team_id}::uuid
    `,
  });

  const findByTeam = (teamId: Team.TeamId) => findByTeamQuery(teamId).pipe(catchSqlErrors);

  const upsert = (input: {
    readonly team_id: Team.TeamId;
    readonly enabled: boolean;
    readonly target_channel_id: string;
    readonly coach_channel_id: string;
    readonly monitored_addresses: readonly string[];
    readonly imap_enabled: boolean;
    readonly imap_host: Option.Option<string>;
    readonly imap_port: Option.Option<number>;
    readonly imap_username: Option.Option<string>;
    readonly imap_secret_encrypted: Option.Option<string>;
    readonly imap_use_tls: boolean;
    readonly imap_folder: Option.Option<string>;
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

  const findImapEnabled = () => findImapEnabledQuery(undefined).pipe(catchSqlErrors);

  const updateImapSync = (
    teamId: Team.TeamId,
    lastSeenUid: number,
    uidValidity: number,
    syncedAt: DateTime.Utc,
  ) =>
    updateImapSyncQuery({
      team_id: teamId,
      last_seen_uid: lastSeenUid,
      uid_validity: uidValidity,
      synced_at: syncedAt,
    }).pipe(catchSqlErrors);

  return {
    findByTeam,
    upsert,
    findByInboundToken,
    regenerateToken,
    findImapEnabled,
    updateImapSync,
  } as const;
});

export class EmailForwardingConfigRepository extends ServiceMap.Service<
  EmailForwardingConfigRepository,
  Effect.Success<typeof make>
>()('api/EmailForwardingConfigRepository') {
  static readonly Default = Layer.effect(EmailForwardingConfigRepository, make);
}
