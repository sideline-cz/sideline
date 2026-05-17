// TDD mode — tests written BEFORE computeKpis.ts exists.
// These tests WILL FAIL until:
//   - applications/web/src/lib/finance/computeKpis.ts is implemented
//
// Contract:
//   computeKpis(groups: ReadonlyArray<MyFinanceStatus>): Kpis
//
//   type Kpis = {
//     outstandingTotal: ReadonlyArray<{ currency: string; amountMinor: number }>;
//     overdueCount: number;
//     paidTotal: ReadonlyArray<{ currency: string; amountMinor: number }>;
//     nextDue: Option.Option<{ effectiveDueAt: DateTime.Utc; amountMinor: number; currency: string }>;
//   }
//
//   MyFinanceStatus shape (from domain):
//   {
//     currency: string;
//     assignments: ReadonlyArray<FeeAssignmentView>;
//     totalOutstandingMinor: number;
//   }
//
//   FeeAssignmentView shape (relevant fields):
//   {
//     assignmentId: string;
//     feeId: string;
//     feeName: string;
//     currency: string;
//     dueMinor: number;
//     paidMinor: number;
//     status: 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';
//     effectiveDueAt: Option.Option<DateTime.Utc>;
//   }

import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';

// Dynamic import — will fail until the module exists
const { computeKpis } = await import('~/lib/finance/computeKpis.js');

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type FeeAssignmentStatus = 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';

type FeeAssignmentView = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: FeeAssignmentStatus;
  effectiveDueAt: Option.Option<DateTime.Utc>;
  waivedReason: Option.Option<string>;
};

