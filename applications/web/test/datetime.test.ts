import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import {
  formatEventDateRange,
  formatLocalDate,
  formatLocalTime,
  localToUtc,
} from '~/lib/datetime.js';

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

  describe('DST edge cases', () => {
    it('roundtrips DST spring-forward datetime', () => {
      const dt = localToUtc('2024-03-10', '03:00');
      expect(formatLocalDate(dt)).toBe('2024-03-10');
      expect(formatLocalTime(dt)).toBe('03:00');
    });

    it('roundtrips DST fall-back datetime', () => {
      const dt = localToUtc('2024-11-03', '01:30');
      expect(formatLocalDate(dt)).toBe('2024-11-03');
      expect(formatLocalTime(dt)).toBe('01:30');
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
    const result = formatEventDateRange(start, Option.some(end));
    expect(result.startDate).toBe('2026-03-29');
    expect(result.startTime).toBe('01:30');
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
