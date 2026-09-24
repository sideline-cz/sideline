// TDD mode — tests written BEFORE `MemberCreditsRepository` exists, and before
// `BankTransactionMatcher.unmatch`'s hoisted account lock (§3.2) and `PaymentsRepository.void_`'s
// account pre-lock (§6.4) are implemented. These tests WILL FAIL to even COMPILE until
// `MemberCreditsRepository.ts` exists (exporting both the service class with `.Default` AND a
// top-level `make(options?)`, mirroring `BankTransactionMatcher.ts`), and they are expected to
// stay RED (or hang, see below) until tasks 6-8 of the architecture's ordered breakdown land.
//
// `.work-plans/finances/settle-all-and-credit-architecture.md` §3 (lock acquisition rule), §3.1,
// §3.2 (the hoisted account lock), T5.
//
// [R2] Harness warning this file exists to satisfy: `applications/server/test/integration/api/
// finance.test.ts` builds the API over in-memory `Map`s — there is no transaction, no row lock,
// no 40P01, and a seam like `afterAccountLock` means nothing there. Every test in this file uses
// REAL Postgres, `TestPgClient` + `secondTestPgClient`, and the real seams, following the working
// Deferred-parking precedent at `test/integration/services/BankTransactionUnmatch.test.ts:258-330`.
//
// Every transaction THIS FILE constructs directly (the barrier connections) opens with
// `SET LOCAL lock_timeout = '5s'` — see the file-level comment in `BankTransactionUnmatch.test.ts`
// and the "Concurrency-test hygiene" note in the architecture doc: `fileParallelism: false`, so a
// hung transaction here stalls the next file's `cleanDatabase` TRUNCATE for the full 120s
// `hookTimeout` and cascades everything after it. The two calls under test in 5.9
// (`BankTransactionMatcher.unmatch`) are production code we cannot inject `SET LOCAL
// lock_timeout` into from here — a genuine deadlock is caught by Postgres's own
// `deadlock_timeout` (~1s default) regardless, and `Effect.scoped` ties every forked fiber and
// every `secondTestPgClient` connection to this test's own scope, so vitest's `testTimeout`
// (30s) itself bounds a one-sided hang without a bespoke timeout here.

import { describe, expect, it } from '@effect/vitest';
import type { Fee, Team, TeamMember } from '@sideline/domain';
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import {
  MemberCreditsRepository,
  make as makeMemberCreditsRepository,
} from '~/repositories/MemberCreditsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { BankTransactionMatcher, make as makeMatcher } from '~/services/BankTransactionMatcher.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  insertBankTransaction,
  nextDiscordId,
} from './bankSyncFixtures.js';
import { assertCreditReconciles } from './creditReconciliation.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from './helpers.js';

