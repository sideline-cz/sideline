// TDD mode — tests written BEFORE `MemberCreditsRepository` exists.
// These tests WILL FAIL to even COMPILE until:
//   - packages/migrations/src/before/1792700000_create_member_credits.ts has been built (already
//     exists — `pnpm build` inside packages/migrations before the first run of this file)
//   - applications/server/src/repositories/MemberCreditsRepository.ts is implemented, exporting
//     BOTH the `MemberCreditsRepository` service class (with a `.Default` layer) AND a top-level
//     `make(options?: MemberCreditsRepositoryOptions)` function — mirroring
//     `~/services/BankTransactionMatcher.ts`'s `export const make = (options) => ...` /
//     `static readonly Default = Layer.effect(BankTransactionMatcher, make())` split, which is
//     what lets a test bind a second, option-carrying instance to a second connection
//     (`secondTestPgClient`) for a genuine two-connection race (see 4.1, 4.10).
//
// Architecture: `.work-plans/finances/settle-all-and-credit-architecture.md` §5, §5.3, §5.3b.
// Every test ends with `assertCreditReconciles()` (§2.4) — the one assertion that catches drift
// between the stored balance and the history that is supposed to explain it.

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
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  nextDiscordId,
} from '../bankSyncFixtures.js';
import { assertCreditReconciles } from '../creditReconciliation.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  MemberCreditsRepository.Default,
  PaymentsRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CZK = 'CZK' as Fee.CurrencyCode;
const EUR = 'EUR' as Fee.CurrencyCode;

/** Team + a single settleable member, ready for `credits.settle(...)`. */
const seedMember = () =>
  Effect.gen(function* () {
    const recorder = yield* createUser('credit-recorder');
    const team = yield* createTeam(nextDiscordId(), recorder.id);
    const memberUser = yield* createUser('credit-member');
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
  expectedCreditMinor: number;
}) => ({
  teamId: opts.teamId,
  teamMemberId: opts.teamMemberId,
  currency: opts.currency ?? CZK,
  amountMinor: opts.amountMinor,
  method: 'cash' as const,
  paidAt: DateTime.nowUnsafe(),
  note: Option.none<string>(),
  expectedOutstandingMinor: opts.expectedOutstandingMinor,
  expectedCreditMinor: opts.expectedCreditMinor,
  recordedByUserId: opts.recordedByUserId as never,
});

/** Pure "pay in advance" — no assignments needed, the whole amount becomes credit. Every call
 * site deposits into a currency that holds zero credit beforehand (a fresh member, or a
 * currency not yet touched), so `expectedCreditMinor: 0` is always the true pre-call balance. */
const depositCredit = (
  // `any` deliberately: accepts the real repository's `settle` (a specific struct param), a
  // loosened mock, or the options-carrying `make(...)` instance without fighting parameter
  // contravariance.
  credits: { settle: (input: any) => Effect.Effect<any, any> },
  opts: {
    teamId: Team.TeamId;
    teamMemberId: TeamMember.TeamMemberId;
    recordedByUserId: string;
    currency?: Fee.CurrencyCode;
    amountMinor: number;
  },
) =>
  credits.settle(
    settleInput({
      ...opts,
      amountMinor: opts.amountMinor,
      expectedOutstandingMinor: 0,
      expectedCreditMinor: 0,
    }),
  );

const balanceOf = (sql: SqlClient.SqlClient, memberId: string, currency: Fee.CurrencyCode = CZK) =>
  sql<{ balance_minor: string }>`
    SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
     WHERE team_member_id = ${memberId} AND currency = ${currency}
  `.pipe(Effect.map((rows) => (rows[0] ? Number(rows[0].balance_minor) : null)));

