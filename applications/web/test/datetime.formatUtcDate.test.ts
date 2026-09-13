// Cross-timezone coverage for `formatUtcDate`/`formatLocalDate`, plan §7.8 PR 5.
// A dedicated file (rather than adding to `datetime.test.ts`) because each test
// here pins a DIFFERENT zone, while `datetime.test.ts` pins Europe/Prague for the
// whole file.
//
// This file used to justify itself by saying `datetime.test.ts` assumes the
// ambient TZ. It did — and that WAS the bug: its DST case passed in Prague and in
// CI (UTC) and failed on any UTC+2 machine. No web test may assume the ambient TZ.
// The pinning helper lives in `./tz.ts`; use it rather than hand-rolling the
// save/restore, which has a trap (see that file).
//
// `formatUtcDate` backs the all-day dashboard card's fallback path (an older
// server that hasn't shipped `startDate`/`todayLocalDate` yet, plan §11.2/§17):
// it must read the UTC calendar date off the instant regardless of the
// viewer's own timezone, never the browser-local one.

import { describe, expect, it } from '@effect/vitest';
import { DateTime } from 'effect';
import { formatLocalDate, formatUtcDate } from '~/lib/datetime.js';
import { withTz } from './tz.js';

describe('formatUtcDate — timezone independence (plan §7.8)', () => {
  it('formats a noon-UTC instant as its UTC calendar date under Europe/Prague', () => {
    withTz('Europe/Prague', () => {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    });
  });

  it('formats the same instant identically under Pacific/Auckland (UTC+12/+13) — the case that catches a local read', () => {
    withTz('Pacific/Auckland', () => {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    });
  });

  it('formatLocalDate DIFFERS from formatUtcDate for the same instant under Auckland — proves the pin actually took effect (otherwise the two cases above would pass vacuously)', () => {
    withTz('Pacific/Auckland', () => {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatLocalDate(dt)).not.toBe(formatUtcDate(dt));
      expect(formatLocalDate(dt)).toBe('2026-07-16');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    });
  });
});