const RepoLayer = Layer.mergeAll(
  MemberCreditsRepository.Default,
  PaymentsRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
);
const TestLayer = Layer.mergeAll(RepoLayer, BankTransactionMatcher.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CZK = 'CZK' as Fee.CurrencyCode;

const seedMember = () =>
  Effect.gen(function* () {
    const recorder = yield* createUser('mcc-recorder');
    const team = yield* createTeam(nextDiscordId(), recorder.id);
    const memberUser = yield* createUser('mcc-member');
    const member = yield* createTeamMember(team.id, memberUser.id);
    return { team, member, recordedByUserId: recorder.id };
  });

const settleInput = (opts: {
  teamId: Team.TeamId;
  teamMemberId: TeamMember.TeamMemberId;
  recordedByUserId: string;
  currency?: Fee.CurrencyCode;
  amountMinor: number;
  expectedOutstandingMinor: number;
}) => ({
  teamId: opts.teamId,
  teamMemberId: opts.teamMemberId,
  currency: opts.currency ?? CZK,
  amountMinor: opts.amountMinor,
  method: 'cash' as const,
  paidAt: DateTime.nowUnsafe(),
  note: Option.none<string>(),
  expectedOutstandingMinor: opts.expectedOutstandingMinor,
  recordedByUserId: opts.recordedByUserId as never,
});

const balanceOf = (sql: SqlClient.SqlClient, memberId: string, currency: Fee.CurrencyCode = CZK) =>
  sql<{ balance_minor: string }>`
    SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
     WHERE team_member_id = ${memberId} AND currency = ${currency}
  `.pipe(Effect.map((rows) => (rows[0] ? Number(rows[0].balance_minor) : null)));

const paidMinorOf = (sql: SqlClient.SqlClient, assignmentId: string) =>
  sql<{ paid_minor: string }>`
    SELECT paid_minor::text AS paid_minor FROM fee_assignments WHERE id = ${assignmentId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.paid_minor ?? 0)));

const paymentCount = (sql: SqlClient.SqlClient, memberId: string) =>
  sql<{ count: string }>`
    SELECT count(*)::text AS count FROM payments WHERE team_member_id = ${memberId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

const depositCount = (sql: SqlClient.SqlClient, memberId: string) =>
  sql<{ count: string }>`
    SELECT count(*)::text AS count FROM member_credit_deposits WHERE team_member_id = ${memberId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

const noDeadlock = (result: { readonly _tag: string; readonly cause?: unknown }) => {
  if (result._tag === 'Failure') {
    const serialised = JSON.stringify(result).toLowerCase();
    expect(serialised).not.toContain('40p01');
    expect(serialised).not.toContain('deadlock');
  }
};

// ---------------------------------------------------------------------------
// Atomicity
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — atomicity (5.1, 5.2)', () => {
  it.effect('5.1 a failure mid-settlement (afterAssignmentLock) writes nothing at all', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 500,
          expectedOutstandingMinor: 0,
        }),
      );
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 300);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const balanceBefore = yield* balanceOf(sql, member.id);
      const paymentsBefore = yield* paymentCount(sql, member.id);
      const depositsBefore = yield* depositCount(sql, member.id);
      const paidBefore = yield* paidMinorOf(sql, assignment.id);

      const creditsWithSeam = yield* makeMemberCreditsRepository({
        afterAssignmentLock: Effect.die(new Error('forced failure — proves atomicity')),
      });
      const result = yield* Effect.exit(
        creditsWithSeam.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 100,
            expectedOutstandingMinor: 300,
          }),
        ),
      );
      expect(result._tag).toBe('Failure');

      expect(yield* balanceOf(sql, member.id)).toBe(balanceBefore);
      expect(yield* paymentCount(sql, member.id)).toBe(paymentsBefore);
      expect(yield* depositCount(sql, member.id)).toBe(depositsBefore);
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(paidBefore);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('5.2 SettlementStale writes nothing', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 900);

      const result = yield* Effect.result(
        credits.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 900,
            expectedOutstandingMinor: 1000,
          }),
        ),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = (result as { failure: { _tag: string; outstandingMinor?: number } })
          .failure;
        expect(failure._tag).toBe('SettlementStale');
        expect(failure.outstandingMinor).toBe(900);
      }

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paymentCount(sql, member.id)).toBe(0);
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — concurrency (5.4-5.8)', () => {
  it.effect('5.4 a payment landing between the client read and the settle is caught', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const payments = yield* PaymentsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1000);

      // Client read outstanding = 1000. Before it submits, a treasurer records a 400 cash
      // payment out-of-band.
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 400,
        method: 'cash',
        paidAt: DateTime.nowUnsafe(),
        note: Option.none(),
        recordedByUserId: recordedByUserId as never,
      });

      const result = yield* Effect.result(
        credits.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 1000,
            expectedOutstandingMinor: 1000,
          }),
        ),
      );
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = (result as { failure: { _tag: string; outstandingMinor?: number } })
          .failure;
        expect(failure._tag).toBe('SettlementStale');
        expect(failure.outstandingMinor).toBe(600);
      }

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paymentCount(sql, member.id)).toBe(1); // only the out-of-band one
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(400);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '5.5 a payment landing mid-settle is never lost — paid_minor is the full recomputed SUM, overpay tolerated',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const { team, member, recordedByUserId } = yield* seedMember();
            const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1000);

            const reached = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const creditsA = yield* makeMemberCreditsRepository({
              afterAssignmentLock: Deferred.succeed(reached, undefined).pipe(
                Effect.asVoid,
                Effect.andThen(Deferred.await(release)),
              ),
            });

            const sql2 = yield* secondTestPgClient;
            const paymentsB = yield* PaymentsRepository.asEffect().pipe(
              Effect.provide(PaymentsRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );

            const fiberSettle = yield* Effect.forkChild(
              Effect.result(
                creditsA.settle(
                  settleInput({
                    teamId: team.id,
                    teamMemberId: member.id,
                    recordedByUserId,
                    amountMinor: 1000,
                    expectedOutstandingMinor: 1000,
                  }),
                ),
              ),
            );
            yield* Deferred.await(reached);

            // The concurrent payment BLOCKS on the fee_assignments row settle already holds
            // FOR UPDATE (via the payments_finance_recompute trigger's own UPDATE of paid_minor)
            // — a real lock wait, not a scripted sequence.
            const fiberPayment = yield* Effect.forkChild(
              Effect.result(
                paymentsB.insert({
                  feeAssignmentId: assignment.id as never,
                  teamMemberId: member.id,
                  amountMinor: 400,
                  method: 'cash',
                  paidAt: DateTime.nowUnsafe(),
                  note: Option.none(),
                  recordedByUserId: recordedByUserId as never,
                }),
              ),
            );
            yield* Effect.sleep('200 millis');
            yield* Deferred.succeed(release, undefined);

            const settleResult = yield* Fiber.join(fiberSettle);
            const paymentResult = yield* Fiber.join(fiberPayment);
            expect(settleResult._tag).toBe('Success');
            expect(paymentResult._tag).toBe('Success');

            const sql = yield* SqlClient.SqlClient.asEffect();
            const paidMinor = yield* paidMinorOf(sql, assignment.id);
            // No lost update: BOTH the settle's 1000 and the concurrent 400 landed.
            expect(paidMinor).toBe(1400);
            // Overpay (paid_minor > amount_minor) is the accepted outcome here (§6.3 in the
            // architecture's answer to Q4) — asserted explicitly, not incidentally.
            expect(paidMinor).toBeGreaterThan(1000);

            yield* assertCreditReconciles();
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );

  it.effect('5.6 two settlements for the same member serialise on the account — no 40P01', () =>
    Effect.scoped(
      TestClock.withLive(
        Effect.gen(function* () {
          const { team, member, recordedByUserId } = yield* seedMember();

          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const creditsA = yield* makeMemberCreditsRepository({
            afterAccountLock: Deferred.succeed(reached, undefined).pipe(
              Effect.asVoid,
              Effect.andThen(Deferred.await(release)),
            ),
          });
          const sql2 = yield* secondTestPgClient;
          const creditsB = yield* makeMemberCreditsRepository().pipe(
            Effect.provideService(SqlClient.SqlClient, sql2),
          );

          const depositInput = (amountMinor: number) =>
            settleInput({
              teamId: team.id,
              teamMemberId: member.id,
              recordedByUserId,
              amountMinor,
              expectedOutstandingMinor: 0,
            });

          const fiberA = yield* Effect.forkChild(Effect.result(creditsA.settle(depositInput(500))));
          yield* Deferred.await(reached);
          const fiberB = yield* Effect.forkChild(Effect.result(creditsB.settle(depositInput(300))));
          yield* Effect.sleep('200 millis');
          yield* Deferred.succeed(release, undefined);

          const resultA = yield* Fiber.join(fiberA);
          const resultB = yield* Fiber.join(fiberB);
          noDeadlock(resultA as never);
          noDeadlock(resultB as never);
          expect(resultA._tag).toBe('Success');
          expect(resultB._tag).toBe('Success');

          const sql = yield* SqlClient.SqlClient.asEffect();
          // Serialised, not lost: both deposits landed (500 + 300).
          expect(yield* balanceOf(sql, member.id)).toBe(800);

          yield* assertCreditReconciles();
        }),
      ),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect('5.7 settle × bank matcher on the same assignment does not deadlock', () =>
    Effect.scoped(
      TestClock.withLive(
        Effect.gen(function* () {
          const { team, member, recordedByUserId } = yield* seedMember();
          yield* createFeeAndAssignment(team.id, member.id, 1500);

          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const creditsA = yield* makeMemberCreditsRepository({
            afterAssignmentLock: Deferred.succeed(reached, undefined).pipe(
              Effect.asVoid,
              Effect.andThen(Deferred.await(release)),
            ),
          });

          const sql2 = yield* secondTestPgClient;
          const matcherB = yield* makeMatcher().pipe(
            Effect.provideService(SqlClient.SqlClient, sql2),
          );
          // Give the member a variable symbol so the matcher can resolve them by VS.
          yield* sql2`UPDATE team_members SET variable_symbol = '778899' WHERE id = ${member.id}`;
          const txId = yield* insertBankTransaction(team.id, {
            fioMovementId: 501,
            bookedOn: '2024-05-01',
            amountMinor: 1500,
            variableSymbol: '778899',
          });

          const fiberSettle = yield* Effect.forkChild(
            Effect.result(
              creditsA.settle(
                settleInput({
                  teamId: team.id,
                  teamMemberId: member.id,
                  recordedByUserId,
                  amountMinor: 0,
                  expectedOutstandingMinor: 1500,
                }),
              ),
            ),
          );
          yield* Deferred.await(reached);
          const fiberMatch = yield* Effect.forkChild(
            Effect.result(matcherB.matchOne(txId as never)),
          );
          yield* Effect.sleep('200 millis');
          yield* Deferred.succeed(release, undefined);

          const settleResult = yield* Fiber.join(fiberSettle);
          const matchResult = yield* Fiber.join(fiberMatch);
          noDeadlock(settleResult as never);
          noDeadlock(matchResult as never);
          expect(settleResult._tag).toBe('Success');
          expect(matchResult._tag).toBe('Success');

          yield* assertCreditReconciles();
        }),
      ),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect('5.8 settle × voidPayment does not deadlock', () =>
    Effect.scoped(
      TestClock.withLive(
        Effect.gen(function* () {
          const { team, member, recordedByUserId } = yield* seedMember();
          const credits = yield* MemberCreditsRepository.asEffect();

          // A pre-existing credit payment, funded from a prior settlement — this is what
          // voidPayment will target while a NEW settlement races it on a separate assignment.
          yield* credits.settle(
            settleInput({
              teamId: team.id,
              teamMemberId: member.id,
              recordedByUserId,
              amountMinor: 1000,
              expectedOutstandingMinor: 0,
            }),
          );
          const { assignment: firstAssignment } = yield* createFeeAndAssignment(
            team.id,
            member.id,
            400,
          );
          const firstSettle = (yield* credits.settle(
            settleInput({
              teamId: team.id,
              teamMemberId: member.id,
              recordedByUserId,
              amountMinor: 0,
              expectedOutstandingMinor: 400,
            }),
          )) as { allocations: ReadonlyArray<{ source: string; paymentId: string }> };
          const creditAllocation = firstSettle.allocations.find((a) => a.source === 'credit');
          if (creditAllocation === undefined)
            throw new Error('expected a credit-source allocation');
          const creditPaymentId = creditAllocation.paymentId;

          yield* createFeeAndAssignment(team.id, member.id, 200);

          const reached = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const creditsA = yield* makeMemberCreditsRepository({
            afterAccountLock: Deferred.succeed(reached, undefined).pipe(
              Effect.asVoid,
              Effect.andThen(Deferred.await(release)),
            ),
          });
          const sql2 = yield* secondTestPgClient;
          const paymentsB = yield* PaymentsRepository.asEffect().pipe(
            Effect.provide(PaymentsRepository.Default),
            Effect.provideService(SqlClient.SqlClient, sql2),
          );

          const fiberSettle = yield* Effect.forkChild(
            Effect.result(
              creditsA.settle(
                settleInput({
                  teamId: team.id,
                  teamMemberId: member.id,
                  recordedByUserId,
                  amountMinor: 0,
                  expectedOutstandingMinor: 200,
                }),
              ),
            ),
          );
          yield* Deferred.await(reached);
          const fiberVoid = yield* Effect.forkChild(
            Effect.result(
              paymentsB.void_(creditPaymentId as never, {
                voidedByUserId: recordedByUserId as never,
                voidReason: 'concurrent void racing a settle',
                voidedAt: DateTime.nowUnsafe(),
              }),
            ),
          );
          yield* Effect.sleep('200 millis');
          yield* Deferred.succeed(release, undefined);

          const settleResult = yield* Fiber.join(fiberSettle);
          const voidResult = yield* Fiber.join(fiberVoid);
          noDeadlock(settleResult as never);
          noDeadlock(voidResult as never);
          expect(settleResult._tag).toBe('Success');
          expect(voidResult._tag).toBe('Success');
          void firstAssignment;

          yield* assertCreditReconciles();
        }),
      ),
    ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 5.9 — the unmatch deadlock regression (§3.2)
// ---------------------------------------------------------------------------

describe('BankTransactionMatcher.unmatch — two multi-member transactions do not deadlock (5.9)', () => {
  it.effect(
    'tx T1 -> (member A, fa1) + (member B, fa2); tx T2 -> (member B, fa3) + (member A, fa4), ' +
      'with EXPLICIT assignment ids so fee_assignment_id ASC order (and hence per-payment ' +
      'account-lock order) is fully controlled, not left to a random gen_random_uuid(). A THIRD ' +
      'connection deterministically forces the exact state the §3.2 hoist prevents: it holds ' +
      "acct(B) while T1's unmatch runs, then tries to lock fa1 — the row T1's per-payment loop " +
      'would already hold (blocking on acct(B) itself) if the hoist did not exist. ' +
      'FAILS (40P01) without the §3.2 hoist — see the coordinator note above this test for the ' +
      'manual before/after verification.',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const recorder = yield* createUser('mcc-59-recorder');
            const team = yield* createTeam(nextDiscordId(), recorder.id);
            const userA = yield* createUser('mcc-59-member-a');
            const memberA = yield* createTeamMember(team.id, userA.id);
            const userB = yield* createUser('mcc-59-member-b');
            const memberB = yield* createTeamMember(team.id, userB.id);

            const credits = yield* MemberCreditsRepository.asEffect();
            // "Both members have credit accounts."
            yield* credits.settle(
              settleInput({
                teamId: team.id,
                teamMemberId: memberA.id,
                recordedByUserId: recorder.id,
                amountMinor: 100,
                expectedOutstandingMinor: 0,
              }),
            );
            yield* credits.settle(
              settleInput({
                teamId: team.id,
                teamMemberId: memberB.id,
                recordedByUserId: recorder.id,
                amountMinor: 100,
                expectedOutstandingMinor: 0,
              }),
            );

            const fees = yield* FeesRepository.asEffect();
            const sql = yield* SqlClient.SqlClient.asEffect();

            // EXPLICIT ids, not gen_random_uuid() — fee_assignments.id is a random UUID by
            // default, so `ORDER BY fee_assignment_id ASC` (what void_'s per-payment loop uses)
            // cannot be steered by insert order or by sorting the generated ids afterwards: a
            // previous revision of this test did exactly that and was VACUOUS — it passed with
            // the §3.2 hoist removed, because the "opposite order" precondition it relied on
            // only held by chance (~25% of runs). Pinning the ids pins the order: T1 processes
            // A(fa1) then B(fa2); T2 processes B(fa3) then A(fa4) — always.
            const FA1 = '00000000-0000-0000-0000-000000000001'; // T1 first — member A
            const FA2 = '00000000-0000-0000-0000-000000000002'; // T1 second — member B
            const FA3 = '00000000-0000-0000-0000-000000000003'; // T2 first — member B
            const FA4 = '00000000-0000-0000-0000-000000000004'; // T2 second — member A

            const makeAssignment = (id: string, memberId: string) =>
              Effect.gen(function* () {
                const fee = yield* fees.insert({
                  team_id: team.id,
                  name: 'unmatch race fee',
                  description: Option.none(),
                  amount_minor: 1000 as never,
                  currency: 'CZK' as never,
                  due_at: Option.none(),
                });
                yield* sql`
                  INSERT INTO fee_assignments (id, fee_id, team_member_id, amount_minor)
                  VALUES (${id}::uuid, ${fee.id}, ${memberId}, 1000)
                `;
              });
            yield* makeAssignment(FA1, memberA.id);
            yield* makeAssignment(FA2, memberB.id);
            yield* makeAssignment(FA3, memberB.id);
            yield* makeAssignment(FA4, memberA.id);

            const tx1 = yield* insertBankTransaction(team.id, {
              fioMovementId: 601,
              bookedOn: '2024-06-01',
              amountMinor: 2000,
            });
            const tx2 = yield* insertBankTransaction(team.id, {
              fioMovementId: 602,
              bookedOn: '2024-06-01',
              amountMinor: 2000,
            });
            if (tx1 === undefined || tx2 === undefined) {
              throw new Error('expected both bank transactions to be inserted');
            }

            const insertLinkedPayment = (assignmentId: string, memberId: string, txId: string) =>
              sql`
                INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id, bank_transaction_id, matched_by)
                VALUES (${assignmentId}::uuid, ${memberId}, 1000, 'bank_transfer', now(), ${recorder.id}, ${txId}, 'auto')
              `;
            yield* insertLinkedPayment(FA1, memberA.id, tx1);
            yield* insertLinkedPayment(FA2, memberB.id, tx1);
            yield* insertLinkedPayment(FA3, memberB.id, tx2);
            yield* insertLinkedPayment(FA4, memberA.id, tx2);

            const matcher = yield* BankTransactionMatcher.asEffect();

            // Connection 3 — the deterministic prober. Holds acct(B) for the whole first half of
            // the race, then (once T1's unmatch is guaranteed to be blocked on the SAME row)
            // tries to lock fa1 — the row T1's per-payment loop would already hold if the hoist
            // did not exist.
            const holdingB = yield* Deferred.make<void>();
            const goLockFa1 = yield* Deferred.make<void>();
            const sql3 = yield* secondTestPgClient;
            const fiber3 = yield* Effect.forkChild(
              Effect.result(
                sql3.withTransaction(
                  Effect.Do.pipe(
                    Effect.tap(() => sql3`SET LOCAL lock_timeout = '5s'`),
                    Effect.tap(
                      () => sql3`
                        SELECT 1 FROM member_credit_accounts
                         WHERE team_member_id = ${memberB.id} AND currency = 'CZK'
                         FOR UPDATE
                      `,
                    ),
                    Effect.tap(() => Deferred.succeed(holdingB, undefined)),
                    Effect.tap(() => Deferred.await(goLockFa1)),
                    Effect.tap(
                      () => sql3`SELECT 1 FROM fee_assignments WHERE id = ${FA1}::uuid FOR UPDATE`,
                    ),
                    Effect.asVoid,
                  ),
                ),
              ),
            );
            yield* Deferred.await(holdingB);

            // T1's unmatch now genuinely blocks trying to acquire acct(B) — either inside the
            // single hoisted statement (fixed: holds only acct(A), no fee_assignments lock yet),
            // or inside void_'s own pre-lock for payment 2 AFTER already voiding payment 1 on fa1
            // (broken: holds acct(A) AND fa1).
            const fiber1 = yield* Effect.forkChild(
              Effect.result(
                matcher.unmatch(tx1 as never, {
                  reason: 'unmatch race T1 (5.9)',
                  unmatchedByUserId: recorder.id as never,
                }),
              ),
            );
            yield* Effect.sleep('300 millis'); // let T1 actually reach and start blocking on acct(B)

            // Release connection 3 to attempt fa1. Fixed: T1 holds no fa lock -> immediate
            // success, conn 3 commits, T1's hoist then unblocks and finishes cleanly. Broken: T1
            // holds fa1 while conn 3 holds acct(B) that T1 is waiting on -> a genuine two-way
            // cycle -> Postgres's own deadlock detector aborts one side with 40P01.
            yield* Deferred.succeed(goLockFa1, undefined);

            const result3 = yield* Fiber.join(fiber3);
            const result1 = yield* Fiber.join(fiber1);
            noDeadlock(result3 as never);
            noDeadlock(result1 as never);
            expect(result3._tag).toBe('Success');
            expect(result1._tag).toBe('Success');

            // The rest of the original business, run sequentially (not raced — the race above is
            // the deterministic discriminator; racing a second real unmatch call on top of it
            // would reintroduce the non-determinism this rewrite removes).
            const result2 = yield* Effect.result(
              matcher.unmatch(tx2 as never, {
                reason: 'unmatch T2 (5.9)',
                unmatchedByUserId: recorder.id as never,
              }),
            );
            noDeadlock(result2 as never);
            expect(result2._tag).toBe('Success');

            const voidedRows = yield* sql<{ voided_at: Date | null }>`
              SELECT voided_at FROM payments WHERE bank_transaction_id IN (${tx1}, ${tx2})
            `;
            expect(voidedRows).toHaveLength(4);
            for (const row of voidedRows) expect(row.voided_at).not.toBeNull();

            expect(yield* balanceOf(sql, memberA.id)).toBe(100);
            expect(yield* balanceOf(sql, memberB.id)).toBe(100);

            yield* assertCreditReconciles();
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});
