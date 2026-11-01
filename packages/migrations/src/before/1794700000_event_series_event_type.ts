import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// event_series gains the same type pair events has. The trigger REUSES events_sync_event_type():
// it only reads NEW/OLD.event_type, event_type_id, team_id, which exist here under the same names,
// so series and events resolve/authorize a type identically (root AGENTS.md "Event Types").
// NOT NULL DEFAULT 'training': an old server's INSERT omits both columns during blue-green and
// still lands as training (its only kind) with the id resolved by the trigger.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Fail fast instead of blocking boot behind the previous container's event_series queries
    // during the blue-green window (packages/migrations/AGENTS.md, rule 1).
    Effect.tap(() => sql`SET LOCAL lock_timeout = '5s'`),
    // The constant DEFAULT is metadata-only, but the inline CHECK makes PG scan the table under
    // ACCESS EXCLUSIVE. event_series is small and lock_timeout bounds the wait.
    Effect.tap(
      () => sql`
        ALTER TABLE event_series ADD COLUMN IF NOT EXISTS event_type TEXT NOT NULL DEFAULT 'training'
          CHECK (event_type IN ('training','match','tournament','meeting','social','other'))
      `,
    ),
    // ON DELETE SET NULL, same as events.event_type_id (types are archived, never deleted).
    // ponytail: no index on event_type_id; SET NULL only fires on team-cascade deletes of a small
    // table. Add one if a usage-count query ever reads it.
    Effect.tap(
      () => sql`
        ALTER TABLE event_series ADD COLUMN IF NOT EXISTS event_type_id UUID
          REFERENCES event_types(id) ON DELETE SET NULL
      `,
    ),
    // Trigger BEFORE backfill: CREATE TRIGGER's ShareRowExclusiveLock blocks the old server's
    // INSERTs until COMMIT, so no row can slip between the two statements.
    Effect.tap(
      () => sql`
        CREATE OR REPLACE TRIGGER event_series_sync_event_type_trg
          BEFORE INSERT OR UPDATE OF event_type, event_type_id, team_id ON event_series
          FOR EACH ROW WHEN (pg_trigger_depth() = 0)
          EXECUTE FUNCTION events_sync_event_type()
      `,
    ),
    // Backfill THROUGH the trigger: a no-op SET of event_type fires it, and its kind-only branch
    // resolves the id with the exact query one-time training events use (creation order, never
    // position). Guarded on the fact column, so a re-run is a no-op.
    Effect.tap(
      () => sql`UPDATE event_series SET event_type = event_type WHERE event_type_id IS NULL`,
    ),
  ),
);
