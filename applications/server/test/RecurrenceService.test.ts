import type { EventSeries } from '@sideline/domain';
import { DateTime } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computeHorizonEnd, generateOccurrenceDates } from '~/services/RecurrenceService.js';
import { resolveSeriesOccurrenceInstant } from '~/utils/seriesTimeDialect.js';

describe('generateOccurrenceDates', () => {
  it('generates correct dates for weekly over 4 weeks', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [2], // Tuesday
      startDate: DateTime.makeUnsafe('2026-03-03'), // Tuesday
      endDate: DateTime.makeUnsafe('2026-03-31'),
    });
    expect(dates).toHaveLength(5);
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual([
      '2026-03-03',
      '2026-03-10',
      '2026-03-17',
      '2026-03-24',
      '2026-03-31',
    ]);
  });

  it('generates correct dates for biweekly (skips alternate weeks)', () => {
    const dates = generateOccurrenceDates({
      frequency: 'biweekly',
      daysOfWeek: [2], // Tuesday
      startDate: DateTime.makeUnsafe('2026-03-03'), // Tuesday
      endDate: DateTime.makeUnsafe('2026-03-31'),
    });
    expect(dates).toHaveLength(3);
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual([
      '2026-03-03',
      '2026-03-17',
      '2026-03-31',
    ]);
  });

  it('finds next occurrence when start date is not on target day', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [4], // Thursday
      startDate: DateTime.makeUnsafe('2026-03-02'), // Monday
      endDate: DateTime.makeUnsafe('2026-03-15'),
    });
    expect(dates).toHaveLength(2);
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual(['2026-03-05', '2026-03-12']);
  });

  it('returns empty when end is before start', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [2],
      startDate: DateTime.makeUnsafe('2026-04-01'),
      endDate: DateTime.makeUnsafe('2026-03-01'),
    });
    expect(dates).toHaveLength(0);
  });

  it('generates single occurrence for exact one-week range', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [1], // Monday
      startDate: DateTime.makeUnsafe('2026-03-02'), // Monday
      endDate: DateTime.makeUnsafe('2026-03-08'),
    });
    expect(dates).toHaveLength(1);
    expect(DateTime.formatIsoDateUtc(dates[0])).toBe('2026-03-02');
  });

  it('handles Sunday (day 0) correctly', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [0], // Sunday
      startDate: DateTime.makeUnsafe('2026-03-02'), // Monday
      endDate: DateTime.makeUnsafe('2026-03-22'),
    });
    expect(dates).toHaveLength(3);
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual([
      '2026-03-08',
      '2026-03-15',
      '2026-03-22',
    ]);
  });

  it('generates dates for multiple days weekly', () => {
    const dates = generateOccurrenceDates({
      frequency: 'weekly',
      daysOfWeek: [1, 3, 5], // Monday, Wednesday, Friday
      startDate: DateTime.makeUnsafe('2026-03-02'), // Monday
      endDate: DateTime.makeUnsafe('2026-03-13'), // Friday
    });
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual([
      '2026-03-02', // Mon
      '2026-03-04', // Wed
      '2026-03-06', // Fri
      '2026-03-09', // Mon
      '2026-03-11', // Wed
      '2026-03-13', // Fri
    ]);
  });

  it('generates dates for multiple days biweekly', () => {
    const dates = generateOccurrenceDates({
      frequency: 'biweekly',
      daysOfWeek: [1, 3], // Monday, Wednesday
      startDate: DateTime.makeUnsafe('2026-03-02'), // Monday
      endDate: DateTime.makeUnsafe('2026-03-25'),
    });
    // Week 0 (Mar 2-8): Mon 2, Wed 4
    // Week 1 (Mar 9-15): skipped
    // Week 2 (Mar 16-22): Mon 16, Wed 18
    // Week 3 (Mar 23-25): skipped
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual([
      '2026-03-02',
      '2026-03-04',
      '2026-03-16',
      '2026-03-18',
    ]);
  });
});

// ---------------------------------------------------------------------------
// Monthly recurrence (`.dev-loop/plan.md` Task 2)
// ---------------------------------------------------------------------------

const d = (iso: string) => DateTime.makeUnsafe(`${iso}T00:00:00Z`);

