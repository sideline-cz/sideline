// Pure algorithm tests for planSettlement — the money arithmetic shared by the client's
// settlement preview and the server's MemberCreditsRepository.settle (packages/domain/AGENTS.md
// "Pure Algorithm Modules"). No DB, no Effect runtime needed.
//
// Spec: .work-plans/finances/settle-all-and-credit-architecture.md §T1.

import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { planSettlement, type SettlementCandidate } from '~/models/SettlementPlan.js';

const candidate = (
  overrides: Partial<SettlementCandidate> & Pick<SettlementCandidate, 'assignmentId'>,
): SettlementCandidate => ({
  feeId: `fee-${overrides.assignmentId}`,
  feeName: `Fee ${overrides.assignmentId}`,
  dueMinor: 0,
  paidMinor: 0,
  effectiveDueAt: Option.none(),
  ...overrides,
});

describe('planSettlement', () => {
  it('1.1 — no candidates, no credit, amount 0 → an empty plan', () => {
    const plan = planSettlement([], 0, 0);
    expect(plan.outstandingMinor).toBe(0);
    expect(plan.creditAppliedMinor).toBe(0);
    expect(plan.toPayMinor).toBe(0);
    expect(plan.creditAddedMinor).toBe(0);
    expect(plan.lines).toEqual([]);
    expect(plan.fullyCoveredCount).toBe(0);
    expect(Option.isNone(plan.firstPartial)).toBe(true);
  });

  it('1.2 — no candidates, amount 2000 → the whole amount becomes credit (pay-in-advance)', () => {
    const plan = planSettlement([], 0, 2000);
    expect(plan.creditAddedMinor).toBe(2000);
    expect(plan.lines).toEqual([]);
    expect(plan.toPayMinor).toBe(0);
  });

  it('1.3 — credit covers everything → only credit lines', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: 1000 }),
      candidate({ assignmentId: 'a2', dueMinor: 500 }),
    ];
    const plan = planSettlement(candidates, 2000, 0);
    expect(plan.creditAppliedMinor).toBe(1500);
    expect(plan.toPayMinor).toBe(0);
    expect(plan.creditAddedMinor).toBe(0);
    expect(plan.lines).toHaveLength(2);
    for (const line of plan.lines) {
      expect(line.source).toBe('credit');
      expect(line.coversFully).toBe(true);
    }
  });

  it('1.4 — credit partly covers → credit drains first, then cash', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: 1000 }),
      candidate({ assignmentId: 'a2', dueMinor: 500 }),
    ];
    const plan = planSettlement(candidates, 300, 1200);
    expect(plan.creditAppliedMinor).toBe(300);
    expect(plan.toPayMinor).toBe(1200);

    // credit 300 on the earliest fee, then payment 700 on it, then payment 500 on the second
    expect(plan.lines).toEqual([
      {
        assignmentId: 'a1',
        feeId: 'fee-a1',
        feeName: 'Fee a1',
        amountMinor: 300,
        source: 'credit',
        coversFully: false,
      },
      {
        assignmentId: 'a1',
        feeId: 'fee-a1',
        feeName: 'Fee a1',
        amountMinor: 700,
        source: 'payment',
        coversFully: true,
      },
      {
        assignmentId: 'a2',
        feeId: 'fee-a2',
        feeName: 'Fee a2',
        amountMinor: 500,
        source: 'payment',
        coversFully: true,
      },
    ]);
  });

  it('1.5 — no credit → cash only, oldest due first', () => {
    const jan = new Date('2024-01-01T00:00:00Z').getTime();
    const mar = new Date('2024-03-01T00:00:00Z').getTime();
    const candidates = [
      candidate({ assignmentId: 'a-none', dueMinor: 100, effectiveDueAt: Option.none() }),
      candidate({ assignmentId: 'a-mar', dueMinor: 100, effectiveDueAt: Option.some(mar) }),
      candidate({ assignmentId: 'a-jan', dueMinor: 100, effectiveDueAt: Option.some(jan) }),
    ];
    const plan = planSettlement(candidates, 0, 300);
    expect(plan.lines.map((l) => l.assignmentId)).toEqual(['a-jan', 'a-mar', 'a-none']);
  });

  it('1.6 — None due dates sort last, tie-broken by assignmentId ASC', () => {
    const candidates = [
      candidate({ assignmentId: 'c', dueMinor: 100 }),
      candidate({ assignmentId: 'a', dueMinor: 100 }),
      candidate({ assignmentId: 'b', dueMinor: 100 }),
    ];
    const plan = planSettlement(candidates, 0, 300);
    expect(plan.lines.map((l) => l.assignmentId)).toEqual(['a', 'b', 'c']);
  });

  it('1.7 — amount below outstanding leaves the last fee open', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', feeName: 'Fee One', dueMinor: 1000 }),
      candidate({ assignmentId: 'a2', feeName: 'Fee Two', dueMinor: 1000 }),
    ];
    const plan = planSettlement(candidates, 0, 1500);
    expect(plan.lines).toHaveLength(2);
    expect(plan.lines[0]).toMatchObject({ amountMinor: 1000, coversFully: true });
    expect(plan.lines[1]).toMatchObject({ amountMinor: 500, coversFully: false });
    expect(plan.fullyCoveredCount).toBe(1);
    expect(Option.isSome(plan.firstPartial)).toBe(true);
    if (Option.isSome(plan.firstPartial)) {
      expect(plan.firstPartial.value).toEqual({ feeName: 'Fee Two', remainingMinor: 500 });
    }
  });

  it('1.8 — overpayment: leftover becomes credit', () => {
    const candidates = [candidate({ assignmentId: 'a1', dueMinor: 1000 })];
    const plan = planSettlement(candidates, 0, 1500);
    expect(plan.toPayMinor).toBe(1000);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ amountMinor: 1000, source: 'payment' });
    expect(plan.creditAddedMinor).toBe(500);
  });

  it('1.9 — credit applied AND leftover added in the same plan', () => {
    const candidates = [candidate({ assignmentId: 'a1', dueMinor: 1000 })];
    const plan = planSettlement(candidates, 400, 1000);
    expect(plan.creditAppliedMinor).toBe(400);
    expect(plan.toPayMinor).toBe(600);
    expect(plan.creditAddedMinor).toBe(400);
    expect(plan.lines).toEqual([
      {
        assignmentId: 'a1',
        feeId: 'fee-a1',
        feeName: 'Fee a1',
        amountMinor: 400,
        source: 'credit',
        coversFully: false,
      },
      {
        assignmentId: 'a1',
        feeId: 'fee-a1',
        feeName: 'Fee a1',
        amountMinor: 600,
        source: 'payment',
        coversFully: true,
      },
    ]);
  });

  it('1.10 — a candidate already fully paid contributes nothing', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: 1000, paidMinor: 1000 }),
      candidate({ assignmentId: 'a2', dueMinor: 500, paidMinor: 0 }),
    ];
    const plan = planSettlement(candidates, 0, 500);
    expect(plan.outstandingMinor).toBe(500);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ assignmentId: 'a2', amountMinor: 500 });
  });

  it('1.11 — never emits a zero-amount line', () => {
    const candidates = [candidate({ assignmentId: 'a1', dueMinor: 1000 })];
    const plan = planSettlement(candidates, 0, 0);
    expect(plan.lines).toEqual([]);
  });

  it('1.12 — pure integers: 1 minor unit across two fees', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: 1 }),
      candidate({ assignmentId: 'a2', dueMinor: 1 }),
    ];
    const plan = planSettlement(candidates, 0, 1);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0].amountMinor).toBe(1);
    expect(Number.isInteger(plan.lines[0].amountMinor)).toBe(true);
  });

  it('a member owing nothing produces an all-zero plan with credit carried straight to creditAdded', () => {
    const plan = planSettlement([], 500, 500);
    expect(plan.outstandingMinor).toBe(0);
    expect(plan.creditAppliedMinor).toBe(0);
    expect(plan.toPayMinor).toBe(0);
    expect(plan.creditAddedMinor).toBe(500);
    expect(plan.lines).toEqual([]);
  });

  it('amountMinor: 0 with credit available produces a pure credit application (no payment lines)', () => {
    const candidates = [candidate({ assignmentId: 'a1', dueMinor: 1000 })];
    const plan = planSettlement(candidates, 1000, 0);
    expect(plan.creditAppliedMinor).toBe(1000);
    expect(plan.toPayMinor).toBe(0);
    expect(plan.creditAddedMinor).toBe(0);
    expect(plan.lines).toEqual([
      {
        assignmentId: 'a1',
        feeId: 'fee-a1',
        feeName: 'Fee a1',
        amountMinor: 1000,
        source: 'credit',
        coversFully: true,
      },
    ]);
  });

  it('every output field is an integer — no fractional field ever appears', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: 333, paidMinor: 111 }),
      candidate({ assignmentId: 'a2', dueMinor: 777 }),
    ];
    const plan = planSettlement(candidates, 250, 401);
    const numericFields = [
      plan.outstandingMinor,
      plan.creditAppliedMinor,
      plan.toPayMinor,
      plan.creditAddedMinor,
      plan.fullyCoveredCount,
      ...plan.lines.map((l) => l.amountMinor),
    ];
    for (const value of numericFields) {
      expect(Number.isInteger(value)).toBe(true);
    }
    if (Option.isSome(plan.firstPartial)) {
      expect(Number.isInteger(plan.firstPartial.value.remainingMinor)).toBe(true);
    }
  });

  it('large values well above 2^31 stay exact — nothing is doing int32 math', () => {
    // 2^31 - 1 = 2147483647. Use amounts several times that, in minor units (CZK haléře).
    const big = 5_000_000_000; // 5 billion minor units
    const candidates = [
      candidate({ assignmentId: 'a1', dueMinor: big }),
      candidate({ assignmentId: 'a2', dueMinor: big }),
    ];
    const plan = planSettlement(candidates, big, big * 2);
    expect(plan.outstandingMinor).toBe(big * 2);
    expect(plan.creditAppliedMinor).toBe(big);
    expect(plan.toPayMinor).toBe(big);
    expect(plan.creditAddedMinor).toBe(big);
    expect(plan.lines.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(big * 2);
    for (const line of plan.lines) {
      expect(Number.isInteger(line.amountMinor)).toBe(true);
    }
  });

  it('coversFully is true only when the candidate is fully paid off by this plan, false on a partial', () => {
    const candidates = [candidate({ assignmentId: 'a1', dueMinor: 1000 })];
    const plan = planSettlement(candidates, 0, 400);
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({ amountMinor: 400, coversFully: false });
    expect(plan.fullyCoveredCount).toBe(0);
    expect(Option.isSome(plan.firstPartial)).toBe(true);
  });

  it('firstPartial reports only the first partially-covered candidate in allocation order', () => {
    const candidates = [
      candidate({ assignmentId: 'a1', feeName: 'First', dueMinor: 100 }),
      candidate({ assignmentId: 'a2', feeName: 'Second', dueMinor: 100 }),
      candidate({ assignmentId: 'a3', feeName: 'Third', dueMinor: 100 }),
    ];
    // Fully covers a1, partially covers a2 (50 left), nothing for a3.
    const plan = planSettlement(candidates, 0, 150);
    expect(Option.isSome(plan.firstPartial)).toBe(true);
    if (Option.isSome(plan.firstPartial)) {
      expect(plan.firstPartial.value).toEqual({ feeName: 'Second', remainingMinor: 50 });
    }
  });
});
