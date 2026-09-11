// Cross-timezone coverage for `formatUtcDate`/`formatLocalDate`, plan §7.8 PR 5.
// A dedicated file (rather than adding to `datetime.test.ts`) so mutating
// `process.env.TZ` here can never leak into that file's own assertions, which
// assume the ambient/default TZ.
//
// `formatUtcDate` backs the all-day dashboard card's fallback path (an older
// server that hasn't shipped `startDate`/`todayLocalDate` yet, plan §11.2/§17):
// it must read the UTC calendar date off the instant regardless of the
// viewer's own timezone, never the browser-local one.

import { describe, expect, it } from '@effect/vitest';
import { DateTime } from 'effect';
import { formatLocalDate, formatUtcDate } from '~/lib/datetime.js';

describe('formatUtcDate — timezone independence (plan §7.8)', () => {
  it('formats a noon-UTC instant as its UTC calendar date under Europe/Prague', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Europe/Prague';
    try {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('formats the same instant identically under Pacific/Auckland (UTC+12/+13) — the case that catches a local read', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    } finally {
      process.env.TZ = originalTz;
    }
  });

  it('formatLocalDate DIFFERS from formatUtcDate for the same instant under Auckland — proves the pin actually took effect (otherwise the two cases above would pass vacuously)', () => {
    const originalTz = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
    try {
      const dt = DateTime.makeUnsafe('2026-07-15T12:00:00Z');
      expect(formatLocalDate(dt)).not.toBe(formatUtcDate(dt));
      expect(formatLocalDate(dt)).toBe('2026-07-16');
      expect(formatUtcDate(dt)).toBe('2026-07-15');
    } finally {
      process.env.TZ = originalTz;
    }
  });
});
