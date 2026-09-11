import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * PR 3c — moves every EXISTING all-day `events` row from the pre-PR-3
 * noon-UTC sentinel (`T12:00:00Z`) to the team-local-midnight anchor that PR
 * 3's write path now writes for every new/updated row (plan §12 step 6, §13).
 *
 * Guard: `all_day = TRUE AND NOT all_day_anchored` — a FACT about how the row
 * was last written, never a time-of-day heuristic. A `(start_at AT TIME ZONE
 * 'UTC')::time = TIME '12:00:00'` guard looks equivalent but is wrong for
 * teams at UTC+12 (`Pacific/Auckland` NZST, `Pacific/Fiji`, `Asia/Kamchatka`,
 * `Etc/GMT-12`): a migrated +12 row lands back on exactly `12:00:00Z`, so
 * that guard re-matches its own output and a second run shifts the row
 * another day back. `all_day_anchored` has no such hole and survives a
 * restored snapshot (the flag is part of the dump).
 *
 * `AT TIME ZONE 'UTC'` before `date_trunc('day', …)` reads the UTC calendar
 * date the value was WRITTEN with — the exact inverse of how the web wrote it
 * (`datetime.ts:27-28`) — not the team-local date, which would be wrong for
 * teams at UTC+13/+14 where noon UTC already falls on the next local day.
 *
 * The timezone lookup is a correlated SCALAR subselect, not `UPDATE ... FROM
 * team_settings`. The latter is an INNER join and would silently skip every
 * event belonging to a team with no `team_settings` row, leaving those rows
 * at the sentinel forever with no error (plan §4.4.4, §13.1).
 *
 * `all_day_anchored = TRUE` is set in the SAME statement so the guard and the
 * write can never disagree about a row's state between runs.
 *
 * PR 3 (an earlier, separately-deployed release, per §17 hard rule 2) stamps
 * `all_day_anchored` on every insert/update it performs, so `NOT
 * all_day_anchored` here means exactly "written by pre-PR-3 code, or a timed
 * (non-all-day) row" — the latter is already excluded by `all_day = TRUE`.
 *
 * Reversibility: the Effect migrator is forward-only (no `down`). The exact
 * inverse is documented as an operator runbook step — see this PR's
 * description (plan §13.3) — and is NOT a file in this package. It restores
 * `all_day_anchored = FALSE` in the same statement, for the same idempotency
 * reason, and is only correct for rows whose team's timezone has not changed
 * since this migration ran (plan §13.2).
 *
 * `all_day_anchored` is never dropped, on forward or reverse — it is the
 * only thing that makes this statement safely re-runnable by hand.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        UPDATE events e
        SET start_at = date_trunc('day', e.start_at AT TIME ZONE 'UTC')
                         AT TIME ZONE COALESCE(
                           (SELECT ts.timezone FROM team_settings ts WHERE ts.team_id = e.team_id),
                           'Europe/Prague'),
            end_at   = CASE WHEN e.end_at IS NULL THEN NULL
                            ELSE date_trunc('day', e.end_at AT TIME ZONE 'UTC')
                                   AT TIME ZONE COALESCE(
                                     (SELECT ts.timezone FROM team_settings ts WHERE ts.team_id = e.team_id),
                                     'Europe/Prague') END,
            all_day_anchored = TRUE
        WHERE e.all_day = TRUE
          AND NOT e.all_day_anchored
      `,
    ),
  ),
);
