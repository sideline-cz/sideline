import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) =>
    sql`ALTER TABLE event_sync_events ADD COLUMN IF NOT EXISTS event_all_day BOOLEAN NOT NULL DEFAULT false`,
);
