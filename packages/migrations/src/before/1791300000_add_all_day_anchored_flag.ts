import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * `events.all_day_anchored` asserts "this row's `start_at`/`end_at` obey the
 * all-day storage anchor (00:00 in the team's timezone)" — a fact about how
 * the row was written, not an inference from its time-of-day. It defaults to
 * `FALSE` so every pre-existing row (a noon-UTC sentinel, or simply a timed
 * event) is correctly "not yet migrated"/"not applicable".
 *
 * The write path (`applications/server/src/api/event.ts`) stamps this flag on
 * every insert/update from the moment this migration ships — see
 * `EventsRepository.ts`'s `insert`/`update` statements. A later migration
 * (`1791400000`, a placeholder id — re-pick at merge time) moves every
 * existing `all_day = TRUE AND NOT all_day_anchored` row to the team-local
 * midnight anchor and sets the flag. This column MUST ship ahead of that data
 * migration and ahead of the write-path fix, because the write path stamps a
 * column that must already exist.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE events
          ADD COLUMN IF NOT EXISTS all_day_anchored BOOLEAN NOT NULL DEFAULT FALSE
      `,
    ),
  ),
);
