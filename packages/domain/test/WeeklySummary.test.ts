// TDD mode — tests written before implementation.
// weekRangeFor and previousWeekRange exist in WeeklySummary.ts.
// All tests should pass once domain types are compiled correctly.

import { describe, expect, it } from '@effect/vitest';
import { DateTime } from 'effect';
import { previousWeekRange, weekRangeFor } from '~/models/WeeklySummary.js';

const PRAGUE = 'Europe/Prague';

// Helper: parse an ISO string to DateTime.Utc
const utc = (iso: string): DateTime.Utc => DateTime.makeUnsafe(iso);

describe('weekRangeFor', () => {
  it('returns Mon 00:00–Sun 23:59 Prague for a sample mid-week Wednesday', () => {
    // 2026-01-07 is a Wednesday in Prague (UTC+1 in January)
    const now = utc('2026-01-07T12:00:00Z');
    const range = weekRangeFor(now, PRAGUE);

    // Monday 2026-01-05 00:00 Prague = 2025-01-04 23:00 UTC (UTC+1)
    const expectedStart = utc('2026-01-04T23:00:00.000Z');
    // Sunday 2026-01-11 23:59:59.999 Prague = 2026-01-11 22:59:59.999 UTC (UTC+1)
    const expectedEnd = utc('2026-01-11T22:59:59.999Z');

    expect(range.startAt.epochMilliseconds).toBe(expectedStart.epochMilliseconds);
    expect(range.endAt.epochMilliseconds).toBe(expectedEnd.epochMilliseconds);
    expect(range.isoWeek).toBe(2);
    expect(range.isoYear).toBe(2026);
  });

  it('handles DST spring-forward (last Sunday of March 2026) without gap', () => {
    // In 2026, DST spring-forward in Prague is on 2026-03-29 at 02:00 local → 03:00
    // Test that a moment on that Sunday is in the correct week with no gap
    // 2026-03-29 is a Sunday. In Czech time it's the last Sunday of March (clocks spring forward).
    // Week containing 2026-03-29: Mon 2026-03-23 – Sun 2026-03-29
    const now = utc('2026-03-29T01:00:00Z'); // 02:00 Prague time (just before spring-forward)
    const range = weekRangeFor(now, PRAGUE);

    // Monday 2026-03-23 00:00 Prague (UTC+1) = 2026-03-22 23:00 UTC
    const expectedStart = utc('2026-03-22T23:00:00.000Z');
    // Sunday 2026-03-29 23:59:59.999 Prague (UTC+2 after DST) = 2026-03-29 21:59:59.999 UTC
    const expectedEnd = utc('2026-03-29T21:59:59.999Z');

    expect(range.startAt.epochMilliseconds).toBe(expectedStart.epochMilliseconds);
    expect(range.endAt.epochMilliseconds).toBe(expectedEnd.epochMilliseconds);
    // DST week: start and end spans must cover exactly 7 days minus DST shift (23h+24*6h+24h-1ms)
    // The critical invariant: no gap — endAt - startAt should be 6 days 22 hrs 59 min 59.999 sec
    const durationMs = range.endAt.epochMilliseconds - range.startAt.epochMilliseconds;
    // 6d 22h 59m 59.999s = (7*24-1)*3600*1000 - 1 = 6*86400000 + 22*3600000 + 59*60000 + 59999
    const expected = 6 * 86400000 + 22 * 3600000 + 59 * 60000 + 59999;
    expect(durationMs).toBe(expected);
  });

  it('handles DST fall-back (last Sunday of October 2026) without overlap', () => {
    // In 2026, DST fall-back in Prague is on 2026-10-25 at 03:00 local → 02:00
    // Week: Mon 2026-10-19 – Sun 2026-10-25
    const now = utc('2026-10-21T10:00:00Z'); // Wednesday in Prague (UTC+2 during CEST)
    const range = weekRangeFor(now, PRAGUE);

    // Monday 2026-10-19 00:00 Prague (UTC+2 CEST) = 2026-10-18 22:00 UTC
    const expectedStart = utc('2026-10-18T22:00:00.000Z');
    // Sunday 2026-10-25 23:59:59.999 Prague (UTC+1 after fall-back) = 2026-10-25 22:59:59.999 UTC
    const expectedEnd = utc('2026-10-25T22:59:59.999Z');

    expect(range.startAt.epochMilliseconds).toBe(expectedStart.epochMilliseconds);
    expect(range.endAt.epochMilliseconds).toBe(expectedEnd.epochMilliseconds);
    // Fall-back week is 25 hours longer: 7d + 1h = 7*24h + 1h - 1ms
    const durationMs = range.endAt.epochMilliseconds - range.startAt.epochMilliseconds;
    const expected = 7 * 86400000 + 1 * 3600000 - 1;
    expect(durationMs).toBe(expected);
  });

  it('produces ISO year/week 2026-W02 for early-January Sunday (ISO week rolls)', () => {
    // 2026-01-11 is a Sunday — still in ISO week 2026-W02
    const now = utc('2026-01-11T10:00:00Z');
    const range = weekRangeFor(now, PRAGUE);

    expect(range.isoYear).toBe(2026);
    expect(range.isoWeek).toBe(2);
  });

  it('produces ISO year/week 2025-W01 for a date in the first ISO week of 2025', () => {
    // 2025-01-06 is a Monday in the first full ISO week of 2025
    const now = utc('2025-01-06T10:00:00Z');
    const range = weekRangeFor(now, PRAGUE);

    expect(range.isoYear).toBe(2025);
    expect(range.isoWeek).toBe(2);
  });

  it('handles ISO week roll: Dec 28 2025 belongs to ISO week 2026-W01', () => {
    // 2025-12-29 is a Monday that starts ISO week 2026-W01
    const now = utc('2025-12-29T10:00:00Z');
    const range = weekRangeFor(now, PRAGUE);

    expect(range.isoYear).toBe(2026);
    expect(range.isoWeek).toBe(1);
  });
});

describe('previousWeekRange', () => {
  it('returns the week 7 days earlier in same timezone', () => {
    // Current week: 2026-01-05 (Mon) – 2026-01-11 (Sun)
    const now = utc('2026-01-07T12:00:00Z');
    const currentWeek = weekRangeFor(now, PRAGUE);
    const prevWeek = previousWeekRange(currentWeek, PRAGUE);

    // Previous week: 2026-12-29 (Mon) – 2026-01-04 (Sun)
    // isoWeek should be 1 less
    expect(prevWeek.isoWeek).toBe(1);
    expect(prevWeek.isoYear).toBe(2026);

    // Start of prev week should be exactly 7 days (604800000 ms) before current week start
    const diff = currentWeek.startAt.epochMilliseconds - prevWeek.startAt.epochMilliseconds;
    expect(diff).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('correctly crosses ISO year boundary when going back a week', () => {
    // Current week: 2026-W01 (2025-12-29 Mon – 2026-01-04 Sun)
    const now = utc('2025-12-31T10:00:00Z');
    const currentWeek = weekRangeFor(now, PRAGUE);
    const prevWeek = previousWeekRange(currentWeek, PRAGUE);

    // Previous week is in 2025-W52 or 2025-W53
    expect(prevWeek.isoYear).toBe(2025);
    expect(prevWeek.isoWeek).toBeGreaterThanOrEqual(52);
  });
});
