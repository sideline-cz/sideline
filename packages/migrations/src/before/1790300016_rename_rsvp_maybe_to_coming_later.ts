import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Widens the CHECK constraint to permissively allow both the legacy `'maybe'`
// literal and the new `'coming_later'` literal. Historical `'maybe'` rows are
// intentionally left untouched here — the codebase already tolerates `'maybe'`
// everywhere this release, so eagerly rewriting every historical row would
// needlessly widen the rolling-deploy risk window (an old still-running
// instance's legacy decode would be exposed to every historical row, not just
// newly-written ones) for no functional benefit. Converting historical rows is
// deferred to the Release B follow-up, which will also drop `'maybe'` from the
// CHECK/union once no client relies on it anymore.
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`ALTER TABLE event_rsvps DROP CONSTRAINT IF EXISTS event_rsvps_response_check`,
    ),
    Effect.tap(
      () => sql`
        ALTER TABLE event_rsvps
        ADD CONSTRAINT event_rsvps_response_check
        CHECK (response IN ('yes', 'no', 'maybe', 'coming_later'))
      `,
    ),
  ),
);
