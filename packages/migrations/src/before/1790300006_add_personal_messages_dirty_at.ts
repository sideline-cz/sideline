import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS personal_messages_dirty_at TIMESTAMPTZ`,
    ),
    Effect.tap(
      () =>
        sql`CREATE INDEX IF NOT EXISTS idx_events_personal_messages_dirty_at ON events (personal_messages_dirty_at) WHERE personal_messages_dirty_at IS NOT NULL`,
    ),
  ),
);
