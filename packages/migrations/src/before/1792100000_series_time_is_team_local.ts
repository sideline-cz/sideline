import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Release N+1 of the two-release `times_are_team_local` split
 * (`.work-plans/series-time-conversion.md`). `1791700000_add_series_times_team_local_flag.ts`
 * (Release N) only added the marker column, defaulted `FALSE`, and converted nothing. THIS
 * migration does the actual conversion, now that every server image capable of being alive
 * during this release's rollout already knows to read the flag
 * (`applications/server/src/utils/seriesTimeDialect.ts`).
 *
 * Two statements. There is deliberately no third — see "Why there is no Statement C" below.
 *
 * ## Statement A — convert `event_series.start_time`/`end_time` to team-local wall clock
 *
 * Every `FALSE` row's `start_time`/`end_time` is a UTC time-of-day (the pre-#650 semantics).
 * This converts it to the team-local wall clock a captain actually typed, and flips the flag
 * `TRUE` in the SAME statement.
 *
 * **Anchor: `es.start_date`, never `CURRENT_DATE`/`now()`.** It is the exact algebraic inverse
 * of how the value was encoded pre-#650: every old web write path built the stored value as
 * `formatUtcTime(localToUtc(values.startDate, values.startTime))`, where `values.startDate` IS
 * the series' `start_date`. Decoding on the same date recovers the wall clock the captain typed
 * (when their browser's zone matched the team's — see the residual note below). `CURRENT_DATE`
 * is wrong for a different reason: the wall clock applies year-round, so anchoring on the
 * deploy date would freeze a permanent answer chosen by an arbitrary timestamp and could take a
 * series that is CURRENTLY correct for its stored season and make it wrong for the other one
 * (verified: Prague `17:00` anchored in January converts to `18:00`, the same value anchored in
 * July converts to `19:00` — they legitimately differ).
 *
 * **`AT TIME ZONE` direction: instant -> local rendering, always total.** On a NAIVE timestamp
 * (`es.start_date + es.start_time`), `AT TIME ZONE 'UTC'` REINTERPRETS it as UTC, producing a
 * `timestamptz` — this is what the old code actually meant by that value. On a `timestamptz`,
 * `AT TIME ZONE <tz>` RENDERS it as a naive local wall clock. Instant -> local rendering is
 * total and single-valued (no DST gap/ambiguity exposure at all) — unlike Statement B below,
 * which goes the other direction (local -> instant) and DOES have to pick a side of an
 * ambiguous/gap hour.
 *
 * **`::time` discards the date on purpose.** A conversion may roll the calendar day (e.g.
 * `Australia/Sydney`, January, `17:00` -> `2026-01-07 04:00` -> stored `04:00:00`); only the
 * time-of-day is stored, there is no column to hold the rolled date.
 *
 * **Guard: `WHERE NOT es.times_are_team_local`, flag flipped in the SAME statement.** Per
 * `packages/migrations/AGENTS.md` -> "Reinterpreting Stored Values: Guard On A Fact Column,
 * Never On The Value" — a value-based guard is impossible here (a UTC+0 team's value is
 * byte-identical before/after, and every clock value is reachable in both dialects for SOME
 * zone), and guard+write must be one statement so a crash between two statements can never leave
 * the value and its marker disagreeing.
 *
 * **No `status` filter.** Cancelled series convert too — the marker must describe every row
 * honestly, because a cancelled series can be reactivated later.
 *
 * ## Statement B — re-anchor already-materialized future occurrences
 *
 * Only rows Statement A JUST converted (`es.id = ANY(convertedIds)`), only future/active/
 * unmodified occurrences.
 *
 * **Dialect-recovery principle (do not "align" this with `team-settings.ts`'s re-anchor, and do
 * not copy that one's date expression here).** The rule is: recover the occurrence date in the
 * dialect the event was MATERIALIZED in, then re-resolve it in the (now-corrected) team zone.
 * This statement only ever sees events that were materialized from a `FALSE` (UTC-dialect)
 * series — `` `${dateStr}T${time}Z` ``, i.e. `seriesSqlZone(...) = 'UTC'` — so their occurrence
 * date is exactly `(e.start_at AT TIME ZONE 'UTC')::date`, with NO DST subtlety (UTC has none).
 * `team-settings.ts`'s re-anchor sees only already-`TRUE` (team-local-dialect) events, so it
 * correctly reads the date in the OLD team zone instead. Using this statement's UTC-date
 * recovery there, or that query's team-zone recovery here, would each resolve the wrong
 * population's date — they are the same principle applied to two disjoint populations, not two
 * expressions that happen to differ.
 *
 * Using the team-zone date recovery here (`(e.start_at AT TIME ZONE <tz>)::date`, as an earlier,
 * withdrawn version of this migration did) is a proven defect, not a style choice: for a
 * near-midnight UTC-dialect series (Prague, `start_date` winter, stored `22:00` -> `23:00` after
 * Statement A) it shifts the event by ~23 HOURS instead of the correct ~1 hour, because the old
 * `start_at`'s team-local date is already the next day relative to its UTC date. And restricting
 * to `convertedIds` (rather than every `TRUE` row) is not optional either: without it, this
 * statement also rewrites events of series that were ALREADY `TRUE` before this migration ran —
 * Postgres's `AT TIME ZONE` and the JS occurrence resolver disagree by one hour on which instant
 * a DST fall-back-ambiguous wall clock means (see "JS and Postgres Disagree On DST-Ambiguous
 * Wall Clocks" in `applications/server/AGENTS.md`), so touching an already-correct row can only
 * ever make it worse.
 *
 * **`personal_messages_dirty_at`: unconditional overwrite, not `CASE WHEN ... IS NULL`.**
 * `PersonalEvents`/`ClearPersonalMessagesDirty` clears the stamp with optimistic concurrency
 * (`... WHERE id = $1 AND personal_messages_dirty_at = $2`). If the reconcile worker had already
 * read the OLD (wrong) stamp and rendered the old time, preserving that stamp would let its
 * stale clear succeed and the corrected time would never re-render. A fresh `now()` stamp makes
 * that clear fail on its optimistic check, forcing a re-render with the corrected time. Matches
 * the precision `EventsRepository` writes via `date_trunc('milliseconds', ...)`.
 *
 * **The unique-index blocker (`idx_events_series_date`).** That index
 * (`1741800000_event_datetime_columns.ts`) is a NON-DEFERRABLE unique index on
 * `(series_id, (start_at AT TIME ZONE 'UTC')::date)`. Statement B rewrites `start_at`, so for a
 * series whose occurrences shift UTC day, Postgres checks the constraint PER ROW mid-`UPDATE`
 * and a row can transiently collide with a sibling row's still-live old value.
 *
 * What decides is the SHIFT DIRECTION, not physical row order. The planner drives Statement B
 * from an index scan on `idx_events_series_date` itself, so rows are visited in ascending
 * `(series_id, date)` order whatever order they were inserted in. Under ascending visiting
 * order a BACKWARD shift is always safe — each row vacates its slot before the row above it
 * claims it — while a FORWARD shift walks each row into the still-live slot of its successor.
 * Positive-offset zones can only shift the UTC date backward; a west-of-UTC zone whose
 * converted clock rolls the date forward is the failing case (test B15, `America/New_York`).
 *
 * Since `MigrateBefore` runs inside server boot, an abort here means the container never starts,
 * for every team, on a forward-only release with no rollback. Bracketing Statement B with
 * `DROP INDEX` / `CREATE UNIQUE INDEX` in the SAME transaction is the fix — not `CONCURRENTLY`
 * (cannot run inside a transaction; the `ACCESS EXCLUSIVE` lock is milliseconds at this scale).
 * The recreate is the actual safety net: a GENUINE final-state duplicate now fails loudly at
 * index-build time and rolls the whole migration transaction back, instead of aborting halfway
 * through a per-row check.
 *
 * **Running Statement B twice.** On a genuine migrator re-run, Statement A's guard makes
 * `converted` empty, so `= ANY('{}'::uuid[])` matches nothing — Statement B, INCLUDING the
 * `personal_messages_dirty_at` stamp, is then a provable no-op.
 *
 * **Residual — the anchor is a best-available inference, not an exact inverse.** The pre-#650
 * web write path encoded with `new Date(y, mo-1, d, h, mi)` — i.e. the EDITING BROWSER's zone,
 * not `team_settings.timezone`. For a captain who edited while travelling, this migration
 * recovers a wall clock off by the offset difference between their browser and the team's zone
 * at that moment. That true encoding offset is recorded nowhere, so `start_date` + team zone is
 * the best available inverse, not a guaranteed-exact one. Forward-only; no migration can do
 * better without more information than the database holds.
 *
 * ## Why there is no Statement C
 *
 * An earlier draft of this migration also flipped `event_series.times_are_team_local`'s column
 * `DEFAULT` to `TRUE`. Cut: with `DEFAULT TRUE`, a `majnet deploy rollback` PAST this release —
 * exactly the operation that reverts the digest but not the data — leaves a server image that
 * omits this column writing UTC-dialect times into rows silently marked `TRUE`, permanently
 * violating "every `FALSE` row is genuinely UTC-semantics" in the direction nothing can detect
 * or repair. No reachable writer needs the default anyway:
 * `EventSeriesRepository.insertEventSeries` is the only writer of `event_series` in the tree and
 * names the column explicitly on every insert.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.bind(
      'converted',
      () => sql<{ readonly id: string }>`
        UPDATE event_series es
        SET start_time = ((es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(
                            (SELECT ts.timezone FROM team_settings ts
                               JOIN pg_timezone_names n ON n.name = ts.timezone
                              WHERE ts.team_id = es.team_id),
                            'Europe/Prague'))::time,
            end_time   = CASE WHEN es.end_time IS NULL THEN NULL
                              ELSE ((es.start_date + es.end_time) AT TIME ZONE 'UTC' AT TIME ZONE COALESCE(
                                     (SELECT ts.timezone FROM team_settings ts
                                        JOIN pg_timezone_names n ON n.name = ts.timezone
                                       WHERE ts.team_id = es.team_id),
                                     'Europe/Prague'))::time
                         END,
            times_are_team_local = TRUE
        WHERE NOT es.times_are_team_local
        RETURNING es.id
      `,
    ),
    // Blocker 1 — see the doc comment. Bracket Statement B with a drop/recreate of the
    // non-deferrable unique index it can transiently collide with mid-statement.
    Effect.tap(() => sql`DROP INDEX idx_events_series_date`),
    Effect.tap(
      ({ converted }) => sql`
        UPDATE events e
        SET start_at = ((e.start_at AT TIME ZONE 'UTC')::date + es.start_time) AT TIME ZONE COALESCE(
                          (SELECT ts.timezone FROM team_settings ts
                             JOIN pg_timezone_names n ON n.name = ts.timezone
                            WHERE ts.team_id = es.team_id),
                          'Europe/Prague'),
            end_at   = CASE WHEN es.end_time IS NULL THEN NULL
                            ELSE ((e.start_at AT TIME ZONE 'UTC')::date + es.end_time) AT TIME ZONE COALESCE(
                                   (SELECT ts.timezone FROM team_settings ts
                                      JOIN pg_timezone_names n ON n.name = ts.timezone
                                     WHERE ts.team_id = es.team_id),
                                   'Europe/Prague')
                       END,
            personal_messages_dirty_at = date_trunc('milliseconds', now())
        FROM event_series es
        WHERE e.series_id = es.id
          AND es.id = ANY(${converted.map((row) => row.id)}::uuid[])
          AND NOT e.series_modified
          AND e.status = 'active'
          AND e.start_at >= now()
      `,
    ),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX idx_events_series_date
          ON events(series_id, ((start_at AT TIME ZONE 'UTC')::date)) WHERE series_id IS NOT NULL
      `,
    ),
    Effect.asVoid,
  ),
);
