import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { toRecurrence } from '~/models/EventSeries.js';

const flat = (
  frequency: string,
  daysOfWeek: ReadonlyArray<number>,
  dayOfMonth: Option.Option<number> = Option.none(),
  weekOfMonth: Option.Option<number> = Option.none(),
) => ({ frequency, daysOfWeek, dayOfMonth, weekOfMonth });

describe('toRecurrence', () => {
  describe('weekly / biweekly', () => {
    it('should return Some when weekly has days [1,3]', () => {
      expect(toRecurrence(flat('weekly', [1, 3]))).toEqual(
        Option.some({ frequency: 'weekly', daysOfWeek: [1, 3] }),
      );
    });

    it('should return Some when biweekly has days [0]', () => {
      expect(Option.isSome(toRecurrence(flat('biweekly', [0])))).toBe(true);
    });

    it('should return None when weekly has no days (min-1 preserved)', () => {
      expect(Option.isNone(toRecurrence(flat('weekly', [])))).toBe(true);
    });

    it('should return None when weekly carries a dayOfMonth', () => {
      expect(Option.isNone(toRecurrence(flat('weekly', [1], Option.some(5))))).toBe(true);
    });

    it('should return None when weekly carries a weekOfMonth', () => {
      expect(Option.isNone(toRecurrence(flat('weekly', [1], Option.none(), Option.some(1))))).toBe(
        true,
      );
    });
  });

  describe('monthly_by_date', () => {
    it('should return Some when day 15 with no weekdays', () => {
      expect(toRecurrence(flat('monthly_by_date', [], Option.some(15)))).toEqual(
        Option.some({ frequency: 'monthly_by_date', dayOfMonth: 15 }),
      );
    });

    it('should return None when day is 32', () => {
      expect(Option.isNone(toRecurrence(flat('monthly_by_date', [], Option.some(32))))).toBe(true);
    });

    it('should return None when day is 0', () => {
      expect(Option.isNone(toRecurrence(flat('monthly_by_date', [], Option.some(0))))).toBe(true);
    });

    it('should return None when dayOfMonth is missing', () => {
      expect(Option.isNone(toRecurrence(flat('monthly_by_date', [])))).toBe(true);
    });

    it('should return None when weekdays are non-empty', () => {
      expect(Option.isNone(toRecurrence(flat('monthly_by_date', [2], Option.some(15))))).toBe(true);
    });

    it('should return None when weekOfMonth is also set', () => {
      expect(
        Option.isNone(toRecurrence(flat('monthly_by_date', [], Option.some(15), Option.some(1)))),
      ).toBe(true);
    });
  });

  describe('monthly_by_weekday', () => {
    it('should return Some with scalar dayOfWeek when [2] and last (-1)', () => {
      expect(toRecurrence(flat('monthly_by_weekday', [2], Option.none(), Option.some(-1)))).toEqual(
        Option.some({ frequency: 'monthly_by_weekday', dayOfWeek: 2, weekOfMonth: -1 }),
      );
    });

    it('should return None when two weekdays are given', () => {
      expect(
        Option.isNone(
          toRecurrence(flat('monthly_by_weekday', [2, 4], Option.none(), Option.some(1))),
        ),
      ).toBe(true);
    });

    it('should return None when no weekday is given', () => {
      expect(
        Option.isNone(toRecurrence(flat('monthly_by_weekday', [], Option.none(), Option.some(1)))),
      ).toBe(true);
    });

    it('should return None when weekOfMonth is 5', () => {
      expect(
        Option.isNone(toRecurrence(flat('monthly_by_weekday', [2], Option.none(), Option.some(5)))),
      ).toBe(true);
    });

    it('should return None when weekday is 7', () => {
      expect(
        Option.isNone(toRecurrence(flat('monthly_by_weekday', [7], Option.none(), Option.some(1)))),
      ).toBe(true);
    });

    it('should return None when weekOfMonth is missing', () => {
      expect(Option.isNone(toRecurrence(flat('monthly_by_weekday', [2])))).toBe(true);
    });

    it('should return None when dayOfMonth is also set', () => {
      expect(
        Option.isNone(
          toRecurrence(flat('monthly_by_weekday', [2], Option.some(3), Option.some(1))),
        ),
      ).toBe(true);
    });
  });

  it('should return None for an unknown frequency', () => {
    expect(Option.isNone(toRecurrence(flat('daily', [1])))).toBe(true);
  });
});
