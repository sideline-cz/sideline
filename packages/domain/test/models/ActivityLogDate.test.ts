import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { vi } from 'vitest';
import { parseLoggedAtDateInPrague } from '~/models/ActivityLogDate.js';

beforeAll(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-05-21T12:00:00Z'));
});

afterAll(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const formatPrague = (date: Date): string =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(date);

const addDays = (base: Date, days: number): Date => new Date(base.getTime() + days * 86400000);

const todayPrague = (): string => formatPrague(new Date());

/**
 * Returns true if the given YYYY-MM-DD date falls within the CEST window
 * (Prague is UTC+2). CEST runs from the last Sunday of March through the last
 * Sunday of October. At noon UTC+2 Prague is UTC+2; at noon UTC+1 it is UTC+1.
 * We probe using Intl so the check is accurate regardless of DST transitions.
 */
const isCEST = (dateStr: string): boolean => {
  const d = new Date(`${dateStr}T12:00:00Z`);
  const offsetPart =
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'Europe/Prague',
      timeZoneName: 'shortOffset',
    })
      .formatToParts(d)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return offsetPart.includes('+2');
};

const dateOffset = (days: number): string => {
  // Compute a Prague calendar date that is `days` days offset from today-Prague.
  const todayStr = todayPrague();
  const [y, m, d] = todayStr.split('-').map(Number);
  const todayUTC = new Date(Date.UTC(y, m - 1, d));
  const target = addDays(todayUTC, days);
  // Return as YYYY-MM-DD using UTC parts (we built with Date.UTC so they align)
  const ty = target.getUTCFullYear();
  const tm = String(target.getUTCMonth() + 1).padStart(2, '0');
  const td = String(target.getUTCDate()).padStart(2, '0');
  return `${ty}-${tm}-${td}`;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('parseLoggedAtDateInPrague', () => {
  it('returns Some for a valid YYYY-MM-DD (today) whose Prague format matches the input and is anchored at Prague noon', () => {
    const today = todayPrague();
    const result = parseLoggedAtDateInPrague(today);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe(today);
      const expectedUTCHour = isCEST(today) ? 10 : 11;
      expect(result.value.getUTCHours()).toBe(expectedUTCHour);
      expect(result.value.getUTCMinutes()).toBe(0);
      expect(result.value.getUTCSeconds()).toBe(0);
    }
  });

  it('returns Some for a date 100 days in the past, anchored at Prague noon', () => {
    const past = dateOffset(-100);
    const result = parseLoggedAtDateInPrague(past);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe(past);
      const expectedUTCHour = isCEST(past) ? 10 : 11;
      expect(result.value.getUTCHours()).toBe(expectedUTCHour);
      expect(result.value.getUTCMinutes()).toBe(0);
      expect(result.value.getUTCSeconds()).toBe(0);
    }
  });

  it('returns Some for a date 100 days in the future, anchored at Prague noon', () => {
    const future = dateOffset(100);
    const result = parseLoggedAtDateInPrague(future);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe(future);
      const expectedUTCHour = isCEST(future) ? 10 : 11;
      expect(result.value.getUTCHours()).toBe(expectedUTCHour);
      expect(result.value.getUTCMinutes()).toBe(0);
      expect(result.value.getUTCSeconds()).toBe(0);
    }
  });

  it("returns Some for the real leap day '2028-02-29' (within ±730d of 2026-05-21)", () => {
    // 2028 is a leap year; 2028-02-29 is ~648 days in the future from 2026-05-21 → within bounds.
    const result = parseLoggedAtDateInPrague('2028-02-29');
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe('2028-02-29');
    }
  });

  it("returns None for the non-leap date '2027-02-29' (Feb 29 doesn't exist in 2027)", () => {
    // 2027 is not a leap year — Feb 29 is an invalid calendar date.
    const result = parseLoggedAtDateInPrague('2027-02-29');
    expect(Option.isNone(result)).toBe(true);
  });

  it('returns None for the non-leap date 2025-02-29', () => {
    const result = parseLoggedAtDateInPrague('2025-02-29');
    expect(Option.isNone(result)).toBe(true);
  });

  it('returns None for 2026-13-01 (invalid month)', () => {
    const result = parseLoggedAtDateInPrague('2026-13-01');
    expect(Option.isNone(result)).toBe(true);
  });

  it('returns None for 2026-05-32 (invalid day)', () => {
    const result = parseLoggedAtDateInPrague('2026-05-32');
    expect(Option.isNone(result)).toBe(true);
  });

  it("returns None for the empty string ''", () => {
    const result = parseLoggedAtDateInPrague('');
    expect(Option.isNone(result)).toBe(true);
  });

  it("returns None for the malformed string 'not-a-date'", () => {
    const result = parseLoggedAtDateInPrague('not-a-date');
    expect(Option.isNone(result)).toBe(true);
  });

  it("returns None for '2026-5-1' (missing zero-padding)", () => {
    const result = parseLoggedAtDateInPrague('2026-5-1');
    expect(Option.isNone(result)).toBe(true);
  });

  it('DST spring-forward (Prague): 2026-03-29 -> Some; result is anchored at 10:00 UTC (CEST noon) and Prague-format is 2026-03-29', () => {
    const dateStr = '2026-03-29';
    const result = parseLoggedAtDateInPrague(dateStr);
    // 2026-03-29 is within ±730 days of 2026-05-21 (~53 days ago) so it should be Some.
    // 2026-03-29 is the day clocks spring forward to CEST (UTC+2), so Prague noon = 10:00 UTC.
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.getUTCHours()).toBe(10);
      expect(result.value.getUTCMinutes()).toBe(0);
      expect(result.value.getUTCSeconds()).toBe(0);
      expect(formatPrague(result.value)).toBe(dateStr);
    }
  });

  it('DST fall-back (Prague): 2026-10-25 -> Some; result is anchored at 11:00 UTC (CET noon) and Prague-format is 2026-10-25', () => {
    const dateStr = '2026-10-25';
    const result = parseLoggedAtDateInPrague(dateStr);
    // 2026-10-25 is ~157 days in the future from 2026-05-21 so it should be Some.
    // 2026-10-25 is the day clocks fall back to CET (UTC+1), so Prague noon = 11:00 UTC.
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value.getUTCHours()).toBe(11);
      expect(result.value.getUTCMinutes()).toBe(0);
      expect(result.value.getUTCSeconds()).toBe(0);
      expect(formatPrague(result.value)).toBe(dateStr);
    }
  });

  it('returns None for a date more than 730 days in the future', () => {
    const beyond = dateOffset(731);
    const result = parseLoggedAtDateInPrague(beyond);
    expect(Option.isNone(result)).toBe(true);
  });

  it('returns None for a date more than 730 days in the past', () => {
    const beyond = dateOffset(-731);
    const result = parseLoggedAtDateInPrague(beyond);
    expect(Option.isNone(result)).toBe(true);
  });

  it('returns Some for a date exactly 730 days in the future (boundary inclusive)', () => {
    const bound = dateOffset(730);
    const result = parseLoggedAtDateInPrague(bound);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe(bound);
    }
  });

  it('returns Some for a date exactly 730 days in the past (boundary inclusive)', () => {
    const bound = dateOffset(-730);
    const result = parseLoggedAtDateInPrague(bound);
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(formatPrague(result.value)).toBe(bound);
    }
  });
});
