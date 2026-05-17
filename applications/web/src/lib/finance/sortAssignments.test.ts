// TDD mode — tests written BEFORE sortAssignments.ts exists.
// These tests WILL FAIL until:
//   - applications/web/src/lib/finance/sortAssignments.ts is implemented
//
// Contract:
//   sortAssignments(assignments: ReadonlyArray<FeeAssignmentView>): ReadonlyArray<FeeAssignmentView>
//
// Sort order (per the plan):
//   1. overdue    — effectiveDueAt asc (oldest first), Option.none() last
//   2. pending | partial — effectiveDueAt asc, Option.none() last
//   3. paid       — feeName asc
//   4. waived     — feeName asc (always last group)

import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';

// Dynamic import — will fail until the module exists
const { sortAssignments } = await import('~/lib/finance/sortAssignments.js');

// ---------------------------------------------------------------------------
// Type helpers (mirror FinanceApi.FeeAssignmentView shape)
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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = DateTime.fromDateUnsafe(new Date('2025-05-01T00:00:00Z'));
const EARLIER = DateTime.fromDateUnsafe(new Date('2025-03-01T00:00:00Z'));
const LATER = DateTime.fromDateUnsafe(new Date('2025-07-01T00:00:00Z'));

function makeAssignment(
  id: string,
  status: FeeAssignmentStatus,
  feeName: string,
  effectiveDueAt: Option.Option<DateTime.Utc>,
): FeeAssignmentView {
  return {
    assignmentId: id,
    feeId: `fee-${id}`,
    teamMemberId: 'member-1',
    memberName: Option.none(),
    feeName,
    currency: 'CZK',
    dueMinor: 5000,
    paidMinor: 0,
    status,
    effectiveDueAt,
    waivedReason: Option.none(),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sortAssignments', () => {
  it('empty input → empty output', () => {
    const result = sortAssignments([]);
    expect(result).toEqual([]);
  });

  it('overdue rows sorted by effectiveDueAt asc (oldest first), Option.none() last', () => {
    const a = makeAssignment('a', 'overdue', 'Fee A', Option.some(LATER));
    const b = makeAssignment('b', 'overdue', 'Fee B', Option.some(EARLIER));
    const c = makeAssignment('c', 'overdue', 'Fee C', Option.none());

    const result = sortAssignments([a, b, c]);

    // Expected order: b (earlier), a (later), c (none)
    expect(result[0].assignmentId).toBe('b');
    expect(result[1].assignmentId).toBe('a');
    expect(result[2].assignmentId).toBe('c');
  });

  it('pending/partial mix sorted by effectiveDueAt asc, Option.none() last', () => {
    const a = makeAssignment('a', 'pending', 'Fee A', Option.some(LATER));
    const b = makeAssignment('b', 'partial', 'Fee B', Option.some(EARLIER));
    const c = makeAssignment('c', 'pending', 'Fee C', Option.none());

    const result = sortAssignments([a, b, c]);

    // Expected order: b (earlier), a (later), c (none)
    expect(result[0].assignmentId).toBe('b');
    expect(result[1].assignmentId).toBe('a');
    expect(result[2].assignmentId).toBe('c');
  });

  it('full mix order: overdue → pending/partial → paid → waived', () => {
    const overdue = makeAssignment('overdue', 'overdue', 'Z Fee', Option.some(NOW));
    const pending = makeAssignment('pending', 'pending', 'M Fee', Option.some(NOW));
    const partial = makeAssignment('partial', 'partial', 'A Fee', Option.some(NOW));
    const paid = makeAssignment('paid', 'paid', 'B Fee', Option.none());
    const waived = makeAssignment('waived', 'waived', 'C Fee', Option.none());

    const result = sortAssignments([waived, paid, partial, pending, overdue]);

    const statuses = (result as FeeAssignmentView[]).map((r) => r.status);
    // overdue must come first, waived must come last
    expect(statuses[0]).toBe('overdue');
    expect(statuses[statuses.length - 1]).toBe('waived');
    // paid must appear before waived
    const paidIdx = statuses.indexOf('paid');
    const waivedIdx = statuses.indexOf('waived');
    expect(paidIdx).toBeLessThan(waivedIdx);
    // pending/partial must appear before paid
    const pendingIdx = statuses.indexOf('pending');
    expect(pendingIdx).toBeLessThan(paidIdx);
  });

  it('paid rows sorted by feeName asc', () => {
    const a = makeAssignment('a', 'paid', 'Zebra Fee', Option.none());
    const b = makeAssignment('b', 'paid', 'Alpha Fee', Option.none());
    const c = makeAssignment('c', 'paid', 'Mango Fee', Option.none());

    const result = sortAssignments([a, b, c]);

    expect(result[0].feeName).toBe('Alpha Fee');
    expect(result[1].feeName).toBe('Mango Fee');
    expect(result[2].feeName).toBe('Zebra Fee');
  });

  it('waived rows sorted by feeName asc (always last group)', () => {
    const pending = makeAssignment('pending', 'pending', 'A Fee', Option.some(NOW));
    const waivedZ = makeAssignment('wz', 'waived', 'Zeta Fee', Option.none());
    const waivedA = makeAssignment('wa', 'waived', 'Apple Fee', Option.none());

    const result = sortAssignments([waivedZ, pending, waivedA]);

    // pending comes first
    expect(result[0].assignmentId).toBe('pending');
    // waived come last, sorted by feeName
    expect(result[1].feeName).toBe('Apple Fee');
    expect(result[2].feeName).toBe('Zeta Fee');
  });
});
