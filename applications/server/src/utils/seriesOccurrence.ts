import { DateTime, Option } from 'effect';

/** Every fallback in this module lands here — the same default the DB column carries. */
const FALLBACK_ZONE = 'Europe/Prague';

/**
 * Resolves one series occurrence's wall-clock `time` on calendar date `dateStr` in `timezone`
 * to the instant it denotes.
 *
 * Called for a `times_are_team_local = TRUE` series row: `event_series.start_time`/`end_time`
 * are `HH:MM[:SS]` wall-clock in the team's `team_settings.timezone` (not UTC — see the
 * conversion migration `1791800000_series_time_is_team_local.ts` and `EventSeries.ts`'s field
 * docs; a `FALSE` row instead goes through `seriesTimeDialect.resolveSeriesOccurrenceInstant`'s
 * legacy UTC branch, which does not call this function). A recurring "Tuesday 18:00" is a wall
 * clock: no single UTC time-of-day equals 18:00 local all year, so the naive
 * `${date}T${time}Z` materialization this replaces was an hour off for half the year for any
 * team whose timezone observes DST.
 *
 * - `dateStr` is an ISO `YYYY-MM-DD` (as produced by `DateTime.formatIsoDateUtc` on the generated
 *   occurrence date).
 * - `time` is `HH:MM` or `HH:MM:SS` — the column is a PG `TIME`, which the driver can hand back
 *   with seconds, so both shapes must decode; a missing seconds component is treated as `:00`.
 *
 * ## Why `makeZoned(..., { adjustForTimeZone: true })` and not `setParts` on an anchor
 *
 * The obvious implementation — anchor at `${dateStr}T00:00:00Z`, attach the zone, then
 * `setParts` the calendar and clock fields — is WRONG for every zone with a negative UTC offset,
 * and it fails silently by a whole month. Midnight UTC is the PREVIOUS day west of UTC, so the
 * anchor's day-of-month is 31 when `dateStr` is the 1st. `setParts` assigns year, then month,
 * then day (`effect/internal/dateTime`'s `setPartsDate`), so setting the month to one with fewer
 * than 31 days overflows before the day is corrected:
 *
 *     America/New_York, asked 2026-02-01 18:00 -> got 2026-03-01 18:00
 *
 * Prague and UTC are unaffected, which is exactly why it survives a test suite that only covers
 * eastern zones. Building the zoned value directly from the wall-clock string avoids the anchor
 * entirely, so there is no intermediate date to overflow.
 *
 * ## DST gap (spring-forward)
 *
 * A combination inside the gap (e.g. `02:30` on the day the zone jumps `02:00 -> 03:00`) has no
 * local instant. The library's default `"compatible"` disambiguation is used: the wall clock is
 * effectively pushed forward by the size of the gap, so it lands where `03:30` would. Never throws.
 *
 * ## DST ambiguity (fall-back)
 *
 * A combination inside the repeated hour happens twice. `"compatible"` picks the EARLIER of the
 * two (the pre-transition, still-DST offset). One instant is chosen deterministically.
 *
 * NOTE: `EventsRepository#updateFutureUnmodified` re-derives the same value in SQL, and Postgres's
 * `AT TIME ZONE` picks the LATER occurrence for the ambiguous case. The two therefore disagree by
 * one hour for a series whose wall clock sits in the repeated hour — see the comment on that query.
 *
 * ## Invalid timezone
 *
 * Never throws. `team_settings.timezone` carries `team_settings_timezone_check`, but that CHECK
 * only asserts Postgres can resolve the zone — `UTC+3` passes it and `makeZoned` still returns
 * `None` — and rows written before `1792000005_team_settings_timezone_check.ts` were never
 * checked at all. A cron that throws on one row must not stop generating events for every other
 * team, so the retry below is on the known-good `FALLBACK_ZONE`.
 */
export const resolveOccurrenceInstant = (
  dateStr: string,
  time: string,
  timezone: string,
): DateTime.Utc => {
  // `HH:MM` -> `HH:MM:00`; `HH:MM:SS` is already well-formed. Anything else is not reachable from
  // a PG `TIME` column, and would surface as an invalid-input defect rather than a silent shift.
  const [hour = '00', minute = '00', second = '00'] = time.split(':');
  const wallClock = `${dateStr}T${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`;

  const zoned = Option.getOrElse(
    DateTime.makeZoned(wallClock, { timeZone: timezone, adjustForTimeZone: true }),
    () => DateTime.makeZonedUnsafe(wallClock, { timeZone: FALLBACK_ZONE, adjustForTimeZone: true }),
  );

  return DateTime.toUtc(zoned);
};
