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
 * Convert a date-only string (YYYY-MM-DD) to a UTC DateTime anchored at noon.
 * Using noon ensures the UTC calendar date matches the intended date for all
 * practical timezones (UTC-12 to UTC+12).
 */
export const dateOnlyToUtc = (date: string): DateTime.Utc =>
  DateTime.makeUnsafe(`${date}T12:00:00Z`);

/** Format a UTC DateTime as HH:mm in the browser's local timezone. */
export const formatLocalTime = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const h = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
};

/** Format a UTC DateTime as YYYY-MM-DD in UTC (calendar date of the UTC clock). */
export const formatUtcDate = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const y = d.getUTCFullYear();
  const mo = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
};

/**
 * Format an event's start/end range.
 *
 * When `allDay` is `false` (default): uses the browser's local timezone.
 * - `startDate`, `startTime` — start formatted as YYYY-MM-DD and HH:mm
 * - `end` — `None` when no end; `Some('HH:mm')` same day; `Some('YYYY-MM-DD HH:mm')` multi-day
 * - `sameDay` — `true` when no end OR end falls on same local calendar day
 *
 * When `allDay` is `true`: compares UTC calendar dates; `startTime` is always `''`.
 * - `end` — `None` when no end OR same UTC date; `Some('YYYY-MM-DD')` for multi-day
 * - `sameDay` — `true` when no end OR end UTC date equals start UTC date
 */
export const formatEventDateRange = (
  startAt: DateTime.Utc,
  endAt: Option.Option<DateTime.Utc>,
  allDay = false,
): {
  startDate: string;
  startTime: string;
  end: Option.Option<string>;
  sameDay: boolean;
} => {
  if (allDay) {
    const startDate = formatUtcDate(startAt);
    return Option.match(endAt, {
      onNone: () => ({ startDate, startTime: '', end: Option.none<string>(), sameDay: true }),
      onSome: (e) => {
        const endDate = formatUtcDate(e);
        const sameDay = startDate === endDate;
        const end = sameDay ? Option.none<string>() : Option.some(endDate);
        return { startDate, startTime: '', end, sameDay };
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

/** Format a UTC DateTime as HH:mm in UTC (for storing time-of-day values). */
export const formatUtcTime = (dt: DateTime.Utc): string => {
  const d = new Date(Number(DateTime.toEpochMillis(dt)));
  const h = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${mi}`;
};

/**
 * Convert a stored UTC time string (HH:MM) back to the browser's local time string.
 * Uses the current date's DST offset — best approximation for time-only values.
 */
export const utcTimeToLocal = (time: string): string => {
  const today = new Date();
  const y = today.getFullYear();
  const mo = String(today.getMonth() + 1).padStart(2, '0');
  const d = String(today.getDate()).padStart(2, '0');
  const hhmm = time.slice(0, 5);
  return formatLocalTime(DateTime.makeUnsafe(`${y}-${mo}-${d}T${hhmm}:00Z`));
};
