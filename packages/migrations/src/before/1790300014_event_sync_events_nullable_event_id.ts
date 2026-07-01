import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// `event_channel_moved` sync events are team-scoped and do not reference a
// specific event, so they cannot satisfy the `event_id` FK to events(id).
// Make the column nullable; team-level events store NULL (the FK permits NULL).
// Reads COALESCE it back to a nil-UUID sentinel so the shared row schema stays
// non-optional.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(() => sql`ALTER TABLE event_sync_events ALTER COLUMN event_id DROP NOT NULL`),
  ),
);
