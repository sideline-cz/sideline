import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_reminder_sync_events_pending
          ON payment_reminder_sync_events (assignment_id, kind)
          WHERE processed_at IS NULL
      `,
    ),
  ),
);
