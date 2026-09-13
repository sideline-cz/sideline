import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

/**
 * Fixes the DST bug at its root: `event_series.start_time`/`end_time` were
 * being treated as a UTC time-of-day (`EventHorizonCron.ts` used to build
 * `` `${dateStr}T${s.start_time}Z` ``), but they are WALL-CLOCK values a
 * captain typed into a form — "Tuesday 18:00" — and no single UTC
 * time-of-day equals 18:00 local for every week of the year. A series
 * created in winter (stored `17:00`) materialized summer occurrences at
 * `17:00Z`, an hour late in the team's own calendar, Discord and iCal.
 *
 * New invariant, matching `rules_quiz_time`/`rsvp_reminder_time` exactly
 * rather than inventing a second convention (see
 * `1790500000_rules_quiz_schedule.ts`): `start_time`/`end_time` are `HH:MM[:SS]`
 * wall-clock in the team's OWN `team_settings.timezone`, resolved to an
 * instant per occurrence, never UTC.
 *
 * ## Idempotency guard is a FACT, not a heuristic
 *
 * Converting a TIME from "was-treated-as-UTC" to "is-team-local" and then
 * re-running the conversion would shift it a second time. A value-based
 * guard cannot detect "already converted" — a UTC+0 team's value is
 * unchanged either way, and any given clock value is reachable both before
 * and after conversion for *some* timezone. So, exactly like
 * `all_day_anchored` (`1791300000_add_all_day_anchored_flag.ts`,
 * `1791400000_anchor_all_day_to_team_midnight.ts`), this migration adds a
 * `times_are_team_local BOOLEAN NOT NULL DEFAULT FALSE` column to
 * `event_series`, guards the UPDATE on `NOT times_are_team_local`, and sets
 * it `TRUE` in the SAME statement so the guard and the write can never
 * disagree about a row's state between runs. It is never dropped — it is the
 * only thing that makes Statement A safely re-runnable by hand.
 *
 * ## Correlated scalar subselect, not `UPDATE ... FROM team_settings`
 *
 * The timezone lookup is `COALESCE((SELECT ts.timezone FROM team_settings ts
 * JOIN pg_timezone_names n ON n.name = ts.timezone WHERE ts.team_id =
 * es.team_id), 'Europe/Prague')` — a correlated SCALAR subselect.
 * `UPDATE ... FROM team_settings` is an INNER JOIN and would silently skip
 * every series (or event) belonging to a team with no `team_settings` row,
 * leaving those rows unconverted forever with no error.
 *
 * ## An invalid `timezone` value must not abort server boot
 *
 * `MigrateBefore` runs inside the server process at startup: if any single
 * `team_settings.timezone` is a string Postgres does not recognise as a
 * zone, a bare `AT TIME ZONE ts.timezone` raises (`ERROR: time zone
 * "Mars/Olympus" not recognized`), the migration transaction fails, and the
 * container never starts — one bad row anywhere in the table takes down
 * every team, not just its own. `COALESCE` alone only substitutes when the
 * subselect returns NULL (missing row); it does nothing for a non-NULL
 * garbage string. So every lookup additionally joins `pg_timezone_names`,
 * Postgres's own catalog of zone names it will accept: a `ts.timezone` that
 * is not in that catalog fails the join, the subselect again returns no row,
 * and `COALESCE` falls back to `'Europe/Prague'` — exactly the same
 * defence `resolveOccurrenceInstant` (`applications/server/src/utils/
 * seriesOccurrence.ts`) already applies in the TS resolver, so SQL and the
 * application code agree on invalid-zone behaviour instead of one throwing
 * and the other silently coping.
 *
 * `pg_timezone_names.name` matching is CASE-SENSITIVE (verified: `name =
 * 'europe/prague'` returns zero rows, `name = 'Europe/Prague'` returns one).
 * `team_settings.timezone` is only ever written by the app in canonical IANA
 * casing (`Europe/Prague`, `America/New_York`, ...), so this is not expected
 * to reject a legitimate value in practice — but a hand-edited or
 * differently-cased row would fail the join and fall back to
 * `'Europe/Prague'` rather than erroring, same as any other unrecognised
 * value. If lowercase/mixed-case zone strings ever need to be accepted, use
 * `n.name ILIKE ts.timezone` instead of `=` — not applied here because it
 * would silently normalise a genuinely wrong-but-differently-cased value
 * instead of falling back to the documented default.
 *
 * ## Statement A: convert the series times, anchored at the series' `start_date`
 *
 * `AT TIME ZONE 'UTC'` applied to a naive timestamp REINTERPRETS it as UTC,
 * producing a `timestamptz` (an absolute instant). `AT TIME ZONE <tz>`
 * applied to a `timestamptz` RENDERS that instant as a naive local timestamp
 * in `<tz>`. So `(es.start_date + es.start_time) AT TIME ZONE 'UTC' AT TIME
 * ZONE tz` takes "this clock reading, but it was actually UTC" and asks "what
 * does that instant read as in `tz`?" — exactly the correction this bug
 * needs. Sanity check: a series with `start_date` in winter storing `17:00`
 * for a Prague team (winter is UTC+1, i.e. CET) becomes `17:00 UTC` =
 * `18:00 CET`, so the column becomes `18:00` — the wall-clock time the
 * captain actually typed.
 *
 * ## Why `es.start_date` is the anchor
 *
 * It is the exact algebraic inverse of how the value was encoded. Every web
 * write path built the stored value as
 * `formatUtcTime(localToUtc(values.startDate, values.startTime))`, where
 * `values.startDate` is the series' own `start_date` — so decoding with that
 * same date recovers precisely the wall clock the captain typed, for every
 * series, deterministically.
 *
 * `CURRENT_DATE` was tried first and is WRONG. Under the new semantics the
 * wall clock applies to EVERY occurrence year-round, so the anchor is not a
 * "which half of the year do we favour" choice — a wrong anchor is wrong all
 * year. Anchoring on the deploy date would give a different permanent answer
 * depending on which DST side the migration happened to run on: a series
 * typed as 18:00 last winter, deployed in summer, would be frozen at 19:00
 * forever — taking occurrences that were CORRECT before this migration and
 * making them wrong, which is strictly worse than the bug being fixed. It
 * would also make the outcome a function of an arbitrary deploy timestamp,
 * which no one can reason about per-series after the fact.
 *
 * The visible consequence of using `start_date` is deliberate: for a series
 * currently displaying the drifted time, upcoming occurrences move back to
 * the time the captain actually asked for. That is the bug fix, not a
 * regression — but it does mean some teams' next training shifts by an hour,
 * so it belongs in the release notes.
 *
 * ## Statement B: re-anchor already-materialized future events
 *
 * `EventHorizonCron` already materialized `events` rows from the (until now)
 * mistaken UTC interpretation. Statement A only fixes `event_series`; without
 * Statement B every future occurrence already in `events` would keep its old,
 * wrong instant until the series naturally regenerates past it (which may
 * never happen for `start_date`-bounded series). So Statement B recomputes
 * `start_at`/`end_at` for future, active, NOT-hand-edited occurrences from the
 * now-team-local series time: take the event's current team-local calendar
 * date, combine it with the (now corrected) series time, and re-resolve to an
 * instant in the team's timezone.
 *
 * Guarded by:
 *   - `series_id IS NOT NULL` — only series-generated events have one.
 *   - `NOT series_modified` — never clobber an occurrence a captain hand-edited
 *     (a per-occurrence override is exactly what `series_modified` records;
 *     see `EventsRepository.updateFutureUnmodified`).
 *   - `status = 'active'` — leave cancelled/started events alone.
 *   - `start_at >= now()` — leave the past alone; this is a forward-looking
 *     correction, not a rewrite of history.
 *
 * Joining `event_series` here relies on statement ORDER within this same
 * migration: Statement A has already flipped every series' `start_time`/
 * `end_time` (and `times_are_team_local`) to their corrected values by the
 * time Statement B reads them, so Statement B always recomputes from the
 * corrected time. The recomputation is itself idempotent — re-deriving an
 * already-correct `start_at` from its own team-local date and the (unchanged)
 * series time reproduces the same instant — so a second manual run of this
 * whole file is harmless even though Statement B has no dedicated guard
 * column of its own.
 *
 * `personal_messages_dirty_at` is stamped with `date_trunc('milliseconds',
 * now())` (matching `EventsRepository`'s own writes to this column, see
 * `EventsRepository.ts` around the `markStalePersonalMessagesDirtySchema`/
 * `markSeriesFuturePersonalMessagesDirtySchema` queries) so the bot's
 * personal-events reconcile re-renders Discord personal messages with the
 * corrected time instead of silently going stale.
 *
 * Reversibility: the Effect migrator is forward-only (no `down`). There is no
 * clean inverse for Statement B — it overwrites `start_at`/`end_at` in place
 * and does not keep the pre-migration instant anywhere. Statement A's inverse
 * (restore `times_are_team_local = FALSE` and re-apply the opposite `AT TIME
 * ZONE` conversion) would be the documented operator runbook step, same as
 * `1791400000_anchor_all_day_to_team_midnight.ts`'s, and is likewise only
 * correct for teams whose timezone has not changed since this ran.
 */
