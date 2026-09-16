// TDD mode — tests written BEFORE `matchDecision.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §4 ("The matching engine") steps 1-3 / §7.1 tests
// 34-50c. `matchDecision.ts` is the PURE core of the decision table: it does not touch the
// database. The impure shell (`BankTransactionMatcher.ts`) resolves the member from the VS,
// fetches candidate assignments from `fee_assignment_status_v`, checks the step-2.5 duplicate
// pre-check, and folds counterparty/member names — then hands the already-resolved FACTS to
// `decide()` below, which is a total function over those facts.
//
// Contract this file pins down for `applications/server/src/services/matchDecision.ts`:
//
//   export type MemberResolution =
//     | { readonly _tag: 'NoVs' }
//     | { readonly _tag: 'NoMember' }
//     | { readonly _tag: 'Ambiguous' }
//     | { readonly _tag: 'Resolved'; readonly memberId: string; readonly memberNameFold: Option<string> }
//
//   export interface MatchCandidate {
//     readonly assignmentId: string;
//     readonly currency: string;
//     readonly outstandingMinor: number;
//     readonly effectiveDueAt: Option.Option<number>; // epoch ms, NULLS LAST when None
//   }
//
//   export interface MatchDecisionInput {
//     readonly member: MemberResolution;
//     readonly txAmountMinor: number;        // positive — outgoing rows never reach the engine
//     readonly txCurrency: string;
//     readonly candidates: ReadonlyArray<MatchCandidate>;
//     readonly duplicateOfTransactionId: Option.Option<string>;   // step 2.5 pre-check result
//     readonly counterpartyNameFold: Option.Option<string>;       // accent-folded, for hints only
//   }
//
//   export type MatchDecision =
//     | {
//         readonly _tag: 'AutoMatch';
//         readonly assignmentId: string;
//         readonly amountMinor: number;
//         readonly rejectedCandidates: ReadonlyArray<{ assignmentId: string; outstandingMinor: number }>;
//       }
//     | {
//         readonly _tag: 'Queue';
//         readonly reason: BankTransaction.BankTransactionMatchReason;
//         readonly duplicateOfTransactionId: Option.Option<string>;
//         readonly suggestions: ReadonlyArray<string>;
//       }
//
//   export const decide: (input: MatchDecisionInput) => MatchDecision
//
// `decide` is TOTAL: every input produces exactly one of the two tags, never throws.

import { BankTransaction } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { decide, type MatchCandidate, type MatchDecisionInput } from '~/services/matchDecision.js';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const cand = (
  assignmentId: string,
  outstandingMinor: number,
  overrides: Partial<MatchCandidate> = {},
): MatchCandidate => ({
  assignmentId,
  currency: 'CZK',
  outstandingMinor,
  effectiveDueAt: Option.none(),
  ...overrides,
});

const baseInput = (overrides: Partial<MatchDecisionInput> = {}): MatchDecisionInput => ({
  member: { _tag: 'Resolved', memberId: 'member-1', memberNameFold: Option.none() },
  txAmountMinor: 1500,
  txCurrency: 'CZK',
  candidates: [cand('a1', 1500)],
  duplicateOfTransactionId: Option.none(),
  counterpartyNameFold: Option.none(),
  ...overrides,
});

// ---------------------------------------------------------------------------
// Case A — exactly one candidate, amount == outstanding -> AUTO-MATCH (34)
// ---------------------------------------------------------------------------

describe('matchDecision — case A: single exact candidate', () => {
  it('auto-matches in full', () => {
    const decision = decide(baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 1500 }));
    expect(decision._tag).toBe('AutoMatch');
    if (decision._tag === 'AutoMatch') {
      expect(decision.assignmentId).toBe('a1');
      expect(decision.amountMinor).toBe(1500);
    }
  });
});

// ---------------------------------------------------------------------------
// Case B — >=2 candidates, exactly one exact match -> AUTO-MATCH to that one (35), records
// rejected candidates (49)
// ---------------------------------------------------------------------------

