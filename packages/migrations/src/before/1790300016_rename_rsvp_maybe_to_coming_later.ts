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
//
// UPDATE (2026-09-22, feat/adjust-later-option): NEITHER follow-up is happening.
// Do not act on the paragraph above.
//  - The conversion was investigated and abandoned. It rested on the assumption
//    that historical `'maybe'` rows meant "coming later"; they did not. Before
//    #549 (`5ec1fcba`) the button was literally labelled `❓ Maybe` / `❓ Možná`
//    (`git show 5ec1fcba^:packages/i18n/messages/en.json`), so those rows already
//    mean "Nevím". Converting them would have rewritten real user answers to the
//    opposite meaning, irreversibly, and minted `coming_later` rows with
//    `message IS NULL` against that response's mandatory-note invariant.
//  - `'maybe'` must NOT be dropped from the CHECK. It is a first-class,
//    actively-written response again ("Nevím" — selectable and non-attending),
//    so tightening the constraint would reject every new write.
// The permissive constraint this migration installs is the final state.
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