const accountRowCount = (sql: SqlClient.SqlClient, memberId: string) =>
  sql<{ count: string }>`
    SELECT count(*)::text AS count FROM member_credit_accounts WHERE team_member_id = ${memberId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

const depositCount = (
  sql: SqlClient.SqlClient,
  memberId: string,
  currency: Fee.CurrencyCode = CZK,
) =>
  sql<{ count: string }>`
    SELECT count(*)::text AS count FROM member_credit_deposits
     WHERE team_member_id = ${memberId} AND currency = ${currency} AND voided_at IS NULL
  `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

const latestDepositId = (
  sql: SqlClient.SqlClient,
  memberId: string,
  currency: Fee.CurrencyCode = CZK,
) =>
  sql<{ id: string }>`
    SELECT id::text AS id FROM member_credit_deposits
     WHERE team_member_id = ${memberId} AND currency = ${currency}
     ORDER BY created_at DESC LIMIT 1
  `.pipe(Effect.map((rows) => rows[0]?.id));

const paidMinorOf = (sql: SqlClient.SqlClient, assignmentId: string) =>
  sql<{ paid_minor: string }>`
    SELECT paid_minor::text AS paid_minor FROM fee_assignments WHERE id = ${assignmentId}
  `.pipe(Effect.map((rows) => Number(rows[0]?.paid_minor ?? 0)));

const paymentCount = (sql: SqlClient.SqlClient, memberId: string, method?: string) =>
  method === undefined
    ? sql<{ count: string }>`
        SELECT count(*)::text AS count FROM payments WHERE team_member_id = ${memberId}
      `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)))
    : sql<{ count: string }>`
        SELECT count(*)::text AS count FROM payments
         WHERE team_member_id = ${memberId} AND method = ${method}
      `.pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)));

// Deliberately loosely-typed: the exact shape of `Effect.result`'s failure carries whatever
// tagged error the not-yet-written repository defines. See FinanceApi.ts / CarpoolsRepository
// test precedent (`result.failure._tag`).
const expectFailureTag = (
  result: { readonly _tag: string; readonly failure?: { readonly _tag: string } },
  tag: string,
) => {
  expect(result._tag).toBe('Failure');
  if (result._tag === 'Failure')
    expect((result as { failure: { _tag: string } }).failure._tag).toBe(tag);
};

// ---------------------------------------------------------------------------
// Negative-balance prevention
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — negative-balance prevention', () => {
  it.effect('4.1 two concurrent credit applications cannot overdraw', () =>
    Effect.scoped(
      TestClock.withLive(
        Effect.gen(function* () {
          const { team, member, recordedByUserId } = yield* seedMember();
          const credits = yield* MemberCreditsRepository.asEffect();
          yield* depositCredit(credits, {
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 1000,
          });
          const { assignment: a1 } = yield* createFeeAndAssignment(team.id, member.id, 1000);
          const { assignment: a2 } = yield* createFeeAndAssignment(team.id, member.id, 1000);

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

          const input = settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 0,
            expectedOutstandingMinor: 2000,
            expectedCreditMinor: 1000,
          });

          const fiberA = yield* Effect.forkChild(Effect.result(creditsA.settle(input)));
          yield* Deferred.await(reached);
          const fiberB = yield* Effect.forkChild(Effect.result(creditsB.settle(input)));
          yield* Effect.sleep('200 millis');
          yield* Deferred.succeed(release, undefined);
          const resultA = yield* Fiber.join(fiberA);
          const resultB = yield* Fiber.join(fiberB);

          const results = [resultA, resultB] as Array<{ _tag: string; failure?: { _tag: string } }>;
          const successes = results.filter((r) => r._tag === 'Success');
          const failures = results.filter((r) => r._tag === 'Failure');
          expect(successes).toHaveLength(1);
          expect(failures).toHaveLength(1);
          expect(['SettlementStale', 'InsufficientCredit']).toContain(failures[0]?.failure?._tag);

          const sql = yield* SqlClient.SqlClient.asEffect();
          const balance = yield* balanceOf(sql, member.id);
          expect(balance).toBe(0);
          expect(yield* paymentCount(sql, member.id, 'credit')).toBe(1);
          void a1;
          void a2;

          yield* assertCreditReconciles();
        }),
      ),
    ).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.2 a settlement asking for more credit than the balance applies only the balance',
    () =>
      Effect.gen(function* () {
        const { team, member, recordedByUserId } = yield* seedMember();
        const credits = yield* MemberCreditsRepository.asEffect();
        yield* depositCredit(credits, {
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 300,
        });
        yield* createFeeAndAssignment(team.id, member.id, 1000);

        const result = (yield* credits.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 0,
            expectedOutstandingMinor: 1000,
            expectedCreditMinor: 300,
          }),
        )) as { creditAppliedMinor: number };
        expect(result.creditAppliedMinor).toBe(300);

        const sql = yield* SqlClient.SqlClient.asEffect();
        // The debit UPDATE is a single conditional statement (`WHERE balance_minor >= n`) — the
        // only externally observable proof it "reported exactly one affected row" is that the
        // balance landed EXACTLY on 0, not partially drained by some other path (folds in old 4.4).
        expect(yield* balanceOf(sql, member.id)).toBe(0);

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.3 the CHECK constraint refuses a negative balance', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 100,
      });
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        sql`UPDATE member_credit_accounts SET balance_minor = -1 WHERE team_member_id = ${member.id}`,
      );
      expect(result._tag).toBe('Failure');
      const serialised = JSON.stringify(result).toLowerCase();
      expect(serialised).toContain('23514');

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Deposit void after spend
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — deposit void after spend', () => {
  it.effect('4.5 voiding a deposit whose credit is unspent succeeds', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      const sql = yield* SqlClient.SqlClient.asEffect();
      const depositId = yield* latestDepositId(sql, member.id);

      yield* credits.voidDeposit({
        teamId: team.id,
        memberId: member.id,
        depositId: depositId as never,
        voidedByUserId: recordedByUserId as never,
        reason: 'entered by mistake',
      });

      expect(yield* balanceOf(sql, member.id)).toBe(0);
      const voided = yield* sql<{ voided_at: Date | null }>`
        SELECT voided_at FROM member_credit_deposits WHERE id = ${depositId}
      `;
      expect(voided[0]?.voided_at).not.toBeNull();

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.6 voiding a deposit whose credit was already spent → CreditDepositSpent', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      yield* createFeeAndAssignment(team.id, member.id, 600);
      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 600,
          expectedCreditMinor: 1000,
        }),
      );
      const sql = yield* SqlClient.SqlClient.asEffect();
      const depositId = yield* latestDepositId(sql, member.id);
      expect(yield* balanceOf(sql, member.id)).toBe(400);

      const result = yield* Effect.result(
        credits.voidDeposit({
          teamId: team.id,
          memberId: member.id,
          depositId: depositId as never,
          voidedByUserId: recordedByUserId as never,
          reason: 'try to undo',
        }),
      );
      expectFailureTag(result as never, 'CreditDepositSpent');
      expect(yield* balanceOf(sql, member.id)).toBe(400);
      const voided = yield* sql<{ voided_at: Date | null }>`
        SELECT voided_at FROM member_credit_deposits WHERE id = ${depositId}
      `;
      expect(voided[0]?.voided_at).toBeNull();

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.7 after voiding the credit-funded payments, the deposit void succeeds', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const payments = yield* PaymentsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      yield* createFeeAndAssignment(team.id, member.id, 600);
      const settleResult = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 600,
          expectedCreditMinor: 1000,
        }),
      )) as { allocations: ReadonlyArray<{ source: string; paymentId: string }> };
      const creditPayment = settleResult.allocations.find((a) => a.source === 'credit');
      if (creditPayment === undefined) throw new Error('expected a credit-source allocation');

      yield* payments.void_(creditPayment.paymentId as never, {
        voidedByUserId: recordedByUserId as never,
        voidReason: 'reverse the credit spend first',
        voidedAt: DateTime.nowUnsafe(),
      });

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id)).toBe(1000);
      const depositId = yield* latestDepositId(sql, member.id);

      yield* credits.voidDeposit({
        teamId: team.id,
        memberId: member.id,
        depositId: depositId as never,
        voidedByUserId: recordedByUserId as never,
        reason: 'now safe to undo',
      });
      expect(yield* balanceOf(sql, member.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.8 voiding an already-voided deposit → CreditDepositNotFound', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 500,
      });
      const sql = yield* SqlClient.SqlClient.asEffect();
      const depositId = yield* latestDepositId(sql, member.id);
      yield* credits.voidDeposit({
        teamId: team.id,
        memberId: member.id,
        depositId: depositId as never,
        voidedByUserId: recordedByUserId as never,
        reason: 'first void',
      });
      const before = yield* balanceOf(sql, member.id);

      const result = yield* Effect.result(
        credits.voidDeposit({
          teamId: team.id,
          memberId: member.id,
          depositId: depositId as never,
          voidedByUserId: recordedByUserId as never,
          reason: 'second void',
        }),
      );
      expectFailureTag(result as never, 'CreditDepositNotFound');
      expect(yield* balanceOf(sql, member.id)).toBe(before);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.9 voiding a deposit of another team → CreditDepositNotFound', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 500,
      });
      const otherOwner = yield* createUser('other-team-owner');
      const otherTeam = yield* createTeam(nextDiscordId(), otherOwner.id);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const depositId = yield* latestDepositId(sql, member.id);

      const result = yield* Effect.result(
        credits.voidDeposit({
          teamId: otherTeam.id,
          memberId: member.id,
          depositId: depositId as never,
          voidedByUserId: recordedByUserId as never,
          reason: 'cross-tenant attempt',
        }),
      );
      expectFailureTag(result as never, 'CreditDepositNotFound');
      expect(yield* balanceOf(sql, member.id)).toBe(500);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.10 two concurrent voids of the same deposit — one succeeds, one CreditDepositNotFound, balance reduced exactly once',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const { team, member, recordedByUserId } = yield* seedMember();
            const credits = yield* MemberCreditsRepository.asEffect();
            yield* depositCredit(credits, {
              teamId: team.id,
              teamMemberId: member.id,
              recordedByUserId,
              amountMinor: 700,
            });
            const sql = yield* SqlClient.SqlClient.asEffect();
            const depositId = yield* latestDepositId(sql, member.id);

            // A third connection locks the account row `member_credit_accounts` — voidDeposit's
            // own FIRST statement (§5.3 step 1) — and holds it via a Deferred barrier, forcing
            // both racing voidDeposit calls to genuinely overlap (same technique as
            // `defaultRole.test.ts` test 7 / `BankTransactionUnmatch.test.ts` 140b).
            const sql3 = yield* secondTestPgClient;
            const holding = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const barrierFiber = yield* Effect.forkChild(
              sql3.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(() => sql3`SET LOCAL lock_timeout = '5s'`),
                  Effect.tap(
                    () => sql3`
                      SELECT 1 FROM member_credit_accounts
                       WHERE team_member_id = ${member.id} AND currency = ${CZK}
                       FOR UPDATE
                    `,
                  ),
                  Effect.tap(() => Deferred.succeed(holding, undefined)),
                  Effect.tap(() => Deferred.await(release)),
                  Effect.asVoid,
                ),
              ),
            );
            yield* Deferred.await(holding);

            const sql2 = yield* secondTestPgClient;
            const creditsB = yield* makeMemberCreditsRepository().pipe(
              Effect.provideService(SqlClient.SqlClient, sql2),
            );

            const voidInput = {
              teamId: team.id,
              memberId: member.id,
              depositId: depositId as never,
              voidedByUserId: recordedByUserId as never,
              reason: 'racing void',
            };
            const fiberA = yield* Effect.forkChild(Effect.result(credits.voidDeposit(voidInput)));
            const fiberB = yield* Effect.forkChild(Effect.result(creditsB.voidDeposit(voidInput)));
            yield* Effect.sleep('200 millis');
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(barrierFiber);
            const resultA = yield* Fiber.join(fiberA);
            const resultB = yield* Fiber.join(fiberB);

            const results = [resultA, resultB] as Array<{
              _tag: string;
              failure?: { _tag: string };
            }>;
            expect(results.filter((r) => r._tag === 'Success')).toHaveLength(1);
            const failed = results.filter((r) => r._tag === 'Failure');
            expect(failed).toHaveLength(1);
            expect(failed[0]?.failure?._tag).toBe('CreditDepositNotFound');
            expect(yield* balanceOf(sql, member.id)).toBe(0);

            yield* assertCreditReconciles();
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Void behaviour of credit payments
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — void behaviour of credit payments', () => {
  it.effect('4.11 voiding a method=credit payment returns the amount to the balance', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const payments = yield* PaymentsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 400);
      const settleResult = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 400,
          expectedCreditMinor: 1000,
        }),
      )) as { allocations: ReadonlyArray<{ source: string; paymentId: string }> };
      const creditPayment = settleResult.allocations.find((a) => a.source === 'credit');
      if (creditPayment === undefined) throw new Error('expected a credit-source allocation');

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id)).toBe(600);
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(400);

      yield* payments.void_(creditPayment.paymentId as never, {
        voidedByUserId: recordedByUserId as never,
        voidReason: 'refund the credit spend',
        voidedAt: DateTime.nowUnsafe(),
      });

      expect(yield* balanceOf(sql, member.id)).toBe(1000);
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.12 voiding a method=cash payment does NOT touch the balance', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const payments = yield* PaymentsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 500);
      const payment = yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 500,
        method: 'cash',
        paidAt: DateTime.nowUnsafe(),
        note: Option.none(),
        recordedByUserId: recordedByUserId as never,
      });

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* accountRowCount(sql, member.id)).toBe(0);

      yield* payments.void_((payment as { id: string }).id as never, {
        voidedByUserId: recordedByUserId as never,
        voidReason: 'wrong assignment',
        voidedAt: DateTime.nowUnsafe(),
      });

      // void_'s new account-lock pre-check matches zero rows and never creates one.
      expect(yield* accountRowCount(sql, member.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.13 voiding the same credit payment twice restores exactly once', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const payments = yield* PaymentsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      yield* createFeeAndAssignment(team.id, member.id, 400);
      const settleResult = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 400,
          expectedCreditMinor: 1000,
        }),
      )) as { allocations: ReadonlyArray<{ source: string; paymentId: string }> };
      const creditPayment = settleResult.allocations.find((a) => a.source === 'credit');
      if (creditPayment === undefined) throw new Error('expected a credit-source allocation');

      const voidInput = {
        voidedByUserId: recordedByUserId as never,
        voidReason: 'first void',
        voidedAt: DateTime.nowUnsafe(),
      };
      const first = yield* payments.void_(creditPayment.paymentId as never, voidInput);
      expect(Option.isSome(first)).toBe(true);
      const second = yield* payments.void_(creditPayment.paymentId as never, voidInput);
      expect(Option.isNone(second)).toBe(true);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id)).toBe(1000);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.15 unmatch/void_ change: voiding a bank_transfer payment for a member with NO credit account still succeeds',
    () =>
      Effect.gen(function* () {
        const { team, member, recordedByUserId } = yield* seedMember();
        const payments = yield* PaymentsRepository.asEffect();
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);
        const payment = yield* payments.insert({
          feeAssignmentId: assignment.id as never,
          teamMemberId: member.id,
          amountMinor: 1500,
          method: 'bank_transfer',
          paidAt: DateTime.nowUnsafe(),
          note: Option.none(),
          recordedByUserId: recordedByUserId as never,
        });

        const voided = yield* payments.void_((payment as { id: string }).id as never, {
          voidedByUserId: recordedByUserId as never,
          voidReason: 'unmatch regression check',
          voidedAt: DateTime.nowUnsafe(),
        });
        expect(Option.isSome(voided)).toBe(true);

        const sql = yield* SqlClient.SqlClient.asEffect();
        expect(yield* accountRowCount(sql, member.id)).toBe(0);
        expect(yield* paidMinorOf(sql, assignment.id)).toBe(0);

        // The full BankTransactionMatcher.unmatch regression (155, 154, 140b …) is re-run
        // unchanged by T9 (`BankTransactionUnmatch.test.ts`); nothing here duplicates it because
        // a bank-matched payment is never `method='credit'` (credit is settle-only, §12.1), so
        // the interesting new behaviour of the `void_` change is exactly this pre-check matching
        // zero rows for the common case (a member who never had credit).
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Multi-currency
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — multi-currency', () => {
  it.effect('4.16 credit in CZK never pays a EUR fee', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      yield* createFeeAndAssignment(team.id, member.id, 500, { currency: 'EUR' });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          currency: EUR,
          amountMinor: 0,
          expectedOutstandingMinor: 500,
          expectedCreditMinor: 0,
        }),
      )) as { creditAppliedMinor: number };
      expect(result.creditAppliedMinor).toBe(0);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id, CZK)).toBe(1000);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.17 a member has independent balances per currency', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 1000,
      });
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        currency: EUR,
        amountMinor: 50,
      });

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id, CZK)).toBe(1000);
      expect(yield* balanceOf(sql, member.id, EUR)).toBe(50);
      expect(yield* accountRowCount(sql, member.id)).toBe(2);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.18 settling CZK ignores EUR assignments entirely', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* createFeeAndAssignment(team.id, member.id, 1000, { currency: 'CZK' });
      const { assignment: eurAssignment } = yield* createFeeAndAssignment(team.id, member.id, 500, {
        currency: 'EUR',
      });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 1000,
          expectedOutstandingMinor: 1000,
          expectedCreditMinor: 0,
        }),
      )) as { outstandingMinor?: number; paidMinor: number };
      expect(result.paidMinor).toBe(1000);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paidMinorOf(sql, eurAssignment.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.19 the same fee name in two currencies does not collide', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const { assignment: czkAssignment } = yield* createFeeAndAssignment(team.id, member.id, 300, {
        currency: 'CZK',
        name: 'Membership',
      });
      const { assignment: eurAssignment } = yield* createFeeAndAssignment(team.id, member.id, 30, {
        currency: 'EUR',
        name: 'Membership',
      });

      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 300,
          expectedOutstandingMinor: 300,
          expectedCreditMinor: 0,
        }),
      );
      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          currency: EUR,
          amountMinor: 30,
          expectedOutstandingMinor: 30,
          expectedCreditMinor: 0,
        }),
      );

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paidMinorOf(sql, czkAssignment.id)).toBe(300);
      expect(yield* paidMinorOf(sql, eurAssignment.id)).toBe(30);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Waived / archived
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — waived / archived exclusion', () => {
  it.effect('4.20 a waived assignment is excluded from the settlement', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const assignments = yield* FeeAssignmentsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1000);
      yield* assignments.update(assignment.id as never, {
        waived: Option.some(true),
        waivedReason: Option.some(Option.some('scholarship')),
        amountMinor: Option.none(),
        dueAt: Option.none(),
      });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 0,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<unknown> };
      expect(result.allocations).toHaveLength(0);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(0);
      expect(yield* paymentCount(sql, member.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.21 an assignment of an archived fee is excluded', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const fees = yield* FeesRepository.asEffect();
      const { fee, assignment } = yield* createFeeAndAssignment(team.id, member.id, 1000);
      yield* fees.archive(fee.id);

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 0,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<unknown> };
      expect(result.allocations).toHaveLength(0);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* paidMinorOf(sql, assignment.id)).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.22 un-waiving makes it settleable again', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const assignments = yield* FeeAssignmentsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1000);
      yield* assignments.update(assignment.id as never, {
        waived: Option.some(true),
        waivedReason: Option.some(Option.some('temporary')),
        amountMinor: Option.none(),
        dueAt: Option.none(),
      });
      yield* assignments.update(assignment.id as never, {
        waived: Option.some(false),
        waivedReason: Option.none(),
        amountMinor: Option.none(),
        dueAt: Option.none(),
      });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 1000,
          expectedOutstandingMinor: 1000,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<unknown> };
      expect(result.allocations).toHaveLength(1);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.23 a fully paid assignment is excluded (settle-all never overpays)', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const payments = yield* PaymentsRepository.asEffect();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 500);
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 500,
        method: 'cash',
        paidAt: DateTime.nowUnsafe(),
        note: Option.none(),
        recordedByUserId: recordedByUserId as never,
      });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 0,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<unknown> };
      expect(result.allocations).toHaveLength(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Arithmetic / general
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — arithmetic / general', () => {
  it.effect(
    '4.24 settle with outstanding 0 and amount 2000 creates credit only (pay in advance)',
    () =>
      Effect.gen(function* () {
        const { team, member, recordedByUserId } = yield* seedMember();
        const credits = yield* MemberCreditsRepository.asEffect();

        const result = (yield* depositCredit(credits, {
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 2000,
        })) as { allocations: ReadonlyArray<unknown>; creditAddedMinor: number };
        expect(result.allocations).toHaveLength(0);
        expect(result.creditAddedMinor).toBe(2000);

        const sql = yield* SqlClient.SqlClient.asEffect();
        expect(yield* balanceOf(sql, member.id)).toBe(2000);
        expect(yield* depositCount(sql, member.id)).toBe(1);
        expect(yield* paymentCount(sql, member.id)).toBe(0);

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.25 amount exactly equal to outstanding pays everything, adds no credit', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* createFeeAndAssignment(team.id, member.id, 1000);

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 1000,
          expectedOutstandingMinor: 1000,
          expectedCreditMinor: 0,
        }),
      )) as { creditAddedMinor: number; paidMinor: number };
      expect(result.paidMinor).toBe(1000);
      expect(result.creditAddedMinor).toBe(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.26 amount above outstanding pays everything and credits the rest', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* createFeeAndAssignment(team.id, member.id, 1000);

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 1500,
          expectedOutstandingMinor: 1000,
          expectedCreditMinor: 0,
        }),
      )) as { creditAddedMinor: number; paidMinor: number };
      expect(result.paidMinor).toBe(1000);
      expect(result.creditAddedMinor).toBe(500);

      const sql = yield* SqlClient.SqlClient.asEffect();
      expect(yield* balanceOf(sql, member.id)).toBe(500);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.27 allocation order is due-date ascending, None last, id tie-break', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      const now = DateTime.nowUnsafe();
      const { assignment: noDate } = yield* createFeeAndAssignment(team.id, member.id, 100, {
        name: 'no-date',
      });
      const { assignment: later } = yield* createFeeAndAssignment(team.id, member.id, 100, {
        name: 'later',
        dueAt: DateTime.add(now, { days: 10 }),
      });
      const { assignment: earlier } = yield* createFeeAndAssignment(team.id, member.id, 100, {
        name: 'earlier',
        dueAt: DateTime.add(now, { days: 1 }),
      });

      const result = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 300,
          expectedOutstandingMinor: 300,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<{ assignmentId: string }> };

      expect(result.allocations.map((a) => a.assignmentId)).toEqual([
        earlier.id,
        later.id,
        noDate.id,
      ]);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.28 every created payment carries recorded_by_user_id = the caller', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* createFeeAndAssignment(team.id, member.id, 500);

      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 500,
          expectedOutstandingMinor: 500,
          expectedCreditMinor: 0,
        }),
      );

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ recorded_by_user_id: string }>`
        SELECT recorded_by_user_id::text AS recorded_by_user_id FROM payments
         WHERE team_member_id = ${member.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.recorded_by_user_id).toBe(recordedByUserId);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.29 settle never writes fee_assignments.paid_minor directly (stays trigger-derived)',
    () =>
      Effect.gen(function* () {
        const { team, member, recordedByUserId } = yield* seedMember();
        const credits = yield* MemberCreditsRepository.asEffect();
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 700);

        yield* credits.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 700,
            expectedOutstandingMinor: 700,
            expectedCreditMinor: 0,
          }),
        );

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{ paid_minor: string; sum_payments: string | null }>`
        SELECT fa.paid_minor::text AS paid_minor,
               (SELECT COALESCE(SUM(p.amount_minor), 0)::text FROM payments p
                 WHERE p.fee_assignment_id = fa.id AND p.voided_at IS NULL) AS sum_payments
          FROM fee_assignments fa WHERE fa.id = ${assignment.id}
      `;
        expect(rows[0]?.paid_minor).toBe(rows[0]?.sum_payments);

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.30 settling twice in a row settles nothing the second time', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* createFeeAndAssignment(team.id, member.id, 400);

      yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 400,
          expectedOutstandingMinor: 400,
          expectedCreditMinor: 0,
        }),
      );

      const second = (yield* credits.settle(
        settleInput({
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 0,
          expectedOutstandingMinor: 0,
          expectedCreditMinor: 0,
        }),
      )) as { allocations: ReadonlyArray<unknown> };
      expect(second.allocations).toHaveLength(0);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Re-homed from T6 — cross-tenant + reads that need real rows
