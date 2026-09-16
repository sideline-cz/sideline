/**
 * Plan `.work-plans/fio-transaction-matching.md` §4 ("The matching engine") steps 1-3. The PURE
 * core of the decision table: it does not touch the database. The impure shell
 * (`BankTransactionMatcher.ts`) resolves the member from the VS, fetches candidate assignments
 * from `fee_assignment_status_v`, checks the step-2.5 duplicate pre-check, and folds
 * counterparty/member names — then hands the already-resolved FACTS to `decide()` below, which is
 * a total function over those facts.
 *
 * Governing principle: when in doubt, queue. Only two paths (case A and case B) auto-match.
 */
import type { BankTransaction } from '@sideline/domain';
import { Option } from 'effect';

export type MemberResolution =
  | { readonly _tag: 'NoVs' }
  | { readonly _tag: 'NoMember' }
  | { readonly _tag: 'Ambiguous' }
  | {
      readonly _tag: 'Resolved';
      readonly memberId: string;
      readonly memberNameFold: Option.Option<string>;
    };

export interface MatchCandidate {
  readonly assignmentId: string;
  readonly currency: string;
  readonly outstandingMinor: number;
  /** epoch ms, NULLS LAST when None. */
  readonly effectiveDueAt: Option.Option<number>;
}

export interface MatchDecisionInput {
  readonly member: MemberResolution;
  /** positive — outgoing rows never reach the engine. */
  readonly txAmountMinor: number;
  readonly txCurrency: string;
  readonly candidates: ReadonlyArray<MatchCandidate>;
  /** step 2.5 pre-check result. */
  readonly duplicateOfTransactionId: Option.Option<string>;
  /** accent-folded, for hints only — never sufficient to auto-match. */
  readonly counterpartyNameFold: Option.Option<string>;
}

export type MatchDecision =
  | {
      readonly _tag: 'AutoMatch';
      readonly assignmentId: string;
      readonly amountMinor: number;
      readonly rejectedCandidates: ReadonlyArray<{
        readonly assignmentId: string;
        readonly outstandingMinor: number;
      }>;
    }
  | {
      readonly _tag: 'Queue';
      readonly reason: BankTransaction.BankTransactionMatchReason;
      readonly duplicateOfTransactionId: Option.Option<string>;
      readonly suggestions: ReadonlyArray<string>;
    };

const queue = (
  reason: BankTransaction.BankTransactionMatchReason,
  input: MatchDecisionInput,
): MatchDecision => ({
  _tag: 'Queue',
  reason,
  duplicateOfTransactionId: input.duplicateOfTransactionId,
  suggestions: nameHintSuggestions(input),
});

/**
 * [R2 — B-cut-3] Hints are exact accent-folded name equality only — never sufficient to write a
 * payment. A member is "suggested" when the (already-folded) counterparty name equals the
 * (already-folded) resolved member's name.
 */
const nameHintSuggestions = (input: MatchDecisionInput): ReadonlyArray<string> => {
  if (input.member._tag !== 'Resolved') return [];
  if (Option.isNone(input.counterpartyNameFold) || Option.isNone(input.member.memberNameFold)) {
    return [];
  }
  return input.counterpartyNameFold.value === input.member.memberNameFold.value
    ? [input.member.memberId]
    : [];
};

/** Deterministic ordering: `effective_due_at ASC NULLS LAST, assignmentId ASC`. */
const compareCandidates = (a: MatchCandidate, b: MatchCandidate): number => {
  if (Option.isSome(a.effectiveDueAt) && Option.isSome(b.effectiveDueAt)) {
    if (a.effectiveDueAt.value !== b.effectiveDueAt.value) {
      return a.effectiveDueAt.value - b.effectiveDueAt.value;
    }
  } else if (Option.isSome(a.effectiveDueAt) !== Option.isSome(b.effectiveDueAt)) {
    // NULLS LAST — the one with a due date sorts first.
    return Option.isSome(a.effectiveDueAt) ? -1 : 1;
  }
  return a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0;
};

/** `decide` is TOTAL: every input produces exactly one of the two tags, never throws. */
export const decide = (input: MatchDecisionInput): MatchDecision => {
  // Step 1 — member resolution (case H).
  if (input.member._tag === 'NoVs') return queue('no_vs', input);
  if (input.member._tag === 'NoMember') return queue('no_member_for_vs', input);
  if (input.member._tag === 'Ambiguous') return queue('ambiguous_member', input);

  // Step 2 — currency handling (44, 45): if EVERY candidate's currency differs from the
  // transaction's, queue currency_mismatch; otherwise drop the foreign-currency candidates and
  // continue with the rest.
  if (
    input.candidates.length > 0 &&
    input.candidates.every((c) => c.currency !== input.txCurrency)
  ) {
    return queue('currency_mismatch', input);
  }
  const candidates = input.candidates.filter((c) => c.currency === input.txCurrency);

  // Step 2.5 — duplicate pre-check takes precedence over every case below.
  if (Option.isSome(input.duplicateOfTransactionId)) {
    return queue('no_open_assignment', input);
  }

  // Case G — zero candidates.
  if (candidates.length === 0) return queue('no_open_assignment', input);

  const sorted = [...candidates].sort(compareCandidates);
  const exactMatches = sorted.filter((c) => c.outstandingMinor === input.txAmountMinor);

  if (sorted.length === 1) {
    const only = sorted[0];
    if (only === undefined) return queue('no_open_assignment', input);
    // Case A — exactly one candidate, amount == outstanding.
    if (only.outstandingMinor === input.txAmountMinor) {
      return {
        _tag: 'AutoMatch',
        assignmentId: only.assignmentId,
        amountMinor: input.txAmountMinor,
        rejectedCandidates: [],
      };
    }
    // Case D — underpayment.
    if (input.txAmountMinor < only.outstandingMinor) return queue('amount_mismatch_under', input);
    // Case E — overpayment.
    return queue('overpayment', input);
  }

  // sorted.length >= 2
  if (exactMatches.length === 1) {
    // Case B — exactly one exact match among 2+ candidates auto-matches; every rejected
    // candidate (including non-exact ones) is recorded in the evidence payload.
    const winner = exactMatches[0];
    if (winner === undefined) return queue('no_open_assignment', input);
    const rejectedCandidates = sorted
      .filter((c) => c.assignmentId !== winner.assignmentId)
      .map((c) => ({ assignmentId: c.assignmentId, outstandingMinor: c.outstandingMinor }));
    return {
      _tag: 'AutoMatch',
      assignmentId: winner.assignmentId,
      amountMinor: input.txAmountMinor,
      rejectedCandidates,
    };
  }
  if (exactMatches.length >= 2) {
    // Case C — >=2 candidates match exactly.
    return queue('ambiguous_multiple_exact', input);
  }
  // Case F — >=2 candidates, none exact.
  return queue('ambiguous_multiple_open', input);
};
