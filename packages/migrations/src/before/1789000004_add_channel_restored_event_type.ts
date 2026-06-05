import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () =>
        sql`ALTER TABLE channel_sync_events DROP CONSTRAINT IF EXISTS channel_sync_events_event_type_check`,
    ),
    Effect.tap(
      () =>
        sql`ALTER TABLE channel_sync_events ADD CONSTRAINT channel_sync_events_event_type_check CHECK (event_type IN ('channel_created', 'channel_deleted', 'channel_archived', 'channel_restored', 'channel_detached', 'channel_updated', 'member_added', 'member_removed'))`,
    ),
  ),
);
