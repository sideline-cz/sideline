/**
 * D13 — the export must be able to prove it is complete. Pure, no DB, no Effect: interval merge,
 * gap computation, the per-period arithmetic continuity check (which works under OVERLAP — D1's
 * rolling window means real recorded periods overlap and never abut), and balance derivation for
 * an arbitrary `from` with no matching recorded `date_start`.
 */
import { Option } from 'effect';

export interface CoveragePeriod {
  readonly dateStart: string; // 'YYYY-MM-DD'
  readonly dateEnd: string;
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
}

export interface CoverageInterval {
  readonly from: string;
  readonly to: string;
}

export interface Movement {
  readonly bookedOn: string;
  readonly amountMinor: number;
}

export interface PeriodContinuityViolation {
  readonly dateStart: string;
  readonly dateEnd: string;
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
  /** openingBalanceMinor + SUM(movements in range). */
  readonly actualClosingMinor: number;
}

// ---------------------------------------------------------------------------
// Date-string helpers — plain lexicographic comparison is valid for 'YYYY-MM-DD' strings.
// ---------------------------------------------------------------------------

const addDaysToDateString = (dateStr: string, days: number): string => {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const maxDate = (a: string, b: string): string => (a > b ? a : b);
const minDate = (a: string, b: string): string => (a < b ? a : b);

// ---------------------------------------------------------------------------
// mergeCoveragePeriods — merges overlapping AND adjacent (date-continuous) periods.
// ---------------------------------------------------------------------------

export const mergeCoveragePeriods = (
  periods: ReadonlyArray<{ readonly dateStart: string; readonly dateEnd: string }>,
): ReadonlyArray<CoverageInterval> => {
  if (periods.length === 0) return [];
  const sorted = [...periods].sort((a, b) =>
    a.dateStart < b.dateStart ? -1 : a.dateStart > b.dateStart ? 1 : 0,
  );

  const merged: Array<{ from: string; to: string }> = [];
  for (const period of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && period.dateStart <= addDaysToDateString(last.to, 1)) {
      last.to = maxDate(last.to, period.dateEnd);
    } else {
      merged.push({ from: period.dateStart, to: period.dateEnd });
    }
  }
  return merged;
};

// ---------------------------------------------------------------------------
// coverageGaps — the sub-ranges of `range` not covered by any (merged) period.
// ---------------------------------------------------------------------------

export const coverageGaps = (
  periods: ReadonlyArray<{ readonly dateStart: string; readonly dateEnd: string }>,
  range: CoverageInterval,
): ReadonlyArray<CoverageInterval> => {
  const merged = mergeCoveragePeriods(periods).filter(
    (iv) => iv.to >= range.from && iv.from <= range.to,
  );

  const gaps: Array<CoverageInterval> = [];
  let cursor = range.from;
  for (const interval of merged) {
    const coveredFrom = maxDate(interval.from, range.from);
    if (coveredFrom > cursor) {
      gaps.push({ from: cursor, to: addDaysToDateString(coveredFrom, -1) });
    }
    const coveredTo = minDate(interval.to, range.to);
    if (coveredTo >= cursor) {
      cursor = addDaysToDateString(coveredTo, 1);
    }
  }
  if (cursor <= range.to) {
    gaps.push({ from: cursor, to: range.to });
  }
  return gaps;
};

// ---------------------------------------------------------------------------
// checkPeriodContinuity — fires PER-PERIOD (works under overlap, D13(b)). Periods with
// dateEnd === today are excluded (provisional closing balance).
// ---------------------------------------------------------------------------

export const checkPeriodContinuity = (
  periods: ReadonlyArray<CoveragePeriod>,
  movements: ReadonlyArray<Movement>,
  today: string,
): ReadonlyArray<PeriodContinuityViolation> => {
  const violations: Array<PeriodContinuityViolation> = [];
  for (const period of periods) {
    if (period.dateEnd === today) continue;
    const sum = movements
      .filter((m) => m.bookedOn >= period.dateStart && m.bookedOn <= period.dateEnd)
      .reduce((acc, m) => acc + m.amountMinor, 0);
    const actualClosingMinor = period.openingBalanceMinor + sum;
    if (actualClosingMinor !== period.closingBalanceMinor) {
      violations.push({
        dateStart: period.dateStart,
        dateEnd: period.dateEnd,
        openingBalanceMinor: period.openingBalanceMinor,
        closingBalanceMinor: period.closingBalanceMinor,
        actualClosingMinor,
      });
    }
  }
  return violations;
};

// ---------------------------------------------------------------------------
// deriveBalanceBefore — anchors on the nearest recorded period at or before `from` and walks
// movements forward: anchor.openingBalanceMinor + SUM(amountMinor WHERE bookedOn BETWEEN
// anchor.dateStart AND from-1).
// ---------------------------------------------------------------------------

export const deriveBalanceBefore = (
  periods: ReadonlyArray<CoveragePeriod>,
  movements: ReadonlyArray<Movement>,
  from: string,
): Option.Option<number> => {
  const candidates = periods.filter((p) => p.dateStart <= from);
  if (candidates.length === 0) return Option.none();
  const anchor = candidates.reduce((best, p) => (p.dateStart > best.dateStart ? p : best));
  const sum = movements
    .filter((m) => m.bookedOn >= anchor.dateStart && m.bookedOn < from)
    .reduce((acc, m) => acc + m.amountMinor, 0);
  return Option.some(anchor.openingBalanceMinor + sum);
};
