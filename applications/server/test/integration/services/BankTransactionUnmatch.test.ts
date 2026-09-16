// TDD mode — tests written BEFORE `BankTransactionMatcher.ts`'s `unmatch` method exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §4 ("/unmatch") / D10c / §7.2 tests 152-156, 140b.
//
// Contract this file pins down, extending `BankTransactionMatcher.ts`'s service interface:
//
//   unmatch(
//     txId: BankTransactionId,
//     input: {
//       reason: string;
//       unmatchedByUserId: Auth.UserId;
//       /** Test-only seam (test 140b), mirroring `afterCandidateRead`: runs INSIDE the same
//        * transaction, right after every linked payment has been voided and BEFORE
//        * `bank_transactions` is updated. Defaults to `Effect.void`. */
//       afterVoids?: Effect.Effect<void>;
//     },
//   ): Effect<void, ...>
//     — in ONE transaction, lock order `payments` (id ASC) -> `bank_transactions` (D10c):
//       1. void every active payment linked to txId (PaymentsRepository.void_, id ASC — never
//          hard-delete);
//       2. THEN set bank_transactions.auto_match_suppressed = true, match_reason = NULL.
//       Requires reason.length >= 3, validated BEFORE any write.

import { describe, expect, it } from '@effect/vitest';
import { Deferred, Effect, Fiber, Layer } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { BankTransactionMatcher } from '~/services/BankTransactionMatcher.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  enableBankSync,
  insertBankTransaction,
  nextDiscordId,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const RepoLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
);
const TestLayer = Layer.mergeAll(RepoLayer, BankTransactionMatcher.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seed = (outstandingMinor = 1500) =>
  Effect.gen(function* () {
    const user = yield* createUser('treasurer');
    const team = yield* createTeam(nextDiscordId(), user.id);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    yield* enableBankSync(team.id, user.id);
    const memberUser = yield* createUser('player');
    const member = yield* createTeamMember(team.id, memberUser.id);
    const { assignment } = yield* createFeeAndAssignment(team.id, member.id, outstandingMinor);
    const txId = yield* insertBankTransaction(team.id, {
      fioMovementId: 1,
      bookedOn: '2024-03-01',
      amountMinor: outstandingMinor,
    });
    return { user, team, member, assignment, txId };
  });

const insertLinkedPayment = (
  assignmentId: string,
  memberId: string,
  userId: string,
  txId: string,
  amountMinor: number,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id, bank_transaction_id, matched_by)
        VALUES (${assignmentId}, ${memberId}, ${amountMinor}, 'bank_transfer', now(), ${userId}, ${txId}, 'auto')
        RETURNING id
      `,
    ),
    Effect.map((rows) => rows[0]?.id as string),
  );

// ---------------------------------------------------------------------------
// 152 / 153 — unmatch voids, never hard-deletes; recomputes paid_minor and match_state
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — voids, never deletes (152, 153)', () => {
  it.effect('the payment row still exists with all three void columns set', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      const paymentId = yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();

      yield* matcher.unmatch(txId as never, { reason: 'wrong member', unmatchedByUserId: user.id });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{
        voided_at: Date | null;
        voided_by_user_id: string | null;
        void_reason: string | null;
      }>`
        SELECT voided_at, voided_by_user_id, void_reason FROM payments WHERE id = ${paymentId}
      `;
      expect(rows[0]?.voided_at).not.toBeNull();
      expect(rows[0]?.voided_by_user_id).toBe(user.id);
      expect(rows[0]?.void_reason).toBe('wrong member');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('paid_minor is recomputed down and match_state returns to unmatched', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      yield* matcher.unmatch(txId as never, { reason: 'wrong member', unmatchedByUserId: user.id });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const assignmentRow = yield* sql<{
        paid_minor: string;
      }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`;
      const txRow = yield* sql<{
        match_state: string;
      }>`SELECT match_state FROM bank_transactions WHERE id = ${txId}`;
      expect(assignmentRow[0]?.paid_minor).toBe('0');
      expect(txRow[0]?.match_state).toBe('unmatched');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 154 — auto_match_suppressed is set, and a subsequent auto-match does not re-apply
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — auto_match_suppressed (154)', () => {
  it.effect('auto_match_suppressed is set after unmatch; matchOne is then a no-op', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();
      yield* matcher.unmatch(txId as never, { reason: 'wrong member', unmatchedByUserId: user.id });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const suppressed = yield* sql<{ auto_match_suppressed: boolean }>`
        SELECT auto_match_suppressed FROM bank_transactions WHERE id = ${txId}
      `;
      expect(suppressed[0]?.auto_match_suppressed).toBe(true);

      const outcome = yield* matcher.matchOne(txId as never);
      expect(outcome._tag).toBe('Queued'); // never silently re-applies the undone match
      const paidMinor = yield* sql<{
        paid_minor: string;
      }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`;
      expect(paidMinor[0]?.paid_minor).toBe('0');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 155 — a split unmatch voids EVERY linked payment
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — splits (155)', () => {
  it.effect('unmatching a transaction linked to multiple payments voids all of them', () =>
    Effect.gen(function* () {
      const { user, team, member, assignment: assignment1, txId } = yield* seed(2000);
      const { assignment: assignment2 } = yield* createFeeAndAssignment(team.id, member.id, 500);
      const payment1 = yield* insertLinkedPayment(assignment1.id, member.id, user.id, txId, 1500);
      const payment2 = yield* insertLinkedPayment(assignment2.id, member.id, user.id, txId, 500);

      const matcher = yield* BankTransactionMatcher.asEffect();
      yield* matcher.unmatch(txId as never, {
        reason: 'split reversal',
        unmatchedByUserId: user.id,
      });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ id: string; voided_at: Date | null }>`
        SELECT id, voided_at FROM payments WHERE id IN (${payment1}, ${payment2})
      `;
      expect(rows).toHaveLength(2);
      for (const row of rows) expect(row.voided_at).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 156 — unmatch without a reason is rejected before any write
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — reason required, validated before any write (156)', () => {
  it.effect('an empty/too-short reason is rejected and nothing is written', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      const paymentId = yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      const matcher = yield* BankTransactionMatcher.asEffect();

      const result = yield* Effect.result(
        matcher.unmatch(txId as never, { reason: 'ab', unmatchedByUserId: user.id }),
      );
      expect(result._tag).toBe('Failure');

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{
        voided_at: Date | null;
      }>`SELECT voided_at FROM payments WHERE id = ${paymentId}`;
      expect(rows[0]?.voided_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 140b — lock-order deadlock: /unmatch vs voidPayment, forced to interleave deterministically
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — lock order vs voidPayment (140b, D10c defect a)', () => {
  it.effect(
    '/unmatch on connection 1 races a concurrent voidPayment of the SAME payment on connection ' +
      '2 that is manually held mid-transaction (payments row locked, nothing else touched yet) — ' +
      'neither side raises 40P01. Connection 1 parks via `beforeVoids`, BEFORE taking a single ' +
      'lock: an `afterVoids`-only seam fires too late to construct this — by then connection 1 ' +
      'already holds every lock it will ever take (payments, and transitively bank_transactions ' +
      'and fee_assignments via the void trigger), so a concurrent voidPayment can only block on ' +
      'an already-fully-locked row, never race it. This construction WOULD observe a real 40P01 ' +
      'if `unmatch` regressed to lock `bank_transactions` before voiding: connection 2 would then ' +
      'hold `payments` while waiting on `bank_transactions` (held by the regressed connection 1), ' +
      'and connection 1 would hold `bank_transactions` while waiting on `payments` (held by ' +
      'connection 2) — a genuine two-way cycle.',
    () =>
      Effect.scoped(
        // `it.effect` auto-provides a virtual `TestClock`, under which a bare `Effect.sleep`
        // never resolves without an explicit `TestClock.adjust` — the `Effect.sleep('200
        // millis')` below is a real "let the other connection's row-lock wait actually start"
        // grace period, not a timing assertion, so this opts back into the live clock rather
        // than faking time (same technique as `BankSyncConfigRepository.test.ts` 102b).
        TestClock.withLive(
          Effect.gen(function* () {
            const { user, member, assignment, txId } = yield* seed(1500);
            const paymentId = yield* insertLinkedPayment(
              assignment.id,
              member.id,
              user.id,
              txId,
              1500,
            );

            const parked1 = yield* Deferred.make<void>();
            const release1 = yield* Deferred.make<void>();
            const holding2 = yield* Deferred.make<void>();
            const release2 = yield* Deferred.make<void>();

            // Connection 1's unmatch parks at the very TOP of its transaction — before the
            // `paymentIds` SELECT, before anything is locked at all.
            const matcher1 = yield* BankTransactionMatcher.asEffect();
            const fiberUnmatch = yield* Effect.forkChild(
              matcher1.unmatch(txId as never, {
                reason: 'race test',
                unmatchedByUserId: user.id,
                beforeVoids: Deferred.succeed(parked1, undefined).pipe(
                  Effect.asVoid,
                  Effect.andThen(Deferred.await(release1)),
                ),
              }),
            );
            yield* Deferred.await(parked1);

            // Connection 2 manually takes JUST the payments row lock (a bare `FOR UPDATE` fires
            // no trigger) and parks holding only that — mirroring the first half of what
            // `PaymentsRepository.void_`'s single UPDATE statement does internally, but with a
            // controllable pause in between so the test can force the interleaving.
            const sql2 = yield* secondTestPgClient;
            const fiberVoid2 = yield* Effect.forkChild(
              sql2.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(
                    () => sql2`SELECT id FROM payments WHERE id = ${paymentId} FOR UPDATE`,
                  ),
                  Effect.tap(() => Deferred.succeed(holding2, undefined)),
                  Effect.tap(() => Deferred.await(release2)),
                  Effect.tap(
                    () => sql2`
                      UPDATE payments
                      SET voided_at = now(), voided_by_user_id = ${user.id},
                          void_reason = 'concurrent void from the finance API'
                      WHERE id = ${paymentId}
                    `,
                  ),
                  Effect.asVoid,
                ),
              ),
            );
            yield* Deferred.await(holding2);

            // Release connection 1: its first real statement is the `paymentIds` SELECT ... FOR
            // UPDATE, which now genuinely blocks on the row connection 2 already holds.
            yield* Deferred.succeed(release1, undefined);
            yield* Effect.sleep('200 millis'); // let connection 1 actually start blocking on the row

            // Release connection 2: it can now complete its UPDATE (it already owns the row's
            // lock) and proceed through the trigger to bank_transactions/fee_assignments — for
            // the correct (payments-first) `unmatch`, those are still free, so connection 2
            // commits cleanly and connection 1 unblocks to find nothing left to void.
            yield* Deferred.succeed(release2, undefined);

            const unmatchResult = yield* Effect.result(Fiber.join(fiberUnmatch));
            const voidResult = yield* Effect.result(Fiber.join(fiberVoid2));

            // Whichever ran first legitimately "wins" the void (the loser is a no-op via
            // `WHERE voided_at IS NULL`); the only hard requirement is that NEITHER side observed
            // a Postgres deadlock (40P01).
            for (const result of [voidResult, unmatchResult]) {
              if (result._tag === 'Failure') {
                const serialised = JSON.stringify(result).toLowerCase();
                expect(serialised).not.toContain('40p01');
                expect(serialised).not.toContain('deadlock');
              }
            }
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});
