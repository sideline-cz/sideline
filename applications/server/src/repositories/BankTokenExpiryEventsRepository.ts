/**
 * [R4 — blocker 6] Its own outbox table (`bank_token_expiry_events`, migration `1792000004`),
 * modelled on `PaymentReminderSyncEventsRepository`: `payment_reminder_sync_events` cannot be
 * reused — it is FK'd to `fee_assignments` with several NOT NULL columns this event has no
 * equivalent for.
 *
 * `emit` is called by `BankTokenExpiryCron` (T10b) once per `(team, threshold)` candidate found
 * by `BankSyncConfigRepository.findExpiringCandidates`. It is idempotent via the table's own
 * partial unique index (`uq_bank_token_expiry_events_pending`, scoped to `processed_at IS NULL`)
 * — `ON CONFLICT DO NOTHING` makes a re-run of the same cycle free.
 */
import { Discord, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class BankTokenExpiryEventRow extends Schema.Class<BankTokenExpiryEventRow>(
  'BankTokenExpiryEventRow',
)({
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  user_discord_id: Discord.Snowflake,
  threshold_days: Schema.Int,
  token_expires_at: Schema.Date,
  created_at: Schema.Date,
  processed_at: Schema.OptionFromNullOr(Schema.Date),
  error: Schema.OptionFromNullOr(Schema.String),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _findUnprocessed = SqlSchema.findAll({
    Request: Schema.Number,
    Result: BankTokenExpiryEventRow,
    execute: (limit) => sql`
      SELECT id, team_id, guild_id, user_discord_id, threshold_days, token_expires_at,
             created_at, processed_at, error
      FROM bank_token_expiry_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  const _markProcessed = SqlSchema.void({
    Request: Schema.String,
    execute: (id) => sql`
      UPDATE bank_token_expiry_events
      SET processed_at = now(), error = NULL
      WHERE id = ${id} AND processed_at IS NULL
    `,
  });

  const _markFailed = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String, error: Schema.String }),
    execute: (input) => sql`
      UPDATE bank_token_expiry_events
      SET processed_at = now(), error = ${input.error}
      WHERE id = ${input.id} AND processed_at IS NULL
    `,
  });

  // Idempotent insert — `ON CONFLICT DO NOTHING` targets the partial unique index on
  // (team_id, threshold_days) WHERE processed_at IS NULL, so a re-run of the same cron cycle (or
  // an overlapping one) never produces a second pending row for the same team/threshold.
  const _emitInsert = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      guild_id: Discord.Snowflake,
      user_discord_id: Discord.Snowflake,
      threshold_days: Schema.Int,
      token_expires_at: Schema.Date,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      INSERT INTO bank_token_expiry_events
        (team_id, guild_id, user_discord_id, threshold_days, token_expires_at)
      VALUES (
        ${input.team_id}, ${input.guild_id}, ${input.user_discord_id}, ${input.threshold_days},
        ${input.token_expires_at}
      )
      ON CONFLICT (team_id, threshold_days) WHERE processed_at IS NULL DO NOTHING
      RETURNING id
    `,
  });

  // Written by `BankTokenExpiryCron` itself, right after a successful `emit` — unlike the
  // payment reminder family, the bot has no bot-side "sent" ack for this event (the header on
  // `handleBankTokenExpiring.ts` explains why: the outbox row IS the idempotency boundary for
  // Discord delivery). `bank_token_expiry_sent` is a SEPARATE, longer-lived dedupe boundary that
  // survives the outbox row being processed, so the cron never re-emits the same threshold for
  // the same token generation. Keyed on token_created_at so a replacement token re-arms all three
  // thresholds without a manual reset.
  const _markSent = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      token_created_at: Schema.String,
      threshold_days: Schema.Int,
    }),
    execute: (input) => sql`
      INSERT INTO bank_token_expiry_sent (team_id, token_created_at, threshold_days)
      VALUES (${input.team_id}, ${input.token_created_at}::timestamptz, ${input.threshold_days})
      ON CONFLICT (team_id, token_created_at, threshold_days) DO NOTHING
    `,
  });

  const findUnprocessed = (limit: number) => _findUnprocessed(limit).pipe(catchSqlErrors);

  const markProcessed = (id: string) => _markProcessed(id).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) => _markFailed({ id, error }).pipe(catchSqlErrors);

  // Returns Option.some(id) when a new row was inserted, or Option.none() when a pending event
  // for the same (team_id, threshold_days) already exists (conflict skipped).
  const emit = (input: {
    readonly teamId: Team.TeamId;
    readonly guildId: Discord.Snowflake;
    readonly userDiscordId: Discord.Snowflake;
    readonly thresholdDays: number;
    readonly tokenExpiresAt: Date;
  }) =>
    _emitInsert({
      team_id: input.teamId,
      guild_id: input.guildId,
      user_discord_id: input.userDiscordId,
      threshold_days: input.thresholdDays,
      token_expires_at: input.tokenExpiresAt,
    }).pipe(
      catchSqlErrors,
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)),
    );

  const markSent = (teamId: Team.TeamId, tokenCreatedAt: string, thresholdDays: number) =>
    _markSent({
      team_id: teamId,
      token_created_at: tokenCreatedAt,
      threshold_days: thresholdDays,
    }).pipe(catchSqlErrors);

  return {
    findUnprocessed,
    markProcessed,
    markFailed,
    emit,
    markSent,
  };
});

export class BankTokenExpiryEventsRepository extends ServiceMap.Service<
  BankTokenExpiryEventsRepository,
  Effect.Success<typeof make>
>()('api/BankTokenExpiryEventsRepository') {
  static readonly Default = Layer.effect(BankTokenExpiryEventsRepository, make);
}
