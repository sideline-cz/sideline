import { EventSeries } from '@sideline/domain';
import { DateTime, type Option } from 'effect';

const isMonthly = (
  r: EventSeries.Recurrence,
): r is Extract<EventSeries.Recurrence, { frequency: 'monthly_by_date' | 'monthly_by_weekday' }> =>
  r.frequency === 'monthly_by_date' || r.frequency === 'monthly_by_weekday';

// Deliberately NOT "everything in the window": a monthly series always materialises its next
// occurrence, even past `horizonDays` (also for a future `start_date`). Anchored on
// `seriesStartDate`, NOT on the caller's `startFrom` (`last_generated_date + 1`), or every run
// would chase one occurrence further ahead. Do not "fix" this into a pure window.
export const computeHorizonEnd = (params: {
  recurrence: EventSeries.Recurrence;
  seriesStartDate: DateTime.Utc;
  seriesEndDate: DateTime.Utc | null;
  horizonDays: number;
}): DateTime.Utc => {
  const now = DateTime.nowUnsafe();
  let horizonEnd = DateTime.add(now, { days: params.horizonDays });
  if (isMonthly(params.recurrence)) {
    const today = DateTime.startOf(now, 'day');
    const anchor = DateTime.max(today, params.seriesStartDate);
    // Monthly gaps are at most 35 days, so a 62-day scan always finds the next occurrence.
    const [next] = generateOccurrenceDates({
      ...params.recurrence,
      startDate: anchor,
      endDate: DateTime.add(anchor, { days: 62 }),
    });
    if (next !== undefined && DateTime.isGreaterThan(next, horizonEnd)) horizonEnd = next;
  }
  if (params.seriesEndDate === null) return horizonEnd;
  return DateTime.isLessThanOrEqualTo(params.seriesEndDate, horizonEnd)
    ? params.seriesEndDate
    : horizonEnd;
};

// The only way server callers turn a series row into a `Recurrence`.
export const seriesRecurrence = (row: {
  readonly frequency: string;
  readonly days_of_week: ReadonlyArray<number>;
  readonly day_of_month: Option.Option<number>;
  readonly week_of_month: Option.Option<number>;
}): Option.Option<EventSeries.Recurrence> =>
  EventSeries.toRecurrence({
    frequency: row.frequency,
    daysOfWeek: row.days_of_week,
    dayOfMonth: row.day_of_month,
    weekOfMonth: row.week_of_month,
  });

// Same UTC-midnight walk and boundary semantics as the weekly loop, but anchor-free: the output
// depends only on the calendar. Short months clamp to their last day (one occurrence per month).
const monthlyDates = (
  params: Extract<
    EventSeries.Recurrence,
    { frequency: 'monthly_by_date' | 'monthly_by_weekday' }
  > & {
    startDate: DateTime.Utc;
    endDate: DateTime.Utc;
  },
): ReadonlyArray<DateTime.Utc> => {
  const { startDate, endDate } = params;
  if (DateTime.isGreaterThan(startDate, endDate)) return [];

  const dates: DateTime.Utc[] = [];
  let current = startDate;
  while (DateTime.isLessThanOrEqualTo(current, endDate)) {
    const d = DateTime.getPartUtc(current, 'day');
    const last = new Date(
      Date.UTC(DateTime.getPartUtc(current, 'year'), DateTime.getPartUtc(current, 'month'), 0),
    ).getUTCDate();
    const match =
      params.frequency === 'monthly_by_date'
        ? d === params.dayOfMonth || (d === last && params.dayOfMonth > last)
        : DateTime.getPartUtc(current, 'weekDay') === params.dayOfWeek &&
          (params.weekOfMonth === -1 ? d + 7 > last : Math.ceil(d / 7) === params.weekOfMonth);
    if (match) dates.push(current);
    current = DateTime.add(current, { days: 1 });
  }
  return dates;
};

export const generateOccurrenceDates = (
  params: EventSeries.Recurrence & {
    startDate: DateTime.Utc;
    endDate: DateTime.Utc;
  },
): ReadonlyArray<DateTime.Utc> => {
  if (isMonthly(params)) return monthlyDates(params);
  const { frequency, daysOfWeek, startDate, endDate } = params;

  if (DateTime.isGreaterThan(startDate, endDate)) return [];
  if (daysOfWeek.length === 0) return [];

  const daySet = new Set(daysOfWeek);
  const dates: DateTime.Utc[] = [];

  let current = startDate;

  // For biweekly, track which week number we're in relative to start
  const startDayNumber = Math.floor(DateTime.toEpochMillis(startDate) / (1000 * 60 * 60 * 24));

  while (DateTime.isLessThanOrEqualTo(current, endDate)) {
    const currentDay = DateTime.getPartUtc(current, 'weekDay');

    if (daySet.has(currentDay)) {
      if (frequency === 'weekly') {
        dates.push(current);
      } else {
        // biweekly: only include days in even weeks (0, 2, 4, ...)
        const currentDayNumber = Math.floor(
          DateTime.toEpochMillis(current) / (1000 * 60 * 60 * 24),
        );
        const daysSinceStart = currentDayNumber - startDayNumber;
        const weekNumber = Math.floor(daysSinceStart / 7);
        if (weekNumber % 2 === 0) {
          dates.push(current);
        }
      }
    }

    current = DateTime.add(current, { days: 1 });
  }

  return dates;
};
