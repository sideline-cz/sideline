// Auto-credit: "apply the transfer oldest-due-first, turn the remainder into credit", gated on
// `bank_sync_config.auto_credit_enabled` (migration 1792800001).
//
// The first describe block is the one that matters most: with the flag OFF — the default for
// every existing club — the matcher must behave EXACTLY as it did before this feature existed.
// The flag is opt-in precisely because greedy allocation retires five of the nine review-queue
// reasons, and no club should lose its review queue without asking.

import { describe, expect, it } from '@effect/vitest';
import { Fee } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { MemberCreditsRepository } from '~/repositories/MemberCreditsRepository.js';
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
  setMemberVariableSymbol,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
  MemberCreditsRepository.Default,
  BankTransactionMatcher.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const VS = '12345';

/** One team, bank sync on, one member holding `VS`. `autoCredit` is the flag under test. */
const seed = (autoCredit: boolean) =>
  Effect.gen(function* () {
    const user = yield* createUser('treasurer');
    const team = yield* createTeam(nextDiscordId(), user.id);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    yield* enableBankSync(team.id, user.id, { autoCreditEnabled: autoCredit });
    const memberUser = yield* createUser('player-1');
    const member = yield* createTeamMember(team.id, memberUser.id);
    yield* setMemberVariableSymbol(member.id, VS);
    return { user, team, memberUser, member };
  });

const incoming = (teamId: Parameters<typeof insertBankTransaction>[0], amountMinor: number) =>
  insertBankTransaction(teamId, {
    fioMovementId: Math.floor(amountMinor + 1_000_000),
    bookedOn: '2026-03-10',
    amountMinor,
    variableSymbol: VS,
  });

const sqlOf = SqlClient.SqlClient.asEffect();

const creditBalance = (memberId: string, currency = 'CZK') =>
  sqlOf.pipe(
    Effect.flatMap(
      (sql) => sql<{ balance_minor: string }>`
        SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
         WHERE team_member_id = ${memberId} AND currency = ${currency}
      `,
    ),
    Effect.map((rows) => (rows[0] === undefined ? null : Number(rows[0].balance_minor))),
  );

const deposits = (memberId: string) =>
  sqlOf.pipe(
    Effect.flatMap(
      (sql) => sql<{
        amount_minor: string;
        source: string;
        bank_transaction_id: string | null;
        voided_at: Date | null;
        currency: string;
      }>`
        SELECT amount_minor::text, source, bank_transaction_id::text, voided_at, currency
          FROM member_credit_deposits WHERE team_member_id = ${memberId}
         ORDER BY created_at ASC
      `,
    ),
  );

const paidMinor = (assignmentId: string) =>
  sqlOf.pipe(
    Effect.flatMap(
      (sql) => sql<{ paid_minor: string }>`
        SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignmentId}
      `,
    ),
    Effect.map((rows) => Number(rows[0]?.paid_minor ?? -1)),
  );

const txState = (txId: string) =>
  sqlOf.pipe(
    Effect.flatMap(
      (sql) => sql<{ match_state: string; match_reason: string | null }>`
        SELECT match_state, match_reason FROM bank_transactions WHERE id = ${txId}
      `,
    ),
    Effect.map((rows) => rows[0]),
  );

// ---------------------------------------------------------------------------
// Flag OFF — the regression guard. Nothing below may change for existing clubs.
// ---------------------------------------------------------------------------