type MyFinanceStatus = {
  currency: string;
  assignments: ReadonlyArray<FeeAssignmentView>;
  totalOutstandingMinor: number;
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DATE_EARLIER = DateTime.fromDateUnsafe(new Date('2025-03-01T00:00:00Z'));
const DATE_NOW = DateTime.fromDateUnsafe(new Date('2025-05-01T00:00:00Z'));
const DATE_LATER = DateTime.fromDateUnsafe(new Date('2025-07-01T00:00:00Z'));

function makeAssignment(
  id: string,
  status: FeeAssignmentStatus,
  dueMinor: number,
  paidMinor: number,
  effectiveDueAt: Option.Option<DateTime.Utc>,
  currency = 'CZK',
): FeeAssignmentView {
  return {
    assignmentId: id,
    feeId: `fee-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.none(),
    feeName: `Fee ${id}`,
    currency,
    dueMinor,
    paidMinor,
    status,
    effectiveDueAt,
    waivedReason: Option.none(),
  };
}

function makeGroup(
  currency: string,
  assignments: ReadonlyArray<FeeAssignmentView>,
  totalOutstandingMinor: number,
): MyFinanceStatus {
  return { currency, assignments, totalOutstandingMinor };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('computeKpis', () => {
  it('empty input → all zero/none values', () => {
    const kpis = computeKpis([]);

    expect(kpis.outstandingTotal).toEqual([]);
    expect(kpis.overdueCount).toBe(0);
    expect(kpis.paidTotal).toEqual([]);
    expect(Option.isNone(kpis.nextDue)).toBe(true);
  });

  it('single currency all pending → outstanding > 0, overdue=0, paid=0, nextDue=earliest', () => {
    const assignments = [
      makeAssignment('a', 'pending', 5000, 0, Option.some(DATE_LATER)),
      makeAssignment('b', 'pending', 3000, 0, Option.some(DATE_EARLIER)),
    ];
    const groups = [makeGroup('CZK', assignments, 8000)];

    const kpis = computeKpis(groups);

    expect(kpis.outstandingTotal).toHaveLength(1);
    expect(kpis.outstandingTotal[0].currency).toBe('CZK');
    expect(kpis.outstandingTotal[0].amountMinor).toBeGreaterThan(0);
    expect(kpis.overdueCount).toBe(0);
    expect(kpis.paidTotal).toEqual([]);
    // nextDue should pick the earliest pending assignment (DATE_EARLIER)
    expect(Option.isSome(kpis.nextDue)).toBe(true);
  });

  it('all paid → outstanding=[], overdue=0, paid>0, nextDue=Option.none()', () => {
    const assignments = [
      makeAssignment('a', 'paid', 5000, 5000, Option.none()),
      makeAssignment('b', 'paid', 3000, 3000, Option.none()),
    ];
    const groups = [makeGroup('CZK', assignments, 0)];

    const kpis = computeKpis(groups);

    expect(kpis.outstandingTotal).toEqual([]);
    expect(kpis.overdueCount).toBe(0);
    expect(kpis.paidTotal).toHaveLength(1);
    expect(kpis.paidTotal[0].amountMinor).toBeGreaterThan(0);
    expect(Option.isNone(kpis.nextDue)).toBe(true);
  });

  it('multi-currency → both outstandingTotal and paidTotal have 2 entries; nextDue picks earliest across currencies', () => {
    const czk = [makeAssignment('czk-pending', 'pending', 5000, 0, Option.some(DATE_LATER), 'CZK')];
    const eur = [
      makeAssignment('eur-pending', 'pending', 2000, 0, Option.some(DATE_EARLIER), 'EUR'),
    ];
    const czkPaid = [makeAssignment('czk-paid', 'paid', 3000, 3000, Option.none(), 'CZK')];
    const eurPaid = [makeAssignment('eur-paid', 'paid', 1000, 1000, Option.none(), 'EUR')];

    const groups = [
      makeGroup('CZK', [...czk, ...czkPaid], 5000),
      makeGroup('EUR', [...eur, ...eurPaid], 2000),
    ];

    const kpis = computeKpis(groups);

    expect(kpis.outstandingTotal).toHaveLength(2);
    expect(kpis.paidTotal).toHaveLength(2);
    // nextDue picks the earliest pending due date (DATE_EARLIER from EUR)
    expect(Option.isSome(kpis.nextDue)).toBe(true);
  });

  it('overdueCount = number of overdue assignments across all groups', () => {
    const czk = [
      makeAssignment('czk-o1', 'overdue', 5000, 0, Option.some(DATE_EARLIER), 'CZK'),
      makeAssignment('czk-o2', 'overdue', 3000, 0, Option.some(DATE_NOW), 'CZK'),
      makeAssignment('czk-p', 'pending', 2000, 0, Option.some(DATE_LATER), 'CZK'),
    ];
    const eur = [makeAssignment('eur-o', 'overdue', 1000, 0, Option.some(DATE_EARLIER), 'EUR')];
    const groups = [makeGroup('CZK', czk, 10000), makeGroup('EUR', eur, 1000)];

    const kpis = computeKpis(groups);

    expect(kpis.overdueCount).toBe(3);
  });

  it('nextDue skips overdue, paid, waived — only pending|partial are eligible', () => {
    const assignments = [
      makeAssignment('overdue', 'overdue', 5000, 0, Option.some(DATE_EARLIER)),
      makeAssignment('paid', 'paid', 3000, 3000, Option.none()),
      makeAssignment('waived', 'waived', 2000, 0, Option.none()),
      makeAssignment('pending', 'pending', 4000, 0, Option.some(DATE_NOW)),
    ];
    const groups = [makeGroup('CZK', assignments, 7000)];

    const kpis = computeKpis(groups);

    expect(Option.isSome(kpis.nextDue)).toBe(true);
    if (Option.isSome(kpis.nextDue)) {
      // Should be the pending assignment's date, not the overdue one
      const nextDue = kpis.nextDue.value;
      expect(nextDue.amountMinor).toBe(4000);
    }
  });

  it('nextDue currency comes from the group that owns the earliest assignment, not the first group', () => {
    // Group 1 (CZK) has a later due date; Group 2 (EUR) has the earliest due date.
    // nextDue.currency must be 'EUR', not 'CZK'.
    const czk = [makeAssignment('czk-pending', 'pending', 5000, 0, Option.some(DATE_LATER), 'CZK')];
    const eur = [
      makeAssignment('eur-pending', 'pending', 2000, 0, Option.some(DATE_EARLIER), 'EUR'),
    ];
    const groups = [makeGroup('CZK', czk, 5000), makeGroup('EUR', eur, 2000)];

    const kpis = computeKpis(groups);

    expect(Option.isSome(kpis.nextDue)).toBe(true);
    const nd = Option.getOrThrow(kpis.nextDue);
    expect(nd.currency).toBe('EUR');
    expect(nd.amountMinor).toBe(2000);
  });

  it('nextDue with all-Option.none() due dates → Option.none()', () => {
    const assignments = [
      makeAssignment('a', 'pending', 5000, 0, Option.none()),
      makeAssignment('b', 'partial', 3000, 1000, Option.none()),
    ];
    const groups = [makeGroup('CZK', assignments, 7000)];

    const kpis = computeKpis(groups);

    expect(Option.isNone(kpis.nextDue)).toBe(true);
  });
});
