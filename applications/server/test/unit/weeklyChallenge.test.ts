// Unit tests for the WeeklyChallenge helpers (timezone-aware date math).
//
// Key invariant: a Postgres `DATE` column materialises as a JS `Date` pinned
// to UTC midnight. We must read its calendar day from UTC components, not
// from a timezone-local view, or western offsets shift it to the previous
// day (e.g. America/Los_Angeles turns 2026-03-09 into 2026-03-08).

import { describe, expect, it } from '@effect/vitest';
import {
  currentTeamMondayDateString,
  formatDateInTz,
  formatDateUtc,
  scheduleAtNineAm,
  weekStartDateString,
} from '~/helpers/weeklyChallenge.js';

describe('formatDateInTz', () => {
  it('formats a UTC date as YYYY-MM-DD in the given timezone', () => {
    // 2026-03-09 00:00 UTC → in Europe/Prague that is 2026-03-09 01:00, so still the 9th.
    const date = new Date('2026-03-09T00:00:00Z');
    expect(formatDateInTz(date, 'Europe/Prague')).toBe('2026-03-09');
  });

  it('crosses date boundaries when timezone differs from UTC', () => {
    // 2026-03-09 23:30 UTC → in Pacific/Auckland that is the 10th already.
    const date = new Date('2026-03-09T23:30:00Z');
    expect(formatDateInTz(date, 'Pacific/Auckland')).toBe('2026-03-10');
    expect(formatDateInTz(date, 'America/Los_Angeles')).toBe('2026-03-09');
  });
});

describe('formatDateUtc', () => {
  it('reads the calendar day from UTC components', () => {
    const date = new Date('2026-03-09T00:00:00Z');
    expect(formatDateUtc(date)).toBe('2026-03-09');
  });

  it('is timezone-agnostic — same UTC instant always yields the same string', () => {
    // A Postgres DATE for "2026-03-09" always comes back as 2026-03-09T00:00:00Z.
    // Reading its UTC components must yield "2026-03-09" regardless of the
    // server's local timezone. This is the whole point of the helper.
    const date = new Date('2026-03-09T00:00:00Z');
    expect(formatDateUtc(date)).toBe('2026-03-09');
  });
});

describe('weekStartDateString', () => {
  it('returns the UTC calendar day of a DATE value', () => {
    // 2026-03-09 UTC midnight stays on the 9th regardless of team tz.
    const date = new Date('2026-03-09T00:00:00Z');
    expect(weekStartDateString(date, 'Europe/Prague')).toBe('2026-03-09');
    expect(weekStartDateString(date, 'America/Los_Angeles')).toBe('2026-03-09');
    expect(weekStartDateString(date, 'Pacific/Auckland')).toBe('2026-03-09');
  });

  it('does NOT shift the day for western offsets (regression: DATE timezone bug)', () => {
    // Before the fix, formatting 2026-03-09T00:00:00Z in America/Los_Angeles
    // would return 2026-03-08, breaking current-week marking for LA teams.
    const date = new Date('2026-03-09T00:00:00Z');
    expect(weekStartDateString(date, 'America/Los_Angeles')).toBe('2026-03-09');
  });
});

describe('currentTeamMondayDateString', () => {
  it('returns a YYYY-MM-DD string', () => {
    const result = currentTeamMondayDateString('Europe/Prague');
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe('scheduleAtNineAm', () => {
  it('produces a timestamp at 09:00 in the team timezone', () => {
    // Monday 2026-03-09 at 09:00 Europe/Prague is 08:00 UTC (winter, CET = UTC+1).
    const weekStart = new Date('2026-03-09T00:00:00Z');
    const result = scheduleAtNineAm(weekStart, 'Europe/Prague');
    const iso = result.toISOString();
    expect(iso).toBe('2026-03-09T08:00:00.000Z');
  });

  it('produces a 09:00 wall-clock time in a west-of-UTC zone on the SAME calendar day', () => {
    // Regression for the DATE-shift bug: scheduling on Monday 2026-03-09 for an
    // America/Los_Angeles team must result in 09:00 on March 9 LA wall-clock,
    // NOT 09:00 on March 8 LA (the previous-day slip a tz-format helper would
    // produce when reading UTC-midnight 2026-03-09 in LA).
    const weekStart = new Date('2026-03-09T00:00:00Z');
    const result = scheduleAtNineAm(weekStart, 'America/Los_Angeles');
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Los_Angeles',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(result);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;
    expect(get('hour')).toBe('09');
    expect(get('minute')).toBe('00');
    expect(get('year')).toBe('2026');
    expect(get('month')).toBe('03');
    expect(get('day')).toBe('09');
  });
});
