import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // The new `assigned` PaymentReminderKind (D15b) fires once at assignment creation and
    // needs no DDL (`payment_reminders_sent`/`payment_reminder_sync_events` are already generic
    // over `kind`) — but every pre-existing fee_assignments row would otherwise become an
    // unsent `assigned` candidate on first deploy and blast the whole club with a backlog of
    // "new fee" DMs. Seed the idempotency marker for every row that already exists.
    Effect.tap(
      () => sql`
        INSERT INTO payment_reminders_sent (assignment_id, kind)
        SELECT fa.id, 'assigned' FROM fee_assignments fa
        ON CONFLICT (assignment_id, kind) DO NOTHING
      `,
    ),
    // The `assigned` branch is not due-date-gated (a fee with no due date is exactly the case
    // where an early QR helps most), so the outbox's effective_due_at column can no longer be
    // NOT NULL.
    Effect.tap(
      () =>
        sql`ALTER TABLE payment_reminder_sync_events ALTER COLUMN effective_due_at DROP NOT NULL`,
    ),
  ),
);
