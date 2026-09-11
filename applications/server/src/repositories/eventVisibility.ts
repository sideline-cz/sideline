/**
 * Shared SQL fragments for "this event still belongs on an upcoming/visible
 * surface, and is still RSVP-able" (plan §4.4, §14.1).
 *
 * Six positive predicates, one negated sweep, three reminder queries and the
 * RSVP write path must all agree on this rule. Duplicating the `CASE` at every
 * call site is exactly how the original bug spread, so it is centralised here
 * and spliced with `sql.unsafe(...)` — established in this repo at
 * `applications/server/src/gdpr/eraseUser.ts:97-98,116-118,153-155`. The
 * fragments below take no user input (only identifiers chosen in source), so
 * there is no injection surface.
 *
 * Timed events: unchanged — active and not yet started (`start_at >= now`).
 *
 * All-day events: `start_at`/`end_at` are team-local midnight instants (not a
 * noon-UTC sentinel — see the PR 3/3c anchor move), so an all-day event stays
 * live through the end of its LAST LOCAL DAY: `end_at` (or `start_at`, if no
 * `end_at`) is local midnight of the last day, so "local midnight of that day,
 * plus one local day" is the instant the event is truly over. They keep their
 * existing 00:00-local `active → started` flip, which is why the `status`
 * half must be relaxed too — otherwise relaxing only the instant half changes
 * nothing (BL2).
 *
 * `(x AT TIME ZONE tz) + INTERVAL '1 day' AT TIME ZONE tz` is calendar
 * arithmetic on the NAIVE local value, so it is DST-exact (unlike the tz-free
 * shortcut `x + INTERVAL '1 day'`, which adds exactly 24 hours and is wrong by
 * ±1 hour on the two DST-transition days a year).
 *
 * `tz` must be a SQL expression that is never NULL and is single-valued per
 * event, e.g. `COALESCE(ts.timezone, 'Europe/Prague')` for a LEFT JOIN,
 * `ts.timezone` for an INNER JOIN (`team_settings.timezone` is
 * `TEXT NOT NULL DEFAULT 'Europe/Prague'`), or a correlated scalar subselect
 * where no join is possible (see the stale sweep in `EventsRepository.ts`).
 */

/**
 * The instant at which this event's LAST LOCAL DAY is fully over: local
 * midnight of `end_at`'s (or `start_at`'s, if no `end_at`) calendar date,
 * plus one local day. Shared by `eventVisibleAt` below and by any other site
 * that needs the same "is this all-day event's last local day over yet"
 * arithmetic without re-deriving it (e.g. the ended-trainings auto-log query).
 */
export const eventEndOfLastLocalDay = (e: string, tz: string): string =>
  `((COALESCE(${e}.end_at, ${e}.start_at) AT TIME ZONE ${tz}) + INTERVAL '1 day') AT TIME ZONE ${tz}`;

/**
 * Same shape as `eventVisibleNow` with an injectable `now` EXPRESSION (not a
 * bound value). `nowExpr` MUST be a SQL expression that already resolves to a
 * bound parameter, e.g. `p.now_at` from a `WITH p AS (SELECT ${nowParam}::timestamptz
 * AS now_at) ... CROSS JOIN p` wrapper (§4.4.1) — never interpolate a JS value
 * (like an ISO string) directly into this function's arguments, or the "no
 * injection surface" claim above stops being true.
 */
export const eventVisibleAt = (e: string, tz: string, nowExpr: string): string => `
  (
    (${e}.all_day = FALSE AND ${e}.status = 'active' AND ${e}.start_at >= ${nowExpr})
    OR
    (${e}.all_day = TRUE AND ${e}.status IN ('active', 'started')
     AND ${eventEndOfLastLocalDay(e, tz)} > ${nowExpr})
  )`;

export const eventVisibleNow = (e: string, tz: string): string => eventVisibleAt(e, tz, 'now()');

/** Exact logical negation, exported from the same module so the two can never drift. */
export const eventNotVisibleNow = (e: string, tz: string): string =>
  `NOT ${eventVisibleNow(e, tz)}`;

/**
 * Ordering key: (local calendar date, all-day first, start time, id).
 * The trailing `id` is NOT cosmetic — once the day-grouped key lands, two
 * all-day events on the same date collide on every other column (same local
 * date, same `all_day`, same local-midnight `start_at`), so without a unique
 * tiebreaker Postgres may return them in a different order per page and
 * paginated surfaces can repeat or drop rows (§4.4.3).
 */
export const eventDayOrder = (e: string, tz: string): string => `
  (${e}.start_at AT TIME ZONE ${tz})::date ASC,
  ${e}.all_day DESC,
  ${e}.start_at ASC,
  ${e}.id ASC`;
