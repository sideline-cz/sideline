// TDD mode — tests written BEFORE `bankCoverage.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D13 / §7.1 tests 70-74. Pure, no DB, no Effect —
// interval merge, gap computation, the per-period arithmetic continuity check, and balance
// derivation for an arbitrary `from` with no matching recorded `date_start`.
//
// Contract this file pins down for `applications/server/src/services/bankCoverage.ts`:
//
//   export interface CoveragePeriod {
//     readonly dateStart: string;              // 'YYYY-MM-DD'
//     readonly dateEnd: string;
//     readonly openingBalanceMinor: number;
//     readonly closingBalanceMinor: number;
//   }
//   export interface CoverageInterval { readonly from: string; readonly to: string; }
//   export interface Movement { readonly bookedOn: string; readonly amountMinor: number; }
//
//   export const mergeCoveragePeriods:
//     (periods: ReadonlyArray<{ dateStart: string; dateEnd: string }>) => ReadonlyArray<CoverageInterval>
//     — merges overlapping AND adjacent (date-continuous) periods into canonical intervals.
//
//   export const coverageGaps:
//     (periods: ReadonlyArray<{ dateStart: string; dateEnd: string }>, range: CoverageInterval)
//       => ReadonlyArray<CoverageInterval>
//     — the sub-ranges of `range` not covered by any (merged) period.
//
//   export interface PeriodContinuityViolation {
//     readonly dateStart: string;
//     readonly dateEnd: string;
//     readonly openingBalanceMinor: number;
//     readonly closingBalanceMinor: number;
//     readonly actualClosingMinor: number;    // openingBalanceMinor + SUM(movements in range)
//   }
//
//   export const checkPeriodContinuity:
//     (periods: ReadonlyArray<CoveragePeriod>, movements: ReadonlyArray<Movement>, today: string)
//       => ReadonlyArray<PeriodContinuityViolation>
//     — fires per-period (works under overlap, D13(b)); periods with dateEnd === today are
//       excluded (provisional closing balance).
//
//   export const deriveBalanceBefore:
//     (periods: ReadonlyArray<CoveragePeriod>, movements: ReadonlyArray<Movement>, from: string)
//       => Option.Option<number>
//     — anchors on the nearest recorded period at or before `from` and walks movements forward:
//       anchor.openingBalanceMinor + SUM(amountMinor WHERE bookedOn BETWEEN anchor.dateStart AND from-1).

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  type CoveragePeriod,
  checkPeriodContinuity,
  coverageGaps,
  deriveBalanceBefore,
  type Movement,
  mergeCoveragePeriods,
} from '~/services/bankCoverage.js';

// ---------------------------------------------------------------------------
// Date helpers (plain UTC date-string arithmetic — no Effect DateTime needed for pure fixtures)
// ---------------------------------------------------------------------------

const addDays = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// 70 / 72 — adjacent and overlapping periods merge
// ---------------------------------------------------------------------------