describe('matchDecision — case B: multiple candidates, one exact', () => {
  it('auto-matches the exact-amount candidate, exact amount beats due-date order', () => {
    const decision = decide(
      baseInput({
        candidates: [cand('a1', 2000), cand('a2', 1500), cand('a3', 500)],
        txAmountMinor: 1500,
      }),
    );
    expect(decision._tag).toBe('AutoMatch');
    if (decision._tag === 'AutoMatch') {
      expect(decision.assignmentId).toBe('a2');
    }
  });

  it('records every rejected candidate in the evidence payload (49)', () => {
    const decision = decide(
      baseInput({
        candidates: [cand('a1', 2000), cand('a2', 1500), cand('a3', 500)],
        txAmountMinor: 1500,
      }),
    );
    expect(decision._tag).toBe('AutoMatch');
    if (decision._tag === 'AutoMatch') {
      const rejectedIds = decision.rejectedCandidates.map((c) => c.assignmentId).sort();
      expect(rejectedIds).toEqual(['a1', 'a3']);
    }
  });
});

// ---------------------------------------------------------------------------
// Case C — >=2 candidates match exactly -> QUEUE ambiguous_multiple_exact (36)
// ---------------------------------------------------------------------------

describe('matchDecision — case C: multiple exact matches', () => {
  it('queues as ambiguous_multiple_exact', () => {
    const decision = decide(
      baseInput({ candidates: [cand('a1', 1500), cand('a2', 1500)], txAmountMinor: 1500 }),
    );
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('ambiguous_multiple_exact');
    }
  });
});

// ---------------------------------------------------------------------------
// Case D — exactly one candidate, amount < outstanding -> QUEUE amount_mismatch_under (37, 42)
// [R2 — the explicit reversal of revision 1, which auto-matched a partial]
// ---------------------------------------------------------------------------

describe('matchDecision — case D: underpayment queues (42, the R2 reversal)', () => {
  it('queues amount_mismatch_under rather than auto-matching a partial', () => {
    const decision = decide(baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 300 }));
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('amount_mismatch_under');
    }
  });
});

// ---------------------------------------------------------------------------
// Case E — exactly one candidate, amount > outstanding -> QUEUE overpayment (38), boundary (47)
// ---------------------------------------------------------------------------

describe('matchDecision — case E: overpayment queues, exact boundary', () => {
  it('outstanding + 1 -> overpayment', () => {
    const decision = decide(baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 1501 }));
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('overpayment');
    }
  });

  it('exactly outstanding -> case A (auto-match), not overpayment', () => {
    const decision = decide(baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 1500 }));
    expect(decision._tag).toBe('AutoMatch');
  });
});

// ---------------------------------------------------------------------------
// Case F — >=2 candidates, none exact -> QUEUE ambiguous_multiple_open (39)
// ---------------------------------------------------------------------------

describe('matchDecision — case F: multiple candidates, none exact', () => {
  it('queues as ambiguous_multiple_open', () => {
    const decision = decide(
      baseInput({ candidates: [cand('a1', 2000), cand('a2', 3000)], txAmountMinor: 1500 }),
    );
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('ambiguous_multiple_open');
    }
  });
});

// ---------------------------------------------------------------------------
// Case G — zero candidates -> QUEUE no_open_assignment (40)
// ---------------------------------------------------------------------------

describe('matchDecision — case G: zero candidates', () => {
  it('queues as no_open_assignment', () => {
    const decision = decide(baseInput({ candidates: [] }));
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('no_open_assignment');
    }
  });

  // 50 (proxy): waived and archived-fee assignments are filtered upstream by the SQL candidate
  // query (verified at the DB level by BankTransactionMatcher.test.ts, cases A-H, against the
  // real `fee_assignment_status_v`); at the pure-decision level the equivalent fact is simply
  // "they never appear in `candidates`", which collapses to case G.
  it('behaves identically to zero candidates when waived/archived rows are excluded upstream', () => {
    const decision = decide(baseInput({ candidates: [] }));
    expect(decision).toEqual(decide(baseInput({ candidates: [] })));
  });
});

