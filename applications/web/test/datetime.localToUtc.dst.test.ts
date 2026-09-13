// Cross-timezone behaviour of `localToUtc` around DST transitions.
//
// `localToUtc` builds `new Date(y, mo - 1, d, h, mi)` — a LOCAL-time construction — so what it
// returns depends on where the viewer's DST gap falls, and that is NOT the same wall-clock hour in
// every zone. The EU spring-forward happens at a fixed INSTANT (01:00 UTC), so it lands on 02:00
// local at UTC+1 and on 03:00 local at UTC+2. A wall-clock time that exists in one zone can be
// missing in the other.
//
// That is what made `datetime.test.ts`'s spring-forward case flaky: it asserted an end time of
// 03:30, which is real in Prague but inside the gap in Helsinki, where it normalizes forward to
// 04:30. It passed in CI (UTC, no DST) and on Prague laptops and failed on UTC+2 machines.
//
// A dedicated file because each test here pins a DIFFERENT zone, whereas `datetime.test.ts` pins
// Europe/Prague for the whole file. These are characterization tests: they document what the code
// already does, so nobody "fixes" correct behaviour later.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Option } from 'effect';
import {
  formatEventDateRange,
  formatLocalDate,
  formatLocalTime,
  formatUtcTime,
  localToUtc,
} from '~/lib/datetime.js';
import { withTz } from './tz.js';

describe('localToUtc — DST gap behaviour across timezones', () => {
  it('Europe/Prague: 02:30 is inside the UTC+1 gap and normalizes forward to 03:30', () => {
    withTz('Europe/Prague', () => {
      const dt = localToUtc('2026-03-29', '02:30');
      // The user asked for a wall-clock time that does not exist. JS picks the next real instant.
      expect(formatLocalTime(dt)).toBe('03:30');
      expect(formatLocalDate(dt)).toBe('2026-03-29');
      expect(formatUtcTime(dt)).toBe('01:30');
    });
  });

  it('Europe/Prague: 03:30 exists and round-trips unchanged', () => {
    withTz('Europe/Prague', () => {
      const dt = localToUtc('2026-03-29', '03:30');
      expect(formatLocalTime(dt)).toBe('03:30');
      expect(formatUtcTime(dt)).toBe('01:30');
    });
  });

  // The regression test for this ticket.
  it('Europe/Helsinki: 03:30 is inside the UTC+2 gap and normalizes forward to 04:30', () => {
    withTz('Europe/Helsinki', () => {
      const dt = localToUtc('2026-03-29', '03:30');
      expect(formatLocalTime(dt)).toBe('04:30');
      expect(formatLocalDate(dt)).toBe('2026-03-29');
      // Same instant as Prague's 03:30 — only the local label differs.
      expect(formatUtcTime(dt)).toBe('01:30');
    });
  });

  it('Europe/Helsinki: formatEventDateRange reporting 04:30 is CORRECT — the gap moved, the function did not', () => {
    withTz('Europe/Helsinki', () => {
      const start = localToUtc('2026-03-29', '01:30');
      const end = localToUtc('2026-03-29', '03:30');
      const result = formatEventDateRange(start, Option.some(end));
      expect(result.sameDay).toBe(true);
      // If you are here because you want this to say '03:30': don't. The end instant genuinely
      // falls at 04:30 local in this zone, because 03:30 does not exist on this date here.
      // `formatEventDateRange` reads each instant's own offset, which is what it should do.
      expect(result.end).toStrictEqual(Option.some('04:30'));
    });
  });

  it('Europe/Prague: the fall-back hour is ambiguous and resolves to the FIRST (CEST) occurrence', () => {
    withTz('Europe/Prague', () => {
      const dt = localToUtc('2026-10-25', '02:30');
      // 02:30 local happens twice: once at 00:30Z (CEST, UTC+2) and again at 01:30Z (CET, UTC+1).
      // Round-tripping through the local label cannot tell them apart, so assert the instant.
      expect(formatUtcTime(dt)).toBe('00:30');
      expect(formatLocalTime(dt)).toBe('02:30');
    });
  });

  it('Australia/Lord_Howe: a HALF-hour DST shift — offsets are not always whole hours', () => {
    withTz('Australia/Lord_Howe', () => {
      // Lord Howe moves by 30 minutes (UTC+10:30 -> UTC+11:00) at 02:00 on 2026-10-04, so the gap
      // is only 02:00-02:29. Both of these land on the same instant.
      const inGap = localToUtc('2026-10-04', '02:15');
      const atEdge = localToUtc('2026-10-04', '02:45');
      expect(Number(DateTime.toEpochMillis(inGap))).toBe(Number(DateTime.toEpochMillis(atEdge)));
      expect(formatLocalTime(inGap)).toBe('02:45');
      expect(formatUtcTime(inGap)).toBe('15:45');
    });
  });

  it('proves the pins took effect — the same wall-clock input differs by zone', () => {
    // Without this, every test above could pass vacuously if `process.env.TZ` mutation silently
    // stopped working (a Node upgrade, a pool change) and everything ran in one ambient zone.
    const prague = withTz('Europe/Prague', () =>
      formatLocalTime(localToUtc('2026-03-29', '03:30')),
    );
    const helsinki = withTz('Europe/Helsinki', () =>
      formatLocalTime(localToUtc('2026-03-29', '03:30')),
    );
    expect(prague).not.toBe(helsinki);
    expect(prague).toBe('03:30');
    expect(helsinki).toBe('04:30');
  });
});
