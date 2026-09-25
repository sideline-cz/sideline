import { afterAll, beforeAll, describe, expect, it } from '@effect/vitest';
import { DateTime, Option } from 'effect';
import {
  dateOnlyToLocalEndOfDay,
  formatEventDateRange,
  formatLocalDate,
  formatLocalTime,
  formatTimeInZone,
  formatUtcTime,
  localToUtc,
} from '~/lib/datetime.js';

// Every assertion in this file is a wall-clock assertion, and `localToUtc` is a LOCAL-time
// constructor — so the file is meaningless without a pinned zone. It used to have none, which is
// how the spring-forward case below shipped broken: it assumes UTC+1, and CI (UTC) plus a Prague
// dev machine both agree with it, while any UTC+2 machine does not. See `datetime.localToUtc.dst.test.ts`.
//
// Europe/Prague — any CET zone would do (Berlin, Paris, Warsaw...); Prague because it is ours.
// It is NOT UTC on purpose: with no DST at all the transition cases below decay into ordinary
// spans and stop testing what their names claim. That decay is precisely why CI never caught this.
// This overrides the project-wide UTC default in `vitest.config.ts` for this file only.
const originalTz = process.env.TZ;
beforeAll(() => {
  process.env.TZ = 'Europe/Prague';
});
afterAll(() => {
  if (originalTz === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTz;
  }
});