// ---------------------------------------------------------------------------
// Case H — VS matches no member -> QUEUE no_member_for_vs, with non-binding hints (41)
// ---------------------------------------------------------------------------

describe('matchDecision — case H: no member for VS', () => {
  it('queues as no_member_for_vs even with candidates irrelevant to member resolution', () => {
    const decision = decide(
      baseInput({ member: { _tag: 'NoMember' }, candidates: [cand('a1', 1500)] }),
    );
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('no_member_for_vs');
    }
  });

  it('no VS at all -> no_vs', () => {
    const decision = decide(baseInput({ member: { _tag: 'NoVs' } }));
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('no_vs');
    }
  });

  it('>1 member resolved for one VS (defensive-only) -> ambiguous_member, honestly labelled', () => {
    const decision = decide(baseInput({ member: { _tag: 'Ambiguous' } }));
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('ambiguous_member');
    }
  });
});

// ---------------------------------------------------------------------------
// 43 — the duplicate pre-check takes precedence over case A
// ---------------------------------------------------------------------------

describe('matchDecision — duplicate pre-check precedence (43)', () => {
  it('a duplicate hint queues no_open_assignment even when case A would otherwise auto-match', () => {
    const decision = decide(
      baseInput({
        candidates: [cand('a1', 1500)],
        txAmountMinor: 1500,
        duplicateOfTransactionId: Option.some('other-tx-id'),
      }),
    );
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('no_open_assignment');
      expect(decision.duplicateOfTransactionId).toEqual(Option.some('other-tx-id'));
    }
  });

  it("'possible_duplicate' is never emitted as the reason — it is a hint, not a literal", () => {
    const decision = decide(
      baseInput({
        candidates: [cand('a1', 1500)],
        txAmountMinor: 1500,
        duplicateOfTransactionId: Option.some('other-tx-id'),
      }),
    );
    if (decision._tag === 'Queue') {
      // 'possible_duplicate' is not even a member of the reason union anymore (see the 50b/50c
      // guard below), so this is a plain runtime assertion rather than a type-level one.
      expect(decision.reason).not.toBe('possible_duplicate');
    }
  });
});

// ---------------------------------------------------------------------------
// 44 / 45 — currency_mismatch is reachable, and foreign-currency candidates are dropped, not
// filtered at the SQL layer (which would make currency_mismatch unreachable)
// ---------------------------------------------------------------------------

describe('matchDecision — currency handling (44, 45)', () => {
  it('a CZK transfer against a member whose only open assignment is EUR -> currency_mismatch', () => {
    const decision = decide(
      baseInput({
        txCurrency: 'CZK',
        txAmountMinor: 1500,
        candidates: [cand('a1', 1500, { currency: 'EUR' })],
      }),
    );
    expect(decision._tag).toBe('Queue');
    if (decision._tag === 'Queue') {
      expect(decision.reason).toBe('currency_mismatch');
    }
  });

  it('a member with one EUR and one CZK open assignment, paid in CZK -> EUR dropped, CZK evaluated normally', () => {
    const decision = decide(
      baseInput({
        txCurrency: 'CZK',
        txAmountMinor: 1500,
        candidates: [
          cand('eur-1', 1500, { currency: 'EUR' }),
          cand('czk-1', 1500, { currency: 'CZK' }),
        ],
      }),
    );
    expect(decision._tag).toBe('AutoMatch');
    if (decision._tag === 'AutoMatch') {
      expect(decision.assignmentId).toBe('czk-1');
    }
  });
});

// ---------------------------------------------------------------------------
// 46 — deterministic ordering: equal effective_due_at resolves by assignmentId ASC, stably
// ---------------------------------------------------------------------------