const monthly = (
  recurrence: Extract<
    EventSeries.Recurrence,
    { frequency: 'monthly_by_date' | 'monthly_by_weekday' }
  >,
  start: string,
  end: string | DateTime.Utc,
) =>
  generateOccurrenceDates({
    ...recurrence,
    startDate: d(start),
    endDate: typeof end === 'string' ? d(end) : end,
  }).map(DateTime.formatIsoDateUtc);

const byDate = (dayOfMonth: number) => ({ frequency: 'monthly_by_date' as const, dayOfMonth });
const byWeekday = (dayOfWeek: number, weekOfMonth: EventSeries.WeekOfMonth) => ({
  frequency: 'monthly_by_weekday' as const,
  dayOfWeek,
  weekOfMonth,
});

const pad = (n: number) => String(n).padStart(2, '0');

describe('generateOccurrenceDates — monthly_by_date', () => {
  describe('short months clamp to the last day', () => {
    it.each([
      [29, ['2027-01-29', '2027-02-28', '2027-03-29']],
      [30, ['2027-01-30', '2027-02-28', '2027-03-30']],
      [31, ['2027-01-31', '2027-02-28', '2027-03-31']],
    ])('should clamp day %i to 28 Feb in a non-leap year (2027)', (day, expected) => {
      expect(monthly(byDate(day), '2027-01-01', '2027-03-31')).toEqual(expected);
    });

    it.each([
      [29, ['2028-01-29', '2028-02-29', '2028-03-29']],
      [30, ['2028-01-30', '2028-02-29', '2028-03-30']],
      [31, ['2028-01-31', '2028-02-29', '2028-03-31']],
    ])('should clamp day %i to 29 Feb in a leap year (2028)', (day, expected) => {
      expect(monthly(byDate(day), '2028-01-01', '2028-03-31')).toEqual(expected);
    });

    it('should clamp day 31 to the 30th in 30-day months', () => {
      expect(monthly(byDate(31), '2027-04-01', '2027-06-30')).toEqual([
        '2027-04-30',
        '2027-05-31',
        '2027-06-30',
      ]);
    });

    it('should produce exactly one 15th per month over a full year', () => {
      const dates = monthly(byDate(15), '2027-01-01', '2027-12-31');
      expect(dates).toEqual(Array.from({ length: 12 }, (_, i) => `2027-${pad(i + 1)}-15`));
    });
  });

  describe('start and end boundaries', () => {
    it('should skip the start month when the start is after the day', () => {
      expect(monthly(byDate(15), '2027-01-16', '2027-03-31')).toEqual(['2027-02-15', '2027-03-15']);
    });

    it('should include the start day when it is the day of month', () => {
      expect(monthly(byDate(15), '2027-01-15', '2027-02-01')).toEqual(['2027-01-15']);
    });

    it('should stop at a series end before the next occurrence', () => {
      expect(monthly(byDate(15), '2027-01-01', '2027-02-14')).toEqual(['2027-01-15']);
    });

    it('should include an end that is exactly the occurrence midnight', () => {
      expect(
        monthly(byDate(15), '2027-01-01', DateTime.makeUnsafe('2027-02-15T00:00:00Z')),
      ).toEqual(['2027-01-15', '2027-02-15']);
    });

    it('should be anchor-free: a six-month window equals the union of six one-month windows', () => {
      const whole = monthly(byDate(15), '2027-01-01', '2027-06-30');
      const pieces = [
        ['2027-01-01', '2027-01-31'],
        ['2027-02-01', '2027-02-28'],
        ['2027-03-01', '2027-03-31'],
        ['2027-04-01', '2027-04-30'],
        ['2027-05-01', '2027-05-31'],
        ['2027-06-01', '2027-06-30'],
      ].flatMap(([start, end]) => monthly(byDate(15), start, end));
      expect(whole).toHaveLength(6);
      expect(pieces).toEqual(whole);
    });

    it('should return [] when start is after end', () => {
      expect(monthly(byDate(15), '2027-03-01', '2027-01-01')).toEqual([]);
    });
  });
});

