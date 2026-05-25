import { DateTime } from 'effect';

/**
 * Returns the today's date in the given IANA timezone as a YYYY-MM-DD string.
 * Used for computing isActive and validating date ranges.
 */
export const todayInTzString = (teamTz: string): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: teamTz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(new Date());
};

/**
 * Formats a JS Date as 'YYYY-MM-DD' using its UTC components — i.e. the
 * calendar day of the underlying UTC instant. This is the right helper for
 * Postgres `DATE` columns, which `@effect/sql-pg` materialises as `Date`
 * objects pinned to UTC midnight; reading them in a non-UTC timezone would
 * shift the day for negative offsets (e.g. America/Los_Angeles would turn
 * 2026-03-09 into 2026-03-08).
 */
export const formatDateUtc = (date: Date): string => {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Formats a Date as 'YYYY-MM-DD' in the given IANA timezone.
 */
export const formatDateInTz = (date: Date, timezone: string): string => {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return formatter.format(date);
};

/**
 * Combines a `start_date` (UTC-midnight `DATE` value) with 09:00 in the
 * given team timezone to produce a UTC timestamp for the announcement. The
 * calendar day is taken from the value's UTC components so western-offset
 * teams don't slip to the previous day.
 */
export const scheduleAtNineAm = (startDate: Date, teamTz: string): Date => {
  const year = startDate.getUTCFullYear();
  const month = startDate.getUTCMonth() + 1;
  const day = startDate.getUTCDate();
  const tz = DateTime.zoneMakeNamedUnsafe(teamTz);
  const utcAtNoon = DateTime.makeUnsafe(Date.UTC(year, month - 1, day, 12, 0, 0));
  const zoned = DateTime.setZone(utcAtNoon, tz);
  const at9am = DateTime.setParts(zoned, { hour: 9, minute: 0, second: 0, millisecond: 0 });
  return new Date(at9am.epochMilliseconds);
};