describe('datetime', () => {
  describe('localToUtc + formatLocalDate + formatLocalTime roundtrip', () => {
    it('roundtrips a standard afternoon datetime', () => {
      const dt = localToUtc('2024-06-15', '14:30');
      expect(formatLocalDate(dt)).toBe('2024-06-15');
      expect(formatLocalTime(dt)).toBe('14:30');
    });

    it('roundtrips a near-midnight datetime', () => {
      const dt = localToUtc('2024-12-31', '23:45');
      expect(formatLocalDate(dt)).toBe('2024-12-31');
      expect(formatLocalTime(dt)).toBe('23:45');
    });

    it('roundtrips midnight', () => {
      const dt = localToUtc('2024-03-10', '00:00');
      expect(formatLocalDate(dt)).toBe('2024-03-10');
      expect(formatLocalTime(dt)).toBe('00:00');
    });
  });

  describe('formatLocalDate', () => {
    it('output matches YYYY-MM-DD format', () => {
      const dt = localToUtc('2024-06-15', '14:30');
      expect(formatLocalDate(dt)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });

  describe('formatLocalTime', () => {
    it('output matches HH:mm format', () => {
      const dt = localToUtc('2024-06-15', '14:30');
      expect(formatLocalTime(dt)).toMatch(/^\d{2}:\d{2}$/);
    });

    it('pads single-digit hours and minutes', () => {
      const dt = localToUtc('2024-01-01', '09:05');
      expect(formatLocalDate(dt)).toBe('2024-01-01');
      expect(formatLocalTime(dt)).toBe('09:05');
    });
  });

  // These two used the US transition dates (2024-03-10 / 2024-11-03). EU's 2024 transitions were
  // 2024-03-31 and 2024-10-27, so under any European zone they crossed nothing and asserted
  // nothing. Re-dated to the EU transitions, with a UTC-side guard so they cannot pass vacuously.
  describe('DST edge cases', () => {
    it('roundtrips the instant right after the spring-forward gap', () => {
      const dt = localToUtc('2026-03-29', '03:00');
      expect(formatLocalDate(dt)).toBe('2026-03-29');
      expect(formatLocalTime(dt)).toBe('03:00');
      // 03:00 local is the first instant of CEST (UTC+2); a CET (+1) reading would be 02:00Z.
      expect(formatUtcTime(dt)).toBe('01:00');
    });

    it('roundtrips a fall-back ambiguous datetime', () => {
      const dt = localToUtc('2026-10-25', '02:30');
      expect(formatLocalDate(dt)).toBe('2026-10-25');
      expect(formatLocalTime(dt)).toBe('02:30');
      // 02:30 local happens TWICE that day. `localToUtc` resolves it to the first (CEST, UTC+2)
      // occurrence; the second would be 01:30Z. Pinned so the choice is deliberate, not accidental.
      expect(formatUtcTime(dt)).toBe('00:30');
    });
  });
});

describe('formatEventDateRange', () => {
  it('end is None returns None end and sameDay true', () => {
    const start = localToUtc('2026-05-22', '10:00');
    const result = formatEventDateRange(start, Option.none());
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('10:00');
    expect(result.end).toStrictEqual(Option.none());
    expect(result.sameDay).toBe(true);
  });

  it('end same day later time returns HH:mm end and sameDay true', () => {
    const start = localToUtc('2026-05-22', '10:00');
    const end = localToUtc('2026-05-22', '12:30');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('10:00');
    expect(result.end).toStrictEqual(Option.some('12:30'));
    expect(result.sameDay).toBe(true);
  });

  it('end same day same time (instant) returns HH:mm end and sameDay true', () => {
    const start = localToUtc('2026-05-22', '10:00');
    const end = localToUtc('2026-05-22', '10:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('10:00');
    expect(result.end).toStrictEqual(Option.some('10:00'));
    expect(result.sameDay).toBe(true);
  });

  it('end next day returns YYYY-MM-DD HH:mm end and sameDay false', () => {
    const start = localToUtc('2026-05-22', '22:00');
    const end = localToUtc('2026-05-23', '02:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('22:00');
    expect(result.end).toStrictEqual(Option.some('2026-05-23 02:00'));
    expect(result.sameDay).toBe(false);
  });

  it('end multiple days later returns sameDay false', () => {
    const start = localToUtc('2026-05-22', '10:00');
    const end = localToUtc('2026-05-25', '18:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('10:00');
    expect(result.end).toStrictEqual(Option.some('2026-05-25 18:00'));
    expect(result.sameDay).toBe(false);
  });

  it('end at exact midnight next day returns sameDay false', () => {
    const start = localToUtc('2026-05-22', '23:30');
    const end = localToUtc('2026-05-23', '00:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('23:30');
    expect(result.end).toStrictEqual(Option.some('2026-05-23 00:00'));
    expect(result.sameDay).toBe(false);
  });

  it('end at 23:59 same day returns sameDay true and HH:mm end', () => {
    const start = localToUtc('2026-05-22', '00:00');
    const end = localToUtc('2026-05-22', '23:59');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-05-22');
    expect(result.startTime).toBe('00:00');
    expect(result.end).toStrictEqual(Option.some('23:59'));
    expect(result.sameDay).toBe(true);
  });

  it('DST spring-forward same day returns sameDay true and HH:mm end', () => {
    const start = localToUtc('2026-03-29', '01:30');
    const end = localToUtc('2026-03-29', '03:30');

    // Guards that the Europe/Prague pin took effect. Without them the case passes vacuously under
    // UTC (01:30/03:30, 2h) and fails under UTC+2 (23:30/01:30, 2h) — which was the original bug.
    // Prague is the only one of the three that yields these values.
    expect(formatUtcTime(start)).toBe('00:30');
    expect(formatUtcTime(end)).toBe('01:30');
    // Two wall-clock hours apart, but only ONE real hour: 02:00-02:59 local never happens.
    // `formatEventDateRange` must resolve each instant's own offset to get this right.
    expect(Number(DateTime.toEpochMillis(end)) - Number(DateTime.toEpochMillis(start))).toBe(
      3_600_000,
    );

    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-03-29');
    expect(result.startTime).toBe('01:30');
    expect(result.sameDay).toBe(true);
    expect(result.end).toStrictEqual(Option.some('03:30'));
  });

  it('DST fall-back same day returns sameDay true and HH:mm end', () => {
    const start = localToUtc('2026-10-25', '00:30');
    const end = localToUtc('2026-10-25', '03:30');

    // Mirror of the spring-forward guards. Note the start's UTC instant lands on the 24th: it is
    // still CEST (UTC+2) at that point, while the end has already fallen back to CET (UTC+1).
    expect(formatUtcTime(start)).toBe('22:30');
    expect(formatUtcTime(end)).toBe('02:30');
    // Three wall-clock hours apart, but FOUR real hours: 02:00-02:59 local happens twice.
    // Catches any future refactor that derived the end's offset from the start's.
    expect(Number(DateTime.toEpochMillis(end)) - Number(DateTime.toEpochMillis(start))).toBe(
      4 * 3_600_000,
    );

    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-10-25');
    expect(result.startTime).toBe('00:30');
    expect(result.sameDay).toBe(true);
    expect(result.end).toStrictEqual(Option.some('03:30'));
  });

  it('DST spring-forward end next local day returns sameDay false', () => {
    const start = localToUtc('2026-03-29', '23:00');
    const end = localToUtc('2026-03-30', '01:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.sameDay).toBe(false);
  });

  // The helper does not validate ordering; it formats whatever is passed in.
  it('end before start (inverted range) on same day returns sameDay true and HH:mm end', () => {
    const start = localToUtc('2026-05-22', '20:00');
    const end = localToUtc('2026-05-22', '18:00');
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.sameDay).toBe(true);
    expect(result.end).toStrictEqual(Option.some('18:00'));
  });
});

// `formatTimeInZone` takes its zone as an explicit parameter (unlike
// `formatLocalTime`, which reads the ambient/browser zone) — that is the
// whole point of it (see `~/lib/datetime.ts`'s doc comment: writing a
// series-shaped wall-clock field back in the TEAM's zone, not the viewer's).
// This file's own `beforeAll` above pins the process to Europe/Prague for
// every OTHER test in it, which makes it the perfect adversarial condition
// here too: if `formatTimeInZone` ever regressed to reading the ambient zone
// instead of its `tz` argument, every case below asking for a non-Prague
// zone would silently come back as the Prague reading instead, and these
// assertions would fail.
describe('formatTimeInZone', () => {
  const instant = DateTime.makeUnsafe('2026-07-14T16:00:00Z');

  it('Europe/Prague (matches the ambient pin — establishes the baseline)', () => {
    expect(formatTimeInZone(instant, 'Europe/Prague')).toBe('18:00');
  });

  it('America/Los_Angeles: reads the PASSED zone, not the ambient Prague pin', () => {
    expect(formatTimeInZone(instant, 'America/Los_Angeles')).toBe('09:00');
  });

  it('UTC: reads the PASSED zone, not the ambient Prague pin', () => {
    expect(formatTimeInZone(instant, 'UTC')).toBe('16:00');
  });

  it('Asia/Kathmandu: a 45-minute-offset zone (UTC+5:45), not a whole- or half-hour one', () => {
    expect(formatTimeInZone(instant, 'Asia/Kathmandu')).toBe('21:45');
  });

  it('local midnight formats as 00:00 (not 24:00) in this runtime', () => {
    // 2026-07-13T22:00:00Z is exactly local midnight in Europe/Prague
    // (CEST, UTC+2) on 2026-07-14.
    const midnight = DateTime.makeUnsafe('2026-07-13T22:00:00Z');
    expect(formatTimeInZone(midnight, 'Europe/Prague')).toBe('00:00');
  });

  it('invalid IANA zone falls back to Europe/Prague instead of throwing', () => {
    // `team_settings.timezone` is free-form TEXT with no CHECK constraint (see the migration
    // `1791700000_add_series_times_team_local_flag.ts`/`1792100000_series_time_is_team_local.ts`),
    // so a bad value can reach here. Unlike
    // `Intl.DateTimeFormat`, which throws a `RangeError` for an unrecognised zone,
    // `DateTime.setZoneNamed` returns `None` and `formatTimeInZone` falls back to
    // 'Europe/Prague' — mirroring the server-side `resolveOccurrenceInstant` fallback for the
    // same bad-data case, on a render/save path where throwing would be user-visible breakage.
    expect(formatTimeInZone(instant, 'Mars/Olympus')).toBe(
      formatTimeInZone(instant, 'Europe/Prague'),
    );
  });
});

describe('dateOnlyToLocalEndOfDay (Europe/Prague — the ambient pin)', () => {
  it('anchors to 23:59:59.999 LOCAL, not noon UTC', () => {
    const dt = dateOnlyToLocalEndOfDay('2026-09-30');
    expect(formatLocalDate(dt)).toBe('2026-09-30');
    expect(formatLocalTime(dt)).toBe('23:59');
  });

  it('differs from the noon-UTC anchor used elsewhere — proves this is a distinct helper', () => {
    const endOfDay = dateOnlyToLocalEndOfDay('2026-09-30');
    const noon = DateTime.makeUnsafe('2026-09-30T12:00:00Z');
    expect(DateTime.toEpochMillis(endOfDay)).not.toBe(DateTime.toEpochMillis(noon));
  });

  it('the local calendar date survives the UTC conversion for a positive-offset zone', () => {
    // Prague is UTC+2 in September (CEST): local 23:59:59.999 on the 30th is still the 30th
    // in UTC (22:59:59.999Z), so this would pass even with a bug that dropped the offset.
    // The real regression guard is `formatLocalDate` above, which reads it back through the
    // SAME local-timezone lens `dateOnlyToLocalEndOfDay` was anchored in.
    const dt = dateOnlyToLocalEndOfDay('2026-01-15');
    expect(formatLocalDate(dt)).toBe('2026-01-15');
  });
});
