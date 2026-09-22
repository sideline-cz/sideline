import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * The deferred half of the two-release split started by
 * `1791700000_add_series_times_team_local_flag.ts`. That migration only added
 * `event_series.times_are_team_local` (`DEFAULT FALSE`) and converted nothing, so every server
 * capable of being alive during THIS migration's rollout already knows to read the flag
 * (`applications/server/src/utils/seriesTimeDialect.ts`). This file does the actual conversion:
 * it rewrites `event_series.start_time`/`end_time` from "was treated as UTC" to "is team-local
 * wall clock", then re-anchors the already-materialized future `events` rows that
 * `EventHorizonCron` built from the old, mistaken interpretation.
 *
 * ## Statement A — convert the series times, anchored at the series' own `start_date`
 *
 * `AT TIME ZONE 'UTC'` applied to a NAIVE timestamp REINTERPRETS it as UTC, producing a
 * `timestamptz` (an absolute instant). `AT TIME ZONE <tz>` applied to a `timestamptz` RENDERS
 * that instant as a naive local timestamp in `<tz>`. So `(es.start_date + es.start_time) AT
 * TIME ZONE 'UTC' AT TIME ZONE <tz>` takes "this clock reading, but it was actually UTC" and
 * asks "what does that instant read as in `<tz>`?" — instant → local rendering. This direction
 * is TOTAL and SINGLE-VALUED: there is no DST gap or ambiguity a naive-to-instant conversion can
 * fall into, because the only step going the other way (local → instant) is a plain UTC
 * reinterpretation, never a real zone. Statement A therefore has NO DST exposure at all — only
 * Statement B, which does go local → instant in a real zone, can land in a gap or a repeated
 * hour (see C1/C2 below).
 *
 * `es.start_date` is the anchor, not `CURRENT_DATE` or `now()`. It is the algebraic inverse of
 * how the value was encoded: every pre-fix web write path built the stored value as
 * `formatUtcTime(localToUtc(values.startDate, values.startTime))`, where `values.startDate` IS
 * the series' own `start_date` — so decoding with that same date recovers the wall clock the
 * captain typed, for every series, deterministically. Honest caveat: `localToUtc`
 * (`applications/web/src/lib/datetime.ts`) encodes using `new Date(y, mo-1, d, h, mi)` — the
 * EDITING BROWSER's zone, not necessarily the team's `team_settings.timezone`. For a captain who
 * edited while travelling, this anchor recovers a wall clock off by the offset difference. The
 * true encoding offset is recorded nowhere, so `start_date` + team zone is the best available
 * inverse, not an exact reconstruction. `CURRENT_DATE`/`now()` would be actively wrong: under the
 * new semantics the wall clock applies to every occurrence year-round, so a deploy-date anchor
 * would freeze a permanent answer chosen by an arbitrary timestamp — turning series that are
 * currently correct into series that are wrong, on whichever side of DST the deploy happened to
 * land.
 *
 * ## Guard on a fact column, never on the value
 *
 * `WHERE NOT es.times_are_team_local`, with `times_are_team_local = TRUE` set in the SAME
 * statement (`packages/migrations/AGENTS.md` → "Reinterpreting Stored Values"). A value-based
 * guard is impossible here: a UTC+0 team's stored value is byte-identical before and after
 * conversion, and every clock value is reachable in both dialects for SOME timezone. Guard and
 * write must be one statement — a crash between two separate statements would leave the row's
 * value and its marker disagreeing, with no way to recover which state it was in.
 *
 * ## Correlated scalar subselect + `pg_timezone_names` join, never `UPDATE ... FROM`
 *
 * `UPDATE ... FROM team_settings` is an INNER JOIN: any series whose team has no `team_settings`
 * row would be silently skipped and stay unconverted forever, with nothing to signal it. The
 * correlated `COALESCE((SELECT ...), 'Europe/Prague')` subselect converts those rows using the
 * documented default instead. The `JOIN pg_timezone_names n ON n.name = ts.timezone` is equally
 * load-bearing: `COALESCE` only substitutes for a NULL (missing row) — a non-NULL garbage string
 * (`'Mars/Olympus'`, `''`, differently-cased `'europe/prague'`) flows straight into `AT TIME
 * ZONE` and raises `time zone "..." not recognized` (SQLSTATE 22023, not a check violation).
 * `MigrateBefore` runs inside server boot, so one bad row anywhere in `team_settings` would take
 * down every team's container, not just its own. The join makes an unrecognised value return no
 * row, so `COALESCE` falls back to `'Europe/Prague'` — the same default `resolveOccurrenceInstant`
 * uses. Matching is CASE-SENSITIVE `=`, never `ILIKE`: a wrong-but-similar value (lowercase zone)
 * must fall back to the documented default, not be silently normalised into a possibly-wrong zone.
 *
 * ## Statement B — re-anchor already-materialized future occurrences, restricted to Statement
 * A's `RETURNING` ids
 *
 * `EventHorizonCron` already materialized `events` rows from the old, mistaken UTC
 * interpretation. Without Statement B, every future occurrence already in `events` keeps its old,
 * wrong instant until the series naturally regenerates past it (which may never happen for a
 * `start_date`-bounded series).
 *
 * Dialect-recovery principle (this is the crux of why Statement B is NOT a copy of
 * `applications/server/src/api/team-settings.ts`'s re-anchor statements, and vice versa): recover
 * the occurrence date in the dialect the event was materialized in. Statement B, by construction,
 * only ever sees UTC-dialect events (rows whose series was just flipped from `FALSE`), which were
 * built as `` `${dateStr}T${time}Z` `` — so their occurrence date is exactly
 * `(e.start_at AT TIME ZONE 'UTC')::date`, no DST subtlety, because UTC has none.
 * `team-settings.ts` sees only already-team-local events (its own guard is `es.times_are_team_local`)
 * built as `(dateStr + time) @ tz`, so it correctly recovers the date as
 * `(e.start_at AT TIME ZONE tz)::date`. These are the same rule applied to two disjoint
 * populations, not the same expression — DO NOT copy `team-settings.ts`'s date expression here,
 * and do NOT copy this migration's `AT TIME ZONE 'UTC'` date expression there.
 *
 * A withdrawn, earlier draft of this migration (previously `1791600000`, recovered from git
 * history) used the team-local date for ALL series events instead of restricting to just-converted
 * ones. That is wrong for two reachable row classes, which is why Statement B here is instead
 * scoped to `es.id = ANY(${convertedIds}::uuid[])`:
 *
 *   1. A near-midnight series can jump almost a full day. A team-local occurrence date computed
 *      from an instant that was actually UTC-dialect can land on the WRONG calendar day (an
 *      instant just after midnight UTC is often still "yesterday" team-local, or vice versa), so
 *      recombining with the corrected time re-anchors on the wrong date entirely — off by close to
 *      24 hours, not the intended ~1-2 hour DST correction.
 *   2. Events of a series that was ALREADY `TRUE` (created since the client started sending
 *      `timesAreTeamLocal: true`) get needlessly rewritten. Those events were materialized by the
 *      JS resolver, which disambiguates a repeated DST hour with `"compatible"` (picks the
 *      EARLIER instant); Postgres's plain `AT TIME ZONE` picks the LATER instant for the same wall
 *      clock. Re-running the recombination on an already-correct row can therefore shift it an
 *      hour for no reason. Restricting to `converted` ids (rows Statement A just flipped
 *      `FALSE` -> `TRUE`) excludes both defects: an already-`TRUE` series never appears in
 *      `converted`, so its events are never touched.
 *
 * `= ANY(${convertedIds}::uuid[])` with an EMPTY array is `false` for every row — no length guard
 * needed (same binding shape as `BankTransactionMatcher.ts`/`BankSyncPoller.ts`).
 *
 * Guards: `e.series_id = es.id` (only series-generated events have a series time to re-anchor
 * to), `NOT e.series_modified` (never clobber a captain's per-occurrence override — the same
 * guard `EventsRepository.updateFutureUnmodified` uses), `e.status = 'active'` (leave
 * cancelled/started events alone), `e.start_at >= now()` (forward-looking correction only, never
 * rewrite history).
 *
 * `end_at`'s `CASE` anchors on `(e.start_at AT TIME ZONE 'UTC')::date` — the SAME date as
 * `start_at`, not `e.end_at`'s own date. This deliberately reproduces what `EventHorizonCron`
 * regenerates: it resolves `end_at` on the same `dateStr` it used for `start_at`, so a series
 * whose `end_time` crosses midnight relative to `start_time` materializes `end_at < start_at` —
 * a pre-existing modelling quirk this migration must reproduce exactly, not "fix", or the
 * corrected row would permanently disagree with what the cron regenerates the next time it runs
 * past this occurrence. The `CASE WHEN es.end_time IS NULL` branch is documentation, not
 * protection — `date + NULL` is NULL regardless — what it guarantees is that a NULL `end_time`
 * never gets `COALESCE`d to a literal. When `es.end_time` is non-NULL and the event's `end_at`
 * was NULL, Statement B fills it in — matching `EventsRepository.updateFutureUnmodified`.
 *
 * `personal_messages_dirty_at = date_trunc('milliseconds', now())` is an UNCONDITIONAL overwrite,
 * not the `CASE WHEN ... IS NULL` form `team-settings.ts` uses. Reason:
 * `PersonalEvents`/`ClearPersonalMessagesDirty` clears the flag with optimistic concurrency
 * (`WHERE id = $1 AND personal_messages_dirty_at = $2`, see `EventsRepository.ts` around line
 * 1081). If a reconcile worker had already read the OLD stamp and rendered the OLD (wrong) time,
 * preserving that stamp would let its clear succeed and the corrected time would never re-render.
 * Writing a fresh timestamp here makes that stale clear fail its optimistic check, forcing a
 * re-render with the corrected time. `date_trunc('milliseconds', ...)` matches the precision
 * `EventsRepository` itself writes, so the optimistic compare still works.
 *
 * ## The unique index must be dropped and recreated around Statement B
 *
 * `idx_events_series_date` (`1741800000_event_datetime_columns.ts`) is a non-deferrable UNIQUE
 * index on `(series_id, (start_at AT TIME ZONE 'UTC')::date)`. Statement B rewrites `start_at`,
 * so for any series whose occurrences cross a UTC day boundary under the correction, the indexed
 * value changes mid-statement. Because the index is non-deferrable, Postgres checks it per row,
 * and row 1 can land on row 2's still-live (not yet updated) date — this fails with "duplicate
 * key value violates unique constraint" even when the FINAL state has no duplicate at all, purely
 * as a function of heap/scan order. `MigrateBefore` runs inside server boot, so this is a
 * production boot failure, not a caught error. Dropping the index before Statement B and
 * recreating it after is what preserves safety rather than removing it: a GENUINE final-state
 * duplicate now fails loudly at index-build time, rolling back the whole transaction, instead of
 * aborting silently partway through a per-row check. Not `CREATE INDEX CONCURRENTLY` — that
 * cannot run inside a transaction, and at this migration's expected scale (order of hundreds of
 * series, low thousands of events) the brief `ACCESS EXCLUSIVE` lock is milliseconds.
 *
 * ## Statement C — deliberately DROPPED
 *
 * An earlier draft also flipped `ALTER COLUMN times_are_team_local SET DEFAULT TRUE`. Cut,
 * decisively, because it is an unrecoverable rollback hazard: `majnet deploy rollback` reverts
 * the digest but NOT the data, so a server image older than this release — one that has never
 * heard of `times_are_team_local` and always writes UTC-dialect times — would, under `DEFAULT
 * TRUE`, insert new rows that are silently mismarked `TRUE` while actually holding UTC times.
 * That permanently violates the invariant "every `FALSE` row is genuinely UTC-semantics" in the
 * one direction no later migration can detect or repair. (Secondary reasons: no reachable writer
 * in the tree relies on the column default — `EventSeriesRepository.insertEventSeries` always
 * names the column explicitly — and flipping the DB default would disagree with the API's own
 * decoding default of `false`.) Do not re-add this statement.
 *
 * ## Re-running this migration
 *
 * The entire pending-migration set runs inside one `sql.withTransaction`, so there is no
 * half-converted state reachable via the ordinary migrator — an interruption rolls back both
 * statements together. A genuine re-run (e.g. by hand) matches zero rows in Statement A (`WHERE
 * NOT es.times_are_team_local` is now false everywhere it touched), so `converted` is empty,
 * `= ANY('{}')` matches nothing in Statement B, and the whole file is a PROVABLE no-op — including
 * `personal_messages_dirty_at`, which is NOT re-stamped on a no-op run.
 *
 * Sharp edge: an OPERATOR running these statements by hand in `psql` with autocommit (rather than
 * through the migrator's single transaction) can commit Statement A without Statement B. A naive
 * re-run afterwards recomputes `converted` as EMPTY (every row Statement A would have returned is
 * now already `TRUE`), so the events are NOT re-anchored by that re-run. Recovery is to run
 * Statement B by hand with an explicit list of the series ids that were converted, or to simply
 * wait for `EventHorizonCron` to regenerate those occurrences naturally (within
 * `event_horizon_days`, default 14 days).
 *
 * ## Known, accepted residuals (do not "fix" either side alone)
 *
 * - Fall-back ambiguity (one occurrence per zone per year): a converted wall clock landing in a
 *   repeated DST hour is migrated to the LATER instant (Postgres's `AT TIME ZONE`), while
 *   `resolveOccurrenceInstant`'s `"compatible"` disambiguation would regenerate the EARLIER
 *   instant. The two disagree by exactly one hour for that single occurrence; it self-heals the
 *   next time the series is edited or the occurrence regenerates. `resolveOccurrenceInstant`,
 *   `EventsRepository.updateFutureUnmodified` and this migration must always move together on
 *   this point — do not patch one side's disambiguation without the others.
 * - An occurrence less than the conversion delta away from `now()` can be moved into the PAST.
 *   Statement B's `e.start_at >= now()` filter tests the OLD value, so an occurrence an hour or
 *   two out that shifts backwards lands behind `now()`. `EventStartCron` then flips it to
 *   `started` immediately, and `EventsRepository.updateFutureUnmodified` — which carries the same
 *   `start_at >= now()` guard — can never correct it again. The window is tiny (bounded by the
 *   team's UTC offset) and it is inherent to correcting a time at all, but it is not zero.
 * - Events-channel embeds are not re-rendered: Statement B stamps `personal_messages_dirty_at`
 *   but writes no `event_sync_events` row. Neither the series-edit path in `api/event-series.ts`
 *   nor the re-anchor in `api/team-settings.ts` emits one either, so this is consistent with
 *   existing behaviour rather than a regression — but this migration is the first BULK
 *   application of it, so the gap is more visible here than it has ever been.
 * - Forward-only: the Effect migrator has no `down`. The only rollback aid is an operator-created
 *   audit snapshot table taken immediately before deploying this migration (see the operational
 *   runbook); Statement A's own inverse (restore `times_are_team_local = FALSE` and re-apply the
 *   opposite `AT TIME ZONE` conversion) is only correct for a team whose timezone has not changed
 *   since this migration ran.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    // Statement A — convert the series times themselves, anchored at each series' own
    // `start_date`, and mark the row `TRUE` in the same statement as the guard that gates it.
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
                                      'Europe/Prague'))::time END,
            times_are_team_local = TRUE
        WHERE NOT es.times_are_team_local
        RETURNING es.id
      `,
    ),
    // `idx_events_series_date` is non-deferrable and Statement B can change the indexed value
    // mid-statement (see the doc comment above) — drop it before B and recreate it after so a
    // genuine final-state duplicate still fails loudly instead of aborting mid-scan.
    //
    // `lock_timeout` first: this is the first ACCESS EXCLUSIVE lock this migration takes on
    // `events`, and it is held until the whole pending-migration set commits. `MigrateBefore`
    // runs inside boot, during a blue-green window in which the PREVIOUS container is still
    // serving and querying `events` — so without a timeout, one long-running query over there
    // makes this boot hang indefinitely AND queues every subsequent `events` query behind our
    // pending lock. Failing fast and diagnosably is strictly better. Same idiom and reasoning as
    // `applications/server/src/api/group.ts`'s `SET LOCAL lock_timeout`; `SET LOCAL` is correct
    // here because the migrator wraps the whole set in one transaction.
    Effect.tap(() => sql`SET LOCAL lock_timeout = '5s'`),
    // `IF EXISTS` matches how `1741800000_event_datetime_columns.ts` itself drops this index.
    // The unconditional `CREATE UNIQUE INDEX` below converges the schema either way, so the
    // stricter form would buy nothing and would turn a merely-absent index into a boot failure.
    Effect.tap(() => sql`DROP INDEX IF EXISTS idx_events_series_date`),
    // Statement B — re-anchor already-materialized future, active, not-hand-edited occurrences
    // of ONLY the series Statement A just converted (see the dialect-recovery principle above
    // for why this restriction, and the UTC-dialect date expression, are both load-bearing).
    Effect.tap(({ converted }) => {
      const convertedIds = converted.map((row) => row.id);
      return sql`
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
                                    'Europe/Prague') END,
            personal_messages_dirty_at = date_trunc('milliseconds', now())
        FROM event_series es
        WHERE e.series_id = es.id
          AND es.id = ANY(${convertedIds}::uuid[])
          AND NOT e.series_modified
          AND e.status = 'active'
          AND e.start_at >= now()
      `;
    }),
    Effect.tap(
      () => sql`
        CREATE UNIQUE INDEX idx_events_series_date
          ON events(series_id, ((start_at AT TIME ZONE 'UTC')::date)) WHERE series_id IS NOT NULL
      `,
    ),
    Effect.asVoid,
  ),
);
