import { Discord, Fee, FeeAssignment, PaymentReminder, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schema for unprocessed sync events
// ---------------------------------------------------------------------------

class PaymentReminderSyncEventRow extends Schema.Class<PaymentReminderSyncEventRow>(
  'PaymentReminderSyncEventRow',
)({
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  assignment_id: FeeAssignment.FeeAssignmentId,
  kind: PaymentReminder.PaymentReminderKind,
  effective_due_at: Schema.Date,
  fee_name: Schema.String,
  currency: Fee.CurrencyCode,
  amount_minor: Fee.AmountMinor,
  paid_minor: Fee.AmountMinor,
  user_discord_id: Discord.Snowflake,
  created_at: Schema.Date,
  processed_at: Schema.OptionFromNullOr(Schema.Date),
  error: Schema.OptionFromNullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _findUnprocessed = SqlSchema.findAll({
    Request: Schema.Number,
    Result: PaymentReminderSyncEventRow,
    execute: (limit) => sql`
      SELECT id, team_id, guild_id, assignment_id, kind, effective_due_at,
             fee_name, currency, amount_minor, paid_minor, user_discord_id,
             created_at, processed_at, error
      FROM payment_reminder_sync_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  // The `AND processed_at IS NULL` guard makes these updates idempotent —
  // duplicate processed/failed acks from retried bot polls become no-ops
  // rather than rewriting the processed_at timestamp.
  const _markProcessed = SqlSchema.void({
    Request: Schema.String,
    execute: (id) => sql`
      UPDATE payment_reminder_sync_events
      SET processed_at = now(), error = NULL
      WHERE id = ${id}
        AND processed_at IS NULL
    `,
  });

  const _markFailed = SqlSchema.void({
    Request: Schema.Struct({ id: Schema.String, error: Schema.String }),
    execute: (input) => sql`
      UPDATE payment_reminder_sync_events
      SET processed_at = now(), error = ${input.error}
      WHERE id = ${input.id}
        AND processed_at IS NULL
    `,
  });

  const _emitInsert = SqlSchema.findAll({
    Request: Schema.Struct({
      assignmentId: FeeAssignment.FeeAssignmentId,
      guildId: Discord.Snowflake,
      kind: PaymentReminder.PaymentReminderKind,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: ({ assignmentId, guildId, kind }) => sql`
      INSERT INTO payment_reminder_sync_events
        (team_id, guild_id, assignment_id, kind, effective_due_at, fee_name, currency,
         amount_minor, paid_minor, user_discord_id)
      SELECT
        tm.team_id,
        ${guildId},
        fa.id,
        ${kind},
        COALESCE(fa.due_at, f.due_at),
        f.name,
        f.currency,
        fa.amount_minor,
        fa.paid_minor,
        u.discord_id
      FROM fee_assignments fa
      JOIN fees f ON f.id = fa.fee_id
      JOIN team_members tm ON tm.id = fa.team_member_id
      JOIN users u ON u.id = tm.user_id
      WHERE fa.id = ${assignmentId}
      ON CONFLICT DO NOTHING
      RETURNING id
    `,
  });

  // Returns Option.some(id) when a new row was inserted, or Option.none() when a
  // pending sync for the same (assignment_id, kind) already exists (conflict skipped).
  const emit = (
    assignmentId: FeeAssignment.FeeAssignmentId,
    guildId: Discord.Snowflake,
    kind: PaymentReminder.PaymentReminderKind,
  ) =>
    _emitInsert({ assignmentId, guildId, kind }).pipe(
      catchSqlErrors,
      Effect.map((rows) => Option.fromNullishOr(rows[0]?.id)),
    );

  const findUnprocessed = (limit: number) => _findUnprocessed(limit).pipe(catchSqlErrors);

  const markProcessed = (id: string) => _markProcessed(id).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) => _markFailed({ id, error }).pipe(catchSqlErrors);

  return {
    emit,
    findUnprocessed,
    markProcessed,
    markFailed,
  };
});

export class PaymentReminderSyncEventsRepository extends ServiceMap.Service<
  PaymentReminderSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/PaymentReminderSyncEventsRepository') {
  static readonly Default = Layer.effect(PaymentReminderSyncEventsRepository, make);
}
