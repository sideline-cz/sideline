import { Option } from 'effect';

/**
 * Pure allocation of a settle-all payment across a member's outstanding fee assignments
 * plus their credit balance.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules"). Shared,
 * unmodified, by the client's settlement preview and the server's
 * `MemberCreditsRepository.settle` (the `CzIban` / `Spayd` precedent) — "preview and server
 * must agree" is a type-level fact, not a convention.
 *
 * Candidates are sorted `effectiveDueAt` ascending with `Option.none()` last, tie-broken by
 * `assignmentId` ascending. The credit pool is drained to exhaustion before the cash pool,
 * walking candidates in that same order. Integer minor units only — no division, no
 * `Math.round`/`Math.floor` beyond the explicit `Math.max(0, …)` clamps below.
 */

export interface SettlementCandidate {
  readonly assignmentId: string;
  readonly feeId: string;
  readonly feeName: string;
  readonly dueMinor: number;
  readonly paidMinor: number;
  // epoch ms
  readonly effectiveDueAt: Option.Option<number>;
}

export interface SettlementLine {
  readonly assignmentId: string;
  readonly feeId: string;
  readonly feeName: string;
  readonly amountMinor: number;
  readonly source: 'credit' | 'payment';
  readonly coversFully: boolean;
}

export interface SettlementPlan {
  readonly outstandingMinor: number;
  readonly creditAppliedMinor: number;
  // outstanding − creditApplied
  readonly toPayMinor: number;
  // max(0, amount − toPay)
  readonly creditAddedMinor: number;
  readonly lines: ReadonlyArray<SettlementLine>;
  readonly fullyCoveredCount: number;
  readonly firstPartial: Option.Option<{ feeName: string; remainingMinor: number }>;
}

const compareCandidates = (a: SettlementCandidate, b: SettlementCandidate): number => {
  const aDue = a.effectiveDueAt;
  const bDue = b.effectiveDueAt;

  if (Option.isSome(aDue) && Option.isSome(bDue) && aDue.value !== bDue.value) {
    return aDue.value - bDue.value;
  }
  if (Option.isSome(aDue) !== Option.isSome(bDue)) {
    // None sorts last
    return Option.isSome(aDue) ? -1 : 1;
  }

  if (a.assignmentId < b.assignmentId) return -1;
  if (a.assignmentId > b.assignmentId) return 1;
  return 0;
};

export const planSettlement = (
  candidates: ReadonlyArray<SettlementCandidate>,
  creditMinor: number,
  amountMinor: number,
): SettlementPlan => {
  const sorted = [...candidates].sort(compareCandidates);

  const outstandingMinor = sorted.reduce(
    (sum, candidate) => sum + Math.max(0, candidate.dueMinor - candidate.paidMinor),
    0,
  );

  const creditAppliedMinor = Math.min(creditMinor, outstandingMinor);
  const toPayMinor = outstandingMinor - creditAppliedMinor;
  const cashUsedMinor = Math.min(amountMinor, toPayMinor);
  const creditAddedMinor = amountMinor - cashUsedMinor;

  let creditPool = creditAppliedMinor;
  let cashPool = cashUsedMinor;
  let fullyCoveredCount = 0;
  let firstPartial: Option.Option<{ feeName: string; remainingMinor: number }> = Option.none();

  const lines: Array<SettlementLine> = [];

  for (const candidate of sorted) {
    let remaining = Math.max(0, candidate.dueMinor - candidate.paidMinor);
    if (remaining === 0) continue;

    const creditForThis = Math.min(creditPool, remaining);
    if (creditForThis > 0) {
      creditPool -= creditForThis;
      remaining -= creditForThis;
      lines.push({
        assignmentId: candidate.assignmentId,
        feeId: candidate.feeId,
        feeName: candidate.feeName,
        amountMinor: creditForThis,
        source: 'credit',
        coversFully: remaining === 0,
      });
    }

    const cashForThis = Math.min(cashPool, remaining);
    if (cashForThis > 0) {
      cashPool -= cashForThis;
      remaining -= cashForThis;
      lines.push({
        assignmentId: candidate.assignmentId,
        feeId: candidate.feeId,
        feeName: candidate.feeName,
        amountMinor: cashForThis,
        source: 'payment',
        coversFully: remaining === 0,
      });
    }

    if (remaining === 0) {
      fullyCoveredCount += 1;
    } else if (Option.isNone(firstPartial)) {
      firstPartial = Option.some({ feeName: candidate.feeName, remainingMinor: remaining });
    }
  }

  return {
    outstandingMinor,
    creditAppliedMinor,
    toPayMinor,
    creditAddedMinor,
    lines,
    fullyCoveredCount,
    firstPartial,
  };
};