export default Effect.flatMap(Effect.service(SqlClient.SqlClient), (sql) =>
  Effect.Do.pipe(
    Effect.tap(
      () => sql`
        ALTER TABLE event_series
          ADD COLUMN IF NOT EXISTS times_are_team_local BOOLEAN NOT NULL DEFAULT FALSE
      `,
    ),
    // Statement A — convert the series times themselves, anchored at each series'
    // own `start_date` (see the doc comment above for why that is the only correct
    // anchor, and why the AT TIME ZONE ordering is right rather than backwards).
    Effect.tap(
      () => sql`
        UPDATE event_series es
        SET start_time = ((es.start_date + es.start_time) AT TIME ZONE 'UTC'
                            AT TIME ZONE COALESCE(
                              (SELECT ts.timezone FROM team_settings ts
                                 JOIN pg_timezone_names n ON n.name = ts.timezone
                               WHERE ts.team_id = es.team_id),
                              'Europe/Prague'))::time,
            end_time   = CASE WHEN es.end_time IS NULL THEN NULL
                              ELSE ((es.start_date + es.end_time) AT TIME ZONE 'UTC'
                                      AT TIME ZONE COALESCE(
                                        (SELECT ts.timezone FROM team_settings ts
                                           JOIN pg_timezone_names n ON n.name = ts.timezone
                                         WHERE ts.team_id = es.team_id),
                                        'Europe/Prague'))::time END,
            times_are_team_local = TRUE
        WHERE NOT es.times_are_team_local
      `,
    ),
    // Statement B — re-anchor already-materialized future, active,
    // not-hand-edited occurrences from the (now team-local) series time.
    Effect.tap(
      () => sql`
        UPDATE events e
        SET start_at = ((e.start_at AT TIME ZONE COALESCE(
                            (SELECT ts.timezone FROM team_settings ts
                               JOIN pg_timezone_names n ON n.name = ts.timezone
                             WHERE ts.team_id = es.team_id),
                            'Europe/Prague'))::date + es.start_time)
                          AT TIME ZONE COALESCE(
                            (SELECT ts.timezone FROM team_settings ts
                               JOIN pg_timezone_names n ON n.name = ts.timezone
                             WHERE ts.team_id = es.team_id),
                            'Europe/Prague'),
            end_at   = CASE WHEN es.end_time IS NULL THEN NULL
                            ELSE ((e.end_at AT TIME ZONE COALESCE(
                                      (SELECT ts.timezone FROM team_settings ts
                                         JOIN pg_timezone_names n ON n.name = ts.timezone
                                       WHERE ts.team_id = es.team_id),
                                      'Europe/Prague'))::date + es.end_time)
                                    AT TIME ZONE COALESCE(
                                      (SELECT ts.timezone FROM team_settings ts
                                         JOIN pg_timezone_names n ON n.name = ts.timezone
                                       WHERE ts.team_id = es.team_id),
                                      'Europe/Prague') END,
            personal_messages_dirty_at = date_trunc('milliseconds', now())
        FROM event_series es
        WHERE e.series_id = es.id
          AND NOT e.series_modified
          AND e.status = 'active'
          AND e.start_at >= now()
      `,
    ),
  ),
);