describe('generateOccurrenceDates — monthly_by_weekday', () => {
  // Tuesday (dow 2) across 2027. The months of 2027 start on every weekday
  // (Fri, Mon, Mon, Thu, Sat, Tue, Thu, Sun, Wed, Fri, Mon, Wed).
  const TUESDAYS_2027: ReadonlyArray<[EventSeries.WeekOfMonth, ReadonlyArray<number>]> = [
    [1, [5, 2, 2, 6, 4, 1, 6, 3, 7, 5, 2, 7]],
    [2, [12, 9, 9, 13, 11, 8, 13, 10, 14, 12, 9, 14]],
    [3, [19, 16, 16, 20, 18, 15, 20, 17, 21, 19, 16, 21]],
    [4, [26, 23, 23, 27, 25, 22, 27, 24, 28, 26, 23, 28]],
    [-1, [26, 23, 30, 27, 25, 29, 27, 31, 28, 26, 30, 28]],
  ];

  it.each(TUESDAYS_2027)('should place ordinal %i Tuesdays on the 2027 table', (ordinal, days) => {
    expect(monthly(byWeekday(2, ordinal), '2027-01-01', '2027-12-31')).toEqual(
      days.map((day, i) => `2027-${pad(i + 1)}-${pad(day)}`),
    );
  });

  it('should distinguish 4th from last in five-Tuesday months (Mar, Jun, Aug, Nov 2027)', () => {
    const fourth = monthly(byWeekday(2, 4), '2027-01-01', '2027-12-31');
    const last = monthly(byWeekday(2, -1), '2027-01-01', '2027-12-31');
    expect(fourth).toContain('2027-03-23');
    expect(last).toContain('2027-03-30');
    expect(last).not.toContain('2027-03-23');
    for (const [month, fourthDay, lastDay] of [
      ['06', '22', '29'],
      ['08', '24', '31'],
      ['11', '23', '30'],
    ]) {
      expect(fourth).toContain(`2027-${month}-${fourthDay}`);
      expect(last).toContain(`2027-${month}-${lastDay}`);
      expect(fourth).not.toContain(`2027-${month}-${lastDay}`);
    }
  });

  it('should make 4th and last coincide in a four-Tuesday month (Feb 2027), once each', () => {
    const fourth = monthly(byWeekday(2, 4), '2027-01-01', '2027-12-31');
    const last = monthly(byWeekday(2, -1), '2027-01-01', '2027-12-31');
    expect(fourth.filter((x) => x.startsWith('2027-02-'))).toEqual(['2027-02-23']);
    expect(last.filter((x) => x.startsWith('2027-02-'))).toEqual(['2027-02-23']);
  });

  it('should skip an occurrence before a mid-month start', () => {
    const dates = monthly(byWeekday(2, 4), '2027-03-24', '2027-12-31');
    expect(dates[0]).toBe('2027-04-27');
  });

  it('should return [] when start is after end', () => {
    expect(monthly(byWeekday(2, -1), '2027-03-01', '2027-01-01')).toEqual([]);
  });
});

