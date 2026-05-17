import { DateTime, Option } from 'effect';

// ---------------------------------------------------------------------------
// Types (local mirror — avoids domain import in pure helpers)
// ---------------------------------------------------------------------------

type FeeAssignmentStatus = 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';

export type FeeAssignmentView = {
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
// Sort group weights
// ---------------------------------------------------------------------------

function statusGroup(status: string): number {
  switch (status) {
    case 'overdue':
      return 0;
    case 'pending':
    case 'partial':
      return 1;
    case 'paid':
      return 2;
    case 'waived':
      return 3;
    default:
      return 4;
  }
}

// ---------------------------------------------------------------------------
// Comparators
// ---------------------------------------------------------------------------

const dateAscNoneLast = (
  a: Option.Option<DateTime.Utc>,
  b: Option.Option<DateTime.Utc>,
): number => {
  if (Option.isNone(a) && Option.isNone(b)) return 0;
  if (Option.isNone(a)) return 1; // none goes last
  if (Option.isNone(b)) return -1;
  const aMs = Number(DateTime.toEpochMillis(a.value));
  const bMs = Number(DateTime.toEpochMillis(b.value));
  return aMs < bMs ? -1 : aMs > bMs ? 1 : 0;
};

// ---------------------------------------------------------------------------
// Main sort function
// ---------------------------------------------------------------------------

/**
 * Sorts fee assignments per the plan's sort order:
 * 1. overdue — by effectiveDueAt asc (oldest first), Option.none() last
 * 2. pending | partial — by effectiveDueAt asc, Option.none() last
 * 3. paid — by feeName asc
 * 4. waived — by feeName asc (always last group)
 */
export function sortAssignments(
  assignments: ReadonlyArray<FeeAssignmentView>,
): ReadonlyArray<FeeAssignmentView> {
  return [...assignments].sort((a, b) => {
    const groupA = statusGroup(a.status);
    const groupB = statusGroup(b.status);

    if (groupA !== groupB) return groupA - groupB;

    // Same group — apply within-group sort
    switch (groupA) {
      case 0: // overdue
      case 1: // pending | partial
        return dateAscNoneLast(a.effectiveDueAt, b.effectiveDueAt);
      case 2: // paid
      case 3: // waived
        return a.feeName.localeCompare(b.feeName);
      default:
        return 0;
    }
  });
}