// ---------------------------------------------------------------------------

describe('MemberCreditsRepository — cross-tenant authz and reads (re-homed from T6)', () => {
  it.effect(
    '4.37 createSettlement for a member of another team (no existing account) → FinanceMemberNotFound',
    () =>
      Effect.gen(function* () {
        const recorderA = yield* createUser('teamA-treasurer');
        const teamA = yield* createTeam(nextDiscordId(), recorderA.id);
        const ownerB = yield* createUser('teamB-owner');
        const teamB = yield* createTeam(nextDiscordId(), ownerB.id);
        const memberBUser = yield* createUser('teamB-member');
        const memberB = yield* createTeamMember(teamB.id, memberBUser.id);

        const credits = yield* MemberCreditsRepository.asEffect();
        const result = yield* Effect.result(
          credits.settle(
            settleInput({
              teamId: teamA.id,
              teamMemberId: memberB.id,
              recordedByUserId: recorderA.id,
              amountMinor: 100000,
              expectedOutstandingMinor: 0,
              expectedCreditMinor: 0,
            }),
          ),
        );
        expectFailureTag(result as never, 'FinanceMemberNotFound');

        const sql = yield* SqlClient.SqlClient.asEffect();
        expect(yield* accountRowCount(sql, memberB.id)).toBe(0);

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    // B1's regression test. Without the `JOIN team_members … WHERE tm.team_id` scoping on the
    // account lock (§5.1 step 1), zero rows from step 0's cross-team INSERT does NOT imply the
    // member is foreign — it also matches "the account row already exists from a PRIOR,
    // legitimate settlement inside the member's real team". This is the case an existing account
    // row makes reachable, and the sibling test (4.37, no account row) passes vacuously without
    // this fix: it would 404 anyway just from step 0 finding no matching team membership.
    '4.38 settle for a foreign member who ALREADY HAS a credit account → FinanceMemberNotFound, nothing written',
    () =>
      Effect.gen(function* () {
        const recorderB = yield* createUser('teamB-treasurer');
        const teamB = yield* createTeam(nextDiscordId(), recorderB.id);
        const memberBUser = yield* createUser('teamB-member-38');
        const memberB = yield* createTeamMember(teamB.id, memberBUser.id);

        const credits = yield* MemberCreditsRepository.asEffect();
        // Legitimate prior settlement inside B creates the account row.
        yield* depositCredit(credits, {
          teamId: teamB.id,
          teamMemberId: memberB.id,
          recordedByUserId: recorderB.id,
          amountMinor: 200,
        });

        const recorderA = yield* createUser('teamA-treasurer-38');
        const teamA = yield* createTeam(nextDiscordId(), recorderA.id);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const depositsBefore = yield* depositCount(sql, memberB.id);

        const result = yield* Effect.result(
          credits.settle(
            settleInput({
              teamId: teamA.id,
              teamMemberId: memberB.id,
              recordedByUserId: recorderA.id,
              amountMinor: 100000,
              expectedOutstandingMinor: 0,
              expectedCreditMinor: 0,
            }),
          ),
        );
        expectFailureTag(result as never, 'FinanceMemberNotFound');

        expect(yield* balanceOf(sql, memberB.id)).toBe(200);
        expect(yield* depositCount(sql, memberB.id)).toBe(depositsBefore);

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.39 listDepositsByMember returns voided rows only with includeVoided=true', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 500,
      });
      const sql = yield* SqlClient.SqlClient.asEffect();
      const depositId = yield* latestDepositId(sql, member.id);
      yield* credits.voidDeposit({
        teamId: team.id,
        memberId: member.id,
        depositId: depositId as never,
        voidedByUserId: recordedByUserId as never,
        reason: 'test void',
      });

      const withoutVoided = yield* credits.listDepositsByMember({
        teamId: team.id,
        teamMemberId: member.id,
        currency: CZK,
        includeVoided: false,
      });
      expect(withoutVoided).toHaveLength(0);

      const withVoided = yield* credits.listDepositsByMember({
        teamId: team.id,
        teamMemberId: member.id,
        currency: CZK,
        includeVoided: true,
      });
      expect(withVoided).toHaveLength(1);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.40 listDepositsByMember filters by currency', () =>
    Effect.gen(function* () {
      const { team, member, recordedByUserId } = yield* seedMember();
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        amountMinor: 500,
      });
      yield* depositCredit(credits, {
        teamId: team.id,
        teamMemberId: member.id,
        recordedByUserId,
        currency: EUR,
        amountMinor: 40,
      });

      const czkDeposits = yield* credits.listDepositsByMember({
        teamId: team.id,
        teamMemberId: member.id,
        currency: CZK,
        includeVoided: false,
      });
      expect(czkDeposits).toHaveLength(1);
      const eurDeposits = yield* credits.listDepositsByMember({
        teamId: team.id,
        teamMemberId: member.id,
        currency: EUR,
        includeVoided: false,
      });
      expect(eurDeposits).toHaveLength(1);

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.41 a credit-funded payment reads back with method=credit via PaymentsRepository.listByTeam',
    () =>
      Effect.gen(function* () {
        const { team, member, recordedByUserId } = yield* seedMember();
        const credits = yield* MemberCreditsRepository.asEffect();
        const payments = yield* PaymentsRepository.asEffect();
        yield* depositCredit(credits, {
          teamId: team.id,
          teamMemberId: member.id,
          recordedByUserId,
          amountMinor: 1000,
        });
        yield* createFeeAndAssignment(team.id, member.id, 300);
        const settleResult = (yield* credits.settle(
          settleInput({
            teamId: team.id,
            teamMemberId: member.id,
            recordedByUserId,
            amountMinor: 0,
            expectedOutstandingMinor: 300,
            expectedCreditMinor: 1000,
          }),
        )) as { allocations: ReadonlyArray<{ source: string; paymentId: string }> };
        const creditPayment = settleResult.allocations.find((a) => a.source === 'credit');
        if (creditPayment === undefined) throw new Error('expected a credit-source allocation');

        const rows = yield* payments.listByTeam(team.id, {});
        const found = rows.find((p: { id: string }) => p.id === creditPayment.paymentId);
        expect(found).toBeDefined();
        expect((found as { method: string }).method).toBe('credit');

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );
});
