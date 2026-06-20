import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Partial unique index that allows at most one *unprocessed* `teams_generated`
// sync event per event. This makes the "post pending" guard race-safe: concurrent
// posts can no longer both pass a predicate read and enqueue duplicate rows — the
// loser is absorbed by `ON CONFLICT DO NOTHING`. Once a row is processed
// (`processed_at` set), it leaves the index, so a later re-post is allowed.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) =>
    sql`
    CREATE UNIQUE INDEX event_sync_events_teams_generated_pending_unique
      ON event_sync_events (event_type, event_id)
      WHERE event_type = 'teams_generated' AND processed_at IS NULL
  `,
);
