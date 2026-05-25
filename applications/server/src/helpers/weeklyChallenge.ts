import { WeeklySummary } from '@sideline/domain';
import { DateTime } from 'effect';

/**
 * Returns the Monday 00:00 of the current ISO week in the given team timezone,
 * as a Date object.
 */
export const currentTeamMondayDate = (teamTz: string): Date => {
  const now = DateTime.nowUnsafe();
  const weekRange = WeeklySummary.weekRangeFor(now, teamTz);
  return new Date(weekRange.startAt.epochMilliseconds);
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
 * Returns the Monday date string (YYYY-MM-DD) of the current ISO week as it
 * appears in the team's local timezone. The underlying `currentTeamMondayDate`
 * is "Monday 00:00 in teamTz" expressed as a UTC instant, so we must format
 * back through the team timezone to recover the calendar day.
 */
export const currentTeamMondayDateString = (teamTz: string): string => {
  const monday = currentTeamMondayDate(teamTz);
  return formatDateInTz(monday, teamTz);
};

/**
 * Given a `week_start_date` (loaded from a Postgres `DATE` column, i.e. JS
 * `Date` pinned to UTC midnight of the stored calendar day), returns its
 * calendar-day string. We read UTC components, NOT the team timezone — a
 * `DATE` is timezone-agnostic, and reading it in a non-UTC zone would shift
 * the day for negative offsets (e.g. `2026-03-09` would become `2026-03-08`
 * in America/Los_Angeles).
 */
export const weekStartDateString = (date: Date, _teamTz: string): string => formatDateUtc(date);

/**
 * Combines a `week_start_date` (UTC-midnight `DATE` value) with 09:00 in the
 * given team timezone to produce a UTC timestamp for the announcement. The
 * calendar day is taken from the value's UTC components so western-offset
 * teams don't slip to the previous day.
 */
export const scheduleAtNineAm = (weekStart: Date, teamTz: string): Date => {
  const year = weekStart.getUTCFullYear();
  const month = weekStart.getUTCMonth() + 1;
  const day = weekStart.getUTCDate();
  const tz = DateTime.zoneMakeNamedUnsafe(teamTz);
  const utcAtNoon = DateTime.makeUnsafe(Date.UTC(year, month - 1, day, 12, 0, 0));
  const zoned = DateTime.setZone(utcAtNoon, tz);
  const at9am = DateTime.setParts(zoned, { hour: 9, minute: 0, second: 0, millisecond: 0 });
  return new Date(at9am.epochMilliseconds);
};
