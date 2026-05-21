import { Option } from 'effect';

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const MAX_DAYS_OFFSET = 730;

/**
 * Formats a `Date` as a Prague-local `YYYY-MM-DD` string.
 * Uses `Intl.DateTimeFormat('en-CA', ...)` which guarantees ISO 8601 ordering.
 */
export const formatPragueDate = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(date);

export const parseLoggedAtDateInPrague = (dateString: string): Option.Option<Date> => {
  if (!DATE_REGEX.test(dateString)) {
    return Option.none();
  }

  const [yearStr, monthStr, dayStr] = dateString.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  // Validate calendar correctness via round-trip
  const utcMs = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(utcMs).toISOString().slice(0, 10);
  if (roundTrip !== dateString) {
    return Option.none();
  }

  // Compute today in Prague
  const todayPrague = formatPragueDate(new Date());
  const [tyStr, tmStr, tdStr] = todayPrague.split('-');
  const todayMs = Date.UTC(Number(tyStr), Number(tmStr) - 1, Number(tdStr));

  // Enforce ±730 days
  const deltaMs = utcMs - todayMs;
  const deltaDays = Math.round(deltaMs / 86400000);
  if (Math.abs(deltaDays) > MAX_DAYS_OFFSET) {
    return Option.none();
  }

  // Compute Prague noon in UTC using DST-safe approach.
  // Start with the "as-if-UTC" noon and iterate to find the correct UTC time
  // such that Prague wall-clock shows exactly 12:00.
  let candidate = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));

  // Get Prague hour of the candidate. If it's not 12, adjust.
  const pragueHour = Number(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Prague',
      hour: 'numeric',
      hour12: false,
    }).format(candidate),
  );

  if (pragueHour !== 12) {
    // Offset in hours: positive means Prague is ahead of UTC
    const offsetHours = pragueHour - 12;
    candidate = new Date(candidate.getTime() - offsetHours * 3600000);
  }

  return Option.some(candidate);
};
