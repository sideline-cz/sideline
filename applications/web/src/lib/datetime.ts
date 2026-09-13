import { DateTime, Option } from 'effect';

/**
 * Interpret a date + time string pair in the browser's local timezone
 * and return a UTC DateTime.
 */
export const localToUtc = (date: string, time: string): DateTime.Utc => {
  const [y, mo, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return DateTime.fromDateUnsafe(new Date(y, mo - 1, d, h, mi, 0, 0));
};

/** Format a UTC DateTime as YYYY-MM-DD in the browser's local timezone. */
export const formatLocalDate = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const y = d.getFullYear();
  const mo = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
};

/**
 * A date-only value that carries no timezone meaning of its own — a payment date, a fee
 * due date, an expense date, a recurrence-window bound. Anchored at noon UTC so its UTC
 * calendar date matches the intended date for every practical offset. Read it back with
 * `formatUtcDate`/`formatLocalDate` as today; nothing about these values changed.
 *
 * NOT for all-day events. Those are anchored to the TEAM's local midnight, by the SERVER
 * (see applications/server/src/api/event.ts — plan §12). The web sends the same
 * `T12:00:00Z` wire value it always did and the server re-anchors it; there is no
 * client-side helper for the all-day case and there must not be one, because the browser
 * does not reliably know the team's timezone at these call sites.
 */
export const dateOnlyToUtcNoon = (date: string): DateTime.Utc =>
  DateTime.makeUnsafe(`${date}T12:00:00Z`);

/**
 * Format a UTC DateTime as YYYY-MM-DD in UTC.
 * This is now only the rolling-deploy fallback for all-day events (plan §11.2/§17): when
 * an older server hasn't shipped the derived team-local `startDate`/`endDate` yet, readers
 * fall back to reading the (still noon-UTC-anchored) instant in UTC. Once every server has
 * rolled out, all-day reads should go through the derived date string instead — do NOT
 * treat this as "always read all-day values in UTC".
 */
export const formatUtcDate = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
};

/** Format a UTC DateTime as HH:mm in the browser's local timezone. */
export const formatLocalTime = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
};

/**
 * Format an event's start/end range using the browser's local timezone.
 * - `startDate`, `startTime` — start formatted as YYYY-MM-DD and HH:mm
 * - `end` — `None` when no end is provided; otherwise:
 *     - same local calendar day → `Some('HH:mm')`
 *     - different local calendar day → `Some('YYYY-MM-DD HH:mm')`
 * - `sameDay` — `true` when there is no end OR the end falls on the same local
 *   calendar day as the start. Comparison is on LOCAL calendar date so an
 *   event that crosses midnight in the viewer's tz counts as multi-day.
 *
 * `startDateOption`/`endDateOption` are the server-derived team-local calendar
 * dates (plan §11.2/§11.3, e.g. `EventInfo.startDate`/`endDate`). When present
 * they are used as-is for the all-day branch; when `Option.none()` (an older
 * server that hasn't shipped the field yet) the reader falls back to
 * `formatUtcDate` on the corresponding instant — today's behaviour, not
 * `formatLocalDate` — so a web-ahead-of-server rollout stays safe (plan §17).
 */
export const formatEventDateRange = (
  startAt: DateTime.Utc,
  endAt: Option.Option<DateTime.Utc>,
  allDay = false,
  startDateOption: Option.Option<string> = Option.none(),
  endDateOption: Option.Option<string> = Option.none(),
): {
  startDate: string;
  startTime: string;
  end: Option.Option<string>;
  sameDay: boolean;
} => {
  // All-day events carry no meaningful time-of-day. Prefer the server-derived
  // team-local calendar date; fall back to reading the (noon-UTC) instant.
  if (allDay) {
    const startDate = Option.getOrElse(startDateOption, () => formatUtcDate(startAt));
    return Option.match(endAt, {
      onNone: () => ({ startDate, startTime: '', end: Option.none<string>(), sameDay: true }),
      onSome: (e) => {
        const endDate = Option.getOrElse(endDateOption, () => formatUtcDate(e));
        const sameDay = startDate === endDate;
        return {
          startDate,
          startTime: '',
          end: sameDay ? Option.none<string>() : Option.some(endDate),
          sameDay,
        };
      },
    });
  }

  const startDate = formatLocalDate(startAt);
  const startTime = formatLocalTime(startAt);

  return Option.match(endAt, {
    onNone: () => ({ startDate, startTime, end: Option.none<string>(), sameDay: true }),
    onSome: (e) => {
      const endDate = formatLocalDate(e);
      const endTime = formatLocalTime(e);
      const sameDay = startDate === endDate;
      const end = Option.some(sameDay ? endTime : `${endDate} ${endTime}`);
      return { startDate, startTime, end, sameDay };
    },
  });
};

/**
 * Format a UTC DateTime as HH:mm in UTC.
 * No longer the series write path (see `formatTimeInZone`) — `event_series.startTime`/`endTime`
 * are team-local wall-clock strings now, not UTC times, so writing a series no longer goes
 * through this. Kept for whatever genuinely needs a UTC instant's time-of-day (as opposed to
 * a team-local wall clock); nothing in this codebase currently calls it outside tests.
 */
export const formatUtcTime = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
};

/**
 * Format a UTC DateTime as HH:mm in the GIVEN IANA timezone (not the browser's).
 *
 * This is the projection step for writing a single-occurrence override back onto a
 * `event_series`-shaped wall-clock field (plan: startTime/endTime are now team-local wall
 * clock, not UTC — see the module-level rationale in the callers). The browser only knows
 * what instant the user picked; it must be re-expressed in the TEAM's zone, not the viewer's,
 * because that is the zone the wall-clock string is defined in.
 *
 * Uses `DateTime.setZoneNamed`/`DateTime.toParts` (the same pattern the server-side
 * `recomputeStartAt` test helper and `resolveOccurrenceInstant` use) rather than
 * `Intl.DateTimeFormat`: `toParts` hands back `hour`/`minute` as plain numbers with no locale
 * involved, so there is no `24:00`-for-midnight quirk to normalise (some ICU builds return
 * `24:00` instead of `00:00` for local midnight from `Intl.DateTimeFormat` with `hour12: false`
 * — that never arises here).
 *
 * `tz` is user/DB-sourced free-form text (`team_settings.timezone` has no CHECK constraint —
 * see the migration `1791600000_series_time_is_team_local.ts`), so it can be invalid. Unlike
 * `Intl.DateTimeFormat`, which THROWS a `RangeError` for an unrecognised zone,
 * `DateTime.setZoneNamed` returns `None`; this falls back to `'Europe/Prague'`, mirroring the
 * server's `resolveOccurrenceInstant`/migration defence for the exact same bad-data case, on a
 * render/save path where throwing would be user-visible breakage.
 */
export const formatTimeInZone = (dt: DateTime.Utc, tz: string): string => {
  const zoned = Option.getOrElse(DateTime.setZoneNamed(dt, tz), () =>
    DateTime.setZoneNamedUnsafe(dt, 'Europe/Prague'),
  );
  const { hour, minute } = DateTime.toParts(zoned);
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
};