describe('mergeCoveragePeriods (70, 72)', () => {
  it('adjacent periods merge into one interval', () => {
    const merged = mergeCoveragePeriods([
      { dateStart: '2024-01-01', dateEnd: '2024-01-10' },
      { dateStart: '2024-01-11', dateEnd: '2024-01-20' },
    ]);
    expect(merged).toEqual([{ from: '2024-01-01', to: '2024-01-20' }]);
  });

  it('overlapping periods merge into one interval', () => {
    const merged = mergeCoveragePeriods([
      { dateStart: '2024-01-01', dateEnd: '2024-01-15' },
      { dateStart: '2024-01-10', dateEnd: '2024-01-20' },
    ]);
    expect(merged).toEqual([{ from: '2024-01-01', to: '2024-01-20' }]);
  });

  it('disjoint periods with a gap stay as two intervals', () => {
    const merged = mergeCoveragePeriods([
      { dateStart: '2024-01-01', dateEnd: '2024-01-10' },
      { dateStart: '2024-01-15', dateEnd: '2024-01-20' },
    ]);
    expect(merged).toEqual([
      { from: '2024-01-01', to: '2024-01-10' },
      { from: '2024-01-15', to: '2024-01-20' },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 71 / 74 — gap reporting
// ---------------------------------------------------------------------------

describe('coverageGaps (71, 74)', () => {
  it('a one-day hole between two periods is reported as a gap', () => {
    const gaps = coverageGaps(
      [
        { dateStart: '2024-01-01', dateEnd: '2024-01-10' },
        { dateStart: '2024-01-12', dateEnd: '2024-01-20' },
      ],
      { from: '2024-01-01', to: '2024-01-20' },
    );
    expect(gaps).toEqual([{ from: '2024-01-11', to: '2024-01-11' }]);
  });

  it('a request range entirely before the earliest period -> one gap covering the whole range', () => {
    const gaps = coverageGaps([{ dateStart: '2024-06-01', dateEnd: '2024-06-30' }], {
      from: '2024-01-01',
      to: '2024-01-31',
    });
    expect(gaps).toEqual([{ from: '2024-01-01', to: '2024-01-31' }]);
  });

  it('a fully-covered range reports no gaps', () => {
    const gaps = coverageGaps([{ dateStart: '2024-01-01', dateEnd: '2024-01-31' }], {
      from: '2024-01-10',
      to: '2024-01-20',
    });
    expect(gaps).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 73 — per-period arithmetic continuity, under OVERLAP (production-shaped fixtures)
//
// D1's rolling window is (today-14, today), recorded daily, so real recorded periods look like
// (d-14,d), (d-13,d+1), (d-12,d+2), ... — they OVERLAP and never abut. A fixture set of abutting
// periods is exactly the shape that made revision 3's check vacuous (blocker 2); these fixtures
// are deliberately the rolling-overlap shape instead.
// ---------------------------------------------------------------------------

describe('checkPeriodContinuity — production-shaped OVERLAPPING fixtures (73)', () => {
  const WINDOW_DAYS = 14;
  const TODAY = '2024-06-20'; // the last day a period was fetched
  const EARLIEST_START = addDays(TODAY, -20); // movements exist a bit before the first period

  // One incoming movement per day, 100 minor units, for 21 days.
  const movements: ReadonlyArray<Movement> = Array.from({ length: 21 }, (_, i) => ({
    bookedOn: addDays(EARLIEST_START, i),
    amountMinor: 100,
  }));

  const sumBetween = (from: string, to: string): number =>
    movements
      .filter((m) => m.bookedOn >= from && m.bookedOn <= to)
      .reduce((acc, m) => acc + m.amountMinor, 0);

  /** Six daily rolling windows (d-14,d) through (d-9,d+5) — OVERLAPPING, never abutting. */
  const rollingPeriods = (
    openingAt: (dateStart: string) => number,
  ): ReadonlyArray<CoveragePeriod> =>
    Array.from({ length: 6 }, (_, i) => {
      const dateEnd = addDays(TODAY, i - 5); // ..., TODAY-5, TODAY-4, ..., TODAY
      const dateStart = addDays(dateEnd, -WINDOW_DAYS);
      const openingBalanceMinor = openingAt(dateStart);
      const closingBalanceMinor = openingBalanceMinor + sumBetween(dateStart, dateEnd);
      return { dateStart, dateEnd, openingBalanceMinor, closingBalanceMinor };
    });

  it('(a) every period whose ingested movements sum to closing - opening is clean', () => {
    const periods = rollingPeriods(
      (dateStart) => 1_000_000 + sumBetween(EARLIEST_START, addDays(dateStart, -1)),
    );
    const violations = checkPeriodContinuity(periods, movements, TODAY);
    expect(violations).toEqual([]);
  });

  it('(b) deleting one ingested movement inside a period makes THAT period violate', () => {
    const periods = rollingPeriods(
      (dateStart) => 1_000_000 + sumBetween(EARLIEST_START, addDays(dateStart, -1)),
    );
    // Remove a movement that falls inside every one of the six overlapping windows.
    const targetDate = addDays(TODAY, -7);
    const movementsMinusOne = movements.filter((m) => m.bookedOn !== targetDate);

    const violations = checkPeriodContinuity(periods, movementsMinusOne, TODAY);

    // Every period whose [dateStart, dateEnd] contains targetDate must be reported — except a
    // period ending today (D13(b)/73b: its closing balance is provisional, so it's excluded from
    // the continuity check regardless of whether the movement sum would otherwise disagree).
    const expectedViolatingPeriods = periods.filter(
      (p) => p.dateStart <= targetDate && targetDate <= p.dateEnd && p.dateEnd !== TODAY,
    );
    expect(expectedViolatingPeriods.length).toBeGreaterThan(1); // proves the fixtures actually overlap
    expect(violations).toHaveLength(expectedViolatingPeriods.length);
    for (const expected of expectedViolatingPeriods) {
      expect(
        violations.some(
          (v) => v.dateStart === expected.dateStart && v.dateEnd === expected.dateEnd,
        ),
      ).toBe(true);
    }
  });

  it('(c) the check fires AT ALL on overlapping windows — the regression revision 3 would have failed', () => {
    // A period-abutment-only check matches zero pairs against these fixtures (they never abut),
    // so this proves the check operates per-period rather than on pairwise abutment.
    const periods = rollingPeriods(
      (dateStart) => 1_000_000 + sumBetween(EARLIEST_START, addDays(dateStart, -1)),
    );
    // Confirm the fixtures indeed never abut: no period's dateEnd + 1 day equals another's dateStart.
    for (const p of periods) {
      for (const q of periods) {
        if (p === q) continue;
        expect(addDays(p.dateEnd, 1)).not.toBe(q.dateStart);
      }
    }
    const violations = checkPeriodContinuity(periods, movements, TODAY);
    expect(violations).toEqual([]); // clean fixtures -> no violations, but the check DID run per-period

    const brokenMovements = movements.filter((m) => m.bookedOn !== addDays(TODAY, -1));
    const brokenViolations = checkPeriodContinuity(periods, brokenMovements, TODAY);
    expect(brokenViolations.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 73b — a period ending today is excluded (provisional closing balance)
// ---------------------------------------------------------------------------

describe('checkPeriodContinuity — periods ending today are excluded (73b)', () => {
  it('a period with dateEnd = today never produces a violation, even with a deliberately wrong closing balance', () => {
    const today = '2024-06-20';
    const periods: ReadonlyArray<CoveragePeriod> = [
      {
        dateStart: addDays(today, -14),
        dateEnd: today,
        openingBalanceMinor: 1000,
        closingBalanceMinor: 999_999_999, // deliberately wrong — must still not be flagged
      },
    ];
    const violations = checkPeriodContinuity(periods, [], today);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 73c — balance derivation for an arbitrary `from` with no matching recorded date_start
// ---------------------------------------------------------------------------

describe('deriveBalanceBefore — anchor + walk forward across a 60-day backfill chunk (73c)', () => {
  it('derives balance(from-1) by anchoring on the nearest period at or before `from` and summing movements forward', () => {
    const anchorStart = '2024-01-01';
    const anchorEnd = '2024-03-01'; // a 60-day backfill chunk
    const periods: ReadonlyArray<CoveragePeriod> = [
      {
        dateStart: anchorStart,
        dateEnd: anchorEnd,
        openingBalanceMinor: 500_000,
        closingBalanceMinor: 500_000, // irrelevant to this derivation
      },
    ];

    // One movement every 3 days across the chunk.
    const movements: ReadonlyArray<Movement> = Array.from({ length: 20 }, (_, i) => ({
      bookedOn: addDays(anchorStart, i * 3),
      amountMinor: 1000,
    }));

    const from = addDays(anchorStart, 25); // no recorded period starts exactly here
    const expectedSum = movements
      .filter((m) => m.bookedOn >= anchorStart && m.bookedOn < from)
      .reduce((acc, m) => acc + m.amountMinor, 0);
    const expectedBalance = 500_000 + expectedSum;

    const derived = deriveBalanceBefore(periods, movements, from);
    expect(derived).toEqual(Option.some(expectedBalance));
  });

  it('returns Option.none() when `from` precedes every recorded period', () => {
    const periods: ReadonlyArray<CoveragePeriod> = [
      {
        dateStart: '2024-06-01',
        dateEnd: '2024-06-30',
        openingBalanceMinor: 0,
        closingBalanceMinor: 0,
      },
    ];
    const derived = deriveBalanceBefore(periods, [], '2024-01-01');
    expect(derived).toEqual(Option.none());
  });
});
