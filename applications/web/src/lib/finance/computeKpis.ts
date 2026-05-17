import { DateTime, Option } from 'effect';

// ---------------------------------------------------------------------------
// Types (local mirror — avoids domain import in pure helpers)
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
// Return type
// ---------------------------------------------------------------------------

export type Kpis = {
  outstandingTotal: ReadonlyArray<{ currency: string; amountMinor: number }>;
  overdueCount: number;
  paidTotal: ReadonlyArray<{ currency: string; amountMinor: number }>;
  nextDue: Option.Option<{ effectiveDueAt: DateTime.Utc; amountMinor: number; currency: string }>;
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * Computes KPI values from the player's finance status groups.
 *
 * - outstandingTotal: per currency, only entries where totalOutstandingMinor > 0
 * - overdueCount: count of 'overdue' assignments across all groups
 * - paidTotal: per currency, sum of paidMinor across all assignments
 * - nextDue: earliest pending|partial due date, Option.none() if none
 */
export function computeKpis(groups: ReadonlyArray<MyFinanceStatus>): Kpis {
  const outstandingTotal: Array<{ currency: string; amountMinor: number }> = [];
  const paidTotalMap = new Map<string, number>();
  let overdueCount = 0;
  let nextDueAt: DateTime.Utc | undefined;
  let nextDueAmount: number | undefined;
  let nextDueCurrency: string | undefined;

  for (const group of groups) {
    // Outstanding total — use group's totalOutstandingMinor
    if (group.totalOutstandingMinor > 0) {
      outstandingTotal.push({ currency: group.currency, amountMinor: group.totalOutstandingMinor });
    }

    for (const assignment of group.assignments) {
      // Paid total — sum paidMinor per currency
      const existing = paidTotalMap.get(group.currency) ?? 0;
      paidTotalMap.set(group.currency, existing + assignment.paidMinor);

      // Overdue count
      if (assignment.status === 'overdue') {
        overdueCount++;
      }

      // Next due — only pending|partial with a defined effectiveDueAt
      if (assignment.status === 'pending' || assignment.status === 'partial') {
        if (Option.isSome(assignment.effectiveDueAt)) {
          const dueAt = assignment.effectiveDueAt.value;
          if (
            nextDueAt === undefined ||
            Number(DateTime.toEpochMillis(dueAt)) < Number(DateTime.toEpochMillis(nextDueAt))
          ) {
            nextDueAt = dueAt;
            nextDueAmount = assignment.dueMinor;
            nextDueCurrency = group.currency;
          }
        }
      }
    }
  }

  // Build paidTotal — only currencies with paidMinor > 0
  const paidTotal: Array<{ currency: string; amountMinor: number }> = [];
  for (const [currency, amountMinor] of paidTotalMap.entries()) {
    if (amountMinor > 0) {
      paidTotal.push({ currency, amountMinor });
    }
  }

  const nextDue: Option.Option<{
    effectiveDueAt: DateTime.Utc;
    amountMinor: number;
    currency: string;
  }> =
    nextDueAt !== undefined && nextDueAmount !== undefined && nextDueCurrency !== undefined
      ? Option.some({
          effectiveDueAt: nextDueAt,
          amountMinor: nextDueAmount,
          currency: nextDueCurrency,
        })
      : Option.none();

  return { outstandingTotal, overdueCount, paidTotal, nextDue };
}