describe('auto-credit disabled (the default)', () => {
  it.effect('an overpayment still queues as `overpayment`, and mints no credit', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(false);
      yield* createFeeAndAssignment(team.id, member.id, 1500);
      const txId = yield* incoming(team.id, 2000);

      const matcher = yield* BankTransactionMatcher.asEffect();
      const outcome = yield* matcher.matchOne(txId as never);

      expect(outcome._tag).toBe('Queued');
      expect(outcome.matchReason).toBe('overpayment');
      // No account row at all — not merely a zero balance.
      expect(yield* creditBalance(member.id)).toBeNull();
      expect(yield* deposits(member.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a transfer with no open assignment still queues, and mints no credit', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(false);
      const txId = yield* incoming(team.id, 500);

      const matcher = yield* BankTransactionMatcher.asEffect();
      const outcome = yield* matcher.matchOne(txId as never);

      expect(outcome._tag).toBe('Queued');
      expect(outcome.matchReason).toBe('no_open_assignment');
      expect(yield* creditBalance(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Flag ON
// ---------------------------------------------------------------------------

describe('auto-credit enabled', () => {
  it.effect('a pure top-up (nothing owed) becomes credit and marks the transfer matched', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const txId = yield* incoming(team.id, 500);

      const matcher = yield* BankTransactionMatcher.asEffect();
      const outcome = yield* matcher.matchOne(txId as never);

      expect(outcome._tag).toBe('AutoMatched');
      expect(yield* creditBalance(member.id)).toBe(500);

      const rows = yield* deposits(member.id);
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.amount_minor)).toBe(500);
      expect(rows[0]?.source).toBe('auto');
      expect(rows[0]?.bank_transaction_id).toBe(txId);

      // The whole point of extending recompute_bank_match_state: a transfer that produced ZERO
      // payments rows must still leave the review queue.
      expect((yield* txState(txId as string))?.match_state).toBe('matched');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('partial spill: oldest fee paid in full, next one partially, no credit left', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const older = yield* createFeeAndAssignment(team.id, member.id, 300, {
        name: 'Podzim',
        dueAt: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      });
      const newer = yield* createFeeAndAssignment(team.id, member.id, 400, {
        name: 'Turnaj',
        dueAt: DateTime.makeUnsafe('2026-02-01T00:00:00Z'),
      });
      const txId = yield* incoming(team.id, 500);

      const matcher = yield* BankTransactionMatcher.asEffect();
      expect((yield* matcher.matchOne(txId as never))._tag).toBe('AutoMatched');

      expect(yield* paidMinor(older.assignment.id)).toBe(300);
      expect(yield* paidMinor(newer.assignment.id)).toBe(200);
      // Every minor unit landed on a fee, so there is nothing to carry over.
      expect(yield* deposits(member.id)).toHaveLength(0);
      expect((yield* txState(txId as string))?.match_state).toBe('matched');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('overpayment: fees settled first, the remainder becomes credit', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);
      const txId = yield* incoming(team.id, 2000);

      const matcher = yield* BankTransactionMatcher.asEffect();
      expect((yield* matcher.matchOne(txId as never))._tag).toBe('AutoMatched');

      expect(yield* paidMinor(assignment.id)).toBe(1500);
      expect(yield* creditBalance(member.id)).toBe(500);
      expect((yield* txState(txId as string))?.match_state).toBe('matched');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a foreign-currency transfer credits ITS OWN currency, never the team default', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      // A CZK fee the EUR money must not touch.
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500, {
        currency: 'CZK',
      });
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 777001,
        bookedOn: '2026-03-10',
        amountMinor: 900,
        currency: 'EUR',
        variableSymbol: VS,
      });

      const matcher = yield* BankTransactionMatcher.asEffect();
      expect((yield* matcher.matchOne(txId as never))._tag).toBe('AutoMatched');

      expect(yield* paidMinor(assignment.id)).toBe(0);
      expect(yield* creditBalance(member.id, 'EUR')).toBe(900);
      expect(yield* creditBalance(member.id, 'CZK')).toBeNull();

      const rows = yield* deposits(member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.currency).toBe('EUR');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an unresolvable variable symbol still queues, flag or no flag', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 777002,
        bookedOn: '2026-03-10',
        amountMinor: 500,
        variableSymbol: '99999', // belongs to nobody
      });

      const matcher = yield* BankTransactionMatcher.asEffect();
      const outcome = yield* matcher.matchOne(txId as never);

      expect(outcome._tag).toBe('Queued');
      expect(outcome.matchReason).toBe('no_member_for_vs');
      expect(yield* creditBalance(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// Unmatch symmetry — the phantom-credit guard
// ---------------------------------------------------------------------------

describe('unmatching an auto-credited transfer', () => {
  it.effect('voids the deposit and takes the credit back off the balance', () =>
    Effect.gen(function* () {
      const { user, team, member } = yield* seed(true);
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);
      const txId = yield* incoming(team.id, 2000);

      const matcher = yield* BankTransactionMatcher.asEffect();
      yield* matcher.matchOne(txId as never);
      expect(yield* creditBalance(member.id)).toBe(500);

      yield* matcher.unmatch(txId as never, {
        reason: 'wrong person',
        unmatchedByUserId: user.id,
      });

      // Without the bank_transaction_id link this is where 500 of phantom credit would survive.
      expect(yield* creditBalance(member.id)).toBe(0);
      expect(yield* paidMinor(assignment.id)).toBe(0);

      const rows = yield* deposits(member.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.voided_at).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('refuses when the member has already spent the credit', () =>
    Effect.gen(function* () {
      const { user, team, member } = yield* seed(true);
      const txId = yield* incoming(team.id, 500);

      const matcher = yield* BankTransactionMatcher.asEffect();
      yield* matcher.matchOne(txId as never);
      expect(yield* creditBalance(member.id)).toBe(500);

      // Spend it: a new fee, settled from credit alone (no fresh cash).
      yield* createFeeAndAssignment(team.id, member.id, 500, { name: 'Dres' });
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* credits.settle({
        teamId: team.id,
        teamMemberId: member.id,
        currency: Schema.decodeSync(Fee.CurrencyCode)('CZK'),
        amountMinor: 0,
        method: 'cash',
        paidAt: DateTime.nowUnsafe(),
        note: Option.none(),
        expectedOutstandingMinor: 500,
        expectedCreditMinor: 500,
        recordedByUserId: user.id,
      });
      expect(yield* creditBalance(member.id)).toBe(0);

      const result = yield* Effect.result(
        matcher.unmatch(txId as never, {
          reason: 'returned transfer',
          unmatchedByUserId: user.id,
        }),
      );

      expect(result._tag).toBe('Failure');
      // Fungible credit: nothing records which deposit funded which application, so the only
      // honest answer is "void those payments first".
      if (result._tag === 'Failure') {
        expect(result.failure._tag).toBe('UnmatchCreditSpent');
      }

      // And nothing was half-applied: the deposit is still active, the balance still zero.
      expect(yield* creditBalance(member.id)).toBe(0);
      const rows = yield* deposits(member.id);
      expect(rows[0]?.voided_at).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});
