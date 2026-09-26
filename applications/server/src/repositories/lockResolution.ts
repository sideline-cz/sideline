/**
 * The shared SQL fragment that resolves WHICH RSVP-lock offset applies to an
 * event — and nothing else. Spliced with `sql.unsafe(...)`, exactly as
 * `eventVisibility.ts` does, and for the same reason it gives: duplicating the
 * `CASE` at every call site is how the original bug spread. It takes no user
 * input (only identifiers chosen in source), so there is no injection surface.
 *
 * **It never compares anything to `now`.** The instant RSVPs close, and the
 * gate that enforces it, live in `utils/allDayRsvpWindow.ts`
 * (`rsvpClosesAtOf` / `eventRsvpOpen`). Evaluating either of those here would
 * re-create the TS/SQL lockstep hazard that module's header exists to warn
 * about, for a feature that has no SQL twin.
 */

/**
 * `team_settings.rsvp_lock_hours_before`, overridden per event type. Resolves to
 * SQL NULL — "no lock" — in every degenerate case:
 *
 * - **Key absent from the map** → the team-wide value. `-> key` yields SQL NULL
 *   for a missing key, which is what the outer `IS NOT NULL` tests. Using
 *   `-> … IS NOT NULL` rather than the `?` operator is also what keeps this
 *   safe to splice: a bare `?` inside a tagged SQL template is a placeholder
 *   hazard.
 * - **Key present, JSON `null`** → NULL, i.e. no early lock for this type (the
 *   all-day end-of-day grace survives). `jsonb_typeof('null'::jsonb)` is
 *   `'null'`, not `'number'`, so the inner `CASE` falls through.
 * - **Key present, a number in `0..336`** → that number, INCLUDING `0` (lock
 *   exactly at start). A `COALESCE(NULLIF(…, 0), base)` would silently get this
 *   wrong.
 * - **Key present, a FRACTIONAL number** → floored. `jsonb_typeof(1.5)` is
 *   `'number'` too, and `->>` then hands `::int` the text `'1.5'`, which
 *   RAISES. `FLOOR(…::numeric)::int` is what makes that cast total: `::numeric`
 *   cannot raise for a value `jsonb_typeof` has already called a number. It
 *   floors rather than refusing because that is the permissive direction — 1.5 h
 *   becomes a 1 h lock, never a 2 h one.
 * - **Key present, anything else** → NULL: a string, a bool, an object, and
 *   also a number OUTSIDE `0..336` — `1e20` is a perfectly good `jsonb` number
 *   that no `int` can hold, so the cast raises there too. That is what the
 *   range test closes. All of this matters because the column CHECK pins only
 *   the top-level shape, so ONE bad value written by direct SQL would otherwise
 *   take out a whole team's event list — every one of the FOUR queries splicing
 *   this fragment — not one event. Note the DIRECTION differs from the reminder
 *   precedent: there garbage degrades to the base value (keep reminders
 *   firing), here it degrades to *off*, because wrongly refusing someone's RSVP
 *   is the worse failure.
 *
 *   The range test is a NESTED `CASE`, not an `AND` next to `jsonb_typeof`:
 *   Postgres does not promise to evaluate `AND` left to right, so a cast in the
 *   second operand can still run for a row the first operand rejects. `CASE` is
 *   the documented way to force the order.
 * - **No `team_settings` row at all** (LEFT JOIN) → every `ts.*` is NULL → off,
 *   for free, because the column is nullable.
 *
 * `e` must alias `events` (for `event_type`) and `ts` the team's
 * `team_settings` row. Any query splicing this and carrying a `GROUP BY` must
 * add both `ts.*` columns to it.
 */
export const resolvedLockHours = (e: string, ts: string): string => `
  CASE
    WHEN ${ts}.rsvp_lock_hours_before_overrides -> ${e}.event_type IS NOT NULL
      THEN CASE
             WHEN jsonb_typeof(${ts}.rsvp_lock_hours_before_overrides -> ${e}.event_type) = 'number'
             THEN CASE
                    WHEN (${ts}.rsvp_lock_hours_before_overrides ->> ${e}.event_type)::numeric
                           BETWEEN 0 AND 336
                    THEN FLOOR((${ts}.rsvp_lock_hours_before_overrides ->> ${e}.event_type)::numeric)::int
                  END
           END
    ELSE ${ts}.rsvp_lock_hours_before
  END`;