describe('monthly occurrences through resolveSeriesOccurrenceInstant (DST)', () => {
  const localTime = (instant: DateTime.Utc, timeZone: string) =>
    new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).format(new Date(DateTime.toEpochMillis(instant)));
  const localDate = (instant: DateTime.Utc, timeZone: string) =>
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(
      new Date(DateTime.toEpochMillis(instant)),
    );
  const resolve = (dates: ReadonlyArray<string>, timeZone: string) =>
    dates.map((date) => resolveSeriesOccurrenceInstant(date, '18:00', timeZone, true));
  const iso = (instant: DateTime.Utc) => DateTime.formatIso(instant);

  it('should keep last-Sunday occurrences at 18:00 Prague across both 2027 DST shifts', () => {
    const dates = monthly(byWeekday(0, -1), '2027-01-01', '2027-12-31');
    expect(dates).toEqual([
      '2027-01-31',
      '2027-02-28',
      '2027-03-28',
      '2027-04-25',
      '2027-05-30',
      '2027-06-27',
      '2027-07-25',
      '2027-08-29',
      '2027-09-26',
      '2027-10-31',
      '2027-11-28',
      '2027-12-26',
    ]);

    const instants = resolve(dates, 'Europe/Prague');
    const byDateStr = new Map(dates.map((date, i) => [date, iso(instants[i])]));
    expect(byDateStr.get('2027-02-28')).toBe('2027-02-28T17:00:00.000Z');
    expect(byDateStr.get('2027-03-28')).toBe('2027-03-28T16:00:00.000Z');
    expect(byDateStr.get('2027-04-25')).toBe('2027-04-25T16:00:00.000Z');
    expect(byDateStr.get('2027-09-26')).toBe('2027-09-26T16:00:00.000Z');
    expect(byDateStr.get('2027-10-31')).toBe('2027-10-31T17:00:00.000Z');
    expect(byDateStr.get('2027-11-28')).toBe('2027-11-28T17:00:00.000Z');
    for (const instant of instants) {
      expect(localTime(instant, 'Europe/Prague')).toBe('18:00');
    }
  });

  it('should resolve day 28 at 18:00 Prague to 17:00Z, 16:00Z, 16:00Z for Feb–Apr 2027', () => {
    const dates = monthly(byDate(28), '2027-02-01', '2027-04-30');
    expect(dates).toEqual(['2027-02-28', '2027-03-28', '2027-04-28']);
    expect(resolve(dates, 'Europe/Prague').map(iso)).toEqual([
      '2027-02-28T17:00:00.000Z',
      '2027-03-28T16:00:00.000Z',
      '2027-04-28T16:00:00.000Z',
    ]);
  });

  it('should keep day 31 on the local month-end at 18:00 in America/New_York across the US DST shift', () => {
    const dates = monthly(byDate(31), '2027-01-01', '2027-03-31');
    expect(dates).toEqual(['2027-01-31', '2027-02-28', '2027-03-31']);
    const instants = resolve(dates, 'America/New_York');
    expect(instants.map(iso)).toEqual([
      '2027-01-31T23:00:00.000Z',
      '2027-02-28T23:00:00.000Z',
      '2027-03-31T22:00:00.000Z',
    ]);
    expect(instants.map((i) => localDate(i, 'America/New_York'))).toEqual(dates);
    for (const instant of instants) {
      expect(localTime(instant, 'America/New_York')).toBe('18:00');
    }
  });
});

describe('computeHorizonEnd', () => {
  const NOW = '2027-01-27T10:00:00Z';
  const lastTuesday = byWeekday(2, -1);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const horizon = (params: {
    recurrence: EventSeries.Recurrence;
    seriesStartDate?: DateTime.Utc;
    seriesEndDate?: DateTime.Utc | null;
    horizonDays: number;
  }) =>
    DateTime.formatIso(
      computeHorizonEnd({
        recurrence: params.recurrence,
        seriesStartDate: params.seriesStartDate ?? d('2027-01-01'),
        seriesEndDate: params.seriesEndDate ?? null,
        horizonDays: params.horizonDays,
      }),
    );

  it('should return now + horizonDays for a weekly series, unchanged', () => {
    expect(horizon({ recurrence: { frequency: 'weekly', daysOfWeek: [2] }, horizonDays: 30 })).toBe(
      '2027-02-26T10:00:00.000Z',
    );
  });

  it('should extend a monthly series to its next occurrence when the window is shorter', () => {
    expect(horizon({ recurrence: lastTuesday, horizonDays: 1 })).toBe('2027-02-23T00:00:00.000Z');
  });

  it('should keep the plain window when it already contains the next occurrence', () => {
    const end = horizon({ recurrence: lastTuesday, horizonDays: 30 });
    expect(end).toBe('2027-02-26T10:00:00.000Z');
    const dates = monthly(lastTuesday, '2027-01-27', DateTime.makeUnsafe(end));
    expect(dates).toEqual(['2027-02-23']);
    expect(dates).not.toContain('2027-03-30');
  });

  it('should still cap a monthly series at its end date (zero occurrences)', () => {
    const end = horizon({
      recurrence: lastTuesday,
      horizonDays: 1,
      seriesEndDate: d('2027-02-10'),
    });
    expect(end).toBe('2027-02-10T00:00:00.000Z');
    expect(monthly(lastTuesday, '2027-01-27', DateTime.makeUnsafe(end))).toEqual([]);
  });

  it('should materialise the first occurrence of a future-start series immediately (R4)', () => {
    expect(
      horizon({ recurrence: lastTuesday, horizonDays: 1, seriesStartDate: d('2027-06-01') }),
    ).toBe('2027-06-29T00:00:00.000Z');
  });

  it('should extend day 31 to the clamped 28 Feb', () => {
    vi.setSystemTime(new Date('2027-02-01T10:00:00Z'));
    expect(horizon({ recurrence: byDate(31), horizonDays: 1 })).toBe('2027-02-28T00:00:00.000Z');
  });
});