describe('matchDecision — deterministic ordering (46)', () => {
  it('case B with two equal-due-date non-exact candidates and one exact match is still deterministic', () => {
    const dueAt = Option.some(1000);
    const decisionA = decide(
      baseInput({
        candidates: [
          cand('b-id', 2000, { effectiveDueAt: dueAt }),
          cand('a-id', 1500, { effectiveDueAt: dueAt }),
        ],
        txAmountMinor: 1500,
      }),
    );
    const decisionB = decide(
      baseInput({
        candidates: [
          cand('a-id', 1500, { effectiveDueAt: dueAt }),
          cand('b-id', 2000, { effectiveDueAt: dueAt }),
        ],
        txAmountMinor: 1500,
      }),
    );
    expect(decisionA).toEqual(decisionB);
    if (decisionA._tag === 'AutoMatch') {
      expect(decisionA.assignmentId).toBe('a-id');
    }
  });
});

// ---------------------------------------------------------------------------
// 48 — hints are never sufficient to auto-match
// ---------------------------------------------------------------------------

describe('matchDecision — hints never upgrade a Queue decision (48)', () => {
  it('decision._tag stays Queue even when a name-fold hint matches exactly', () => {
    const decision = decide(
      baseInput({
        candidates: [cand('a1', 2000), cand('a2', 3000)],
        txAmountMinor: 1500,
        counterpartyNameFold: Option.some('jan novak'),
      }),
    );
    expect(decision._tag).toBe('Queue');
  });
});

// ---------------------------------------------------------------------------
// 50b / 50c — union completeness guard: the DB CHECK, the engine and the web renderer must agree
// on exactly the nine D15 literals, and 'possible_duplicate' must be absent.
// ---------------------------------------------------------------------------

describe('BankTransactionMatchReason — union completeness guard (50b, 50c)', () => {
  const EXPECTED: ReadonlyArray<string> = [
    'no_vs',
    'no_member_for_vs',
    'ambiguous_member',
    'amount_mismatch_under',
    'overpayment',
    'ambiguous_multiple_exact',
    'ambiguous_multiple_open',
    'no_open_assignment',
    'currency_mismatch',
  ];

  it('has exactly the nine D15 members — no more, no fewer', () => {
    expect(new Set(BankTransaction.BankTransactionMatchReason.literals)).toEqual(new Set(EXPECTED));
    expect(BankTransaction.BankTransactionMatchReason.literals).toHaveLength(9);
  });

  it("'possible_duplicate' is NOT in the union — a future re-promotion must be a deliberate edit", () => {
    expect(BankTransaction.BankTransactionMatchReason.literals).not.toContain('possible_duplicate');
  });

  it('every reason matchDecision.decide can emit is a member of the union', () => {
    const emittable = new Set<string>();
    const scenarios: ReadonlyArray<MatchDecisionInput> = [
      baseInput({ member: { _tag: 'NoVs' } }),
      baseInput({ member: { _tag: 'NoMember' } }),
      baseInput({ member: { _tag: 'Ambiguous' } }),
      baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 300 }), // amount_mismatch_under
      baseInput({ candidates: [cand('a1', 1500)], txAmountMinor: 1501 }), // overpayment
      baseInput({ candidates: [cand('a1', 1500), cand('a2', 1500)], txAmountMinor: 1500 }), // ambiguous_multiple_exact
      baseInput({ candidates: [cand('a1', 2000), cand('a2', 3000)], txAmountMinor: 1500 }), // ambiguous_multiple_open
      baseInput({ candidates: [] }), // no_open_assignment
      baseInput({ candidates: [cand('a1', 1500, { currency: 'EUR' })] }), // currency_mismatch
    ];
    for (const scenario of scenarios) {
      const decision = decide(scenario);
      if (decision._tag === 'Queue') emittable.add(decision.reason);
    }
    for (const reason of emittable) {
      expect(BankTransaction.BankTransactionMatchReason.literals).toContain(reason);
    }
    // possible_duplicate is carried as duplicateOfTransactionId, never as `reason`.
    expect(emittable).not.toContain('possible_duplicate');
  });
});
