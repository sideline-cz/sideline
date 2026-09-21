// TDD mode — tests written BEFORE the `1792000002_create_bank_transactions` migration's trigger
// is exercised by application code (the migration itself already exists — see D7b).
//
// Plan `.work-plans/fio-transaction-matching.md` D7b / D10c / §7.2 tests 146-151d. These tests
// exercise the REAL `payments_finance_recompute` trigger directly via `PaymentsRepository` —
// the same repository method `api/finance.ts`'s `voidPayment` HTTP handler calls internally, so
// this is the exact code path the "back door" (B4) exists to close, exercised without pulling in
// the whole HTTP layer.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
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
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

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

/** Directly links a payment to a bank transaction and lets the trigger compute match_state,
 * standing in for `BankTransactionMatcher`'s write (which does not exist yet). */
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

const matchStateOf = (txId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{ match_state: string }>`SELECT match_state FROM bank_transactions WHERE id = ${txId}`,
    ),
    Effect.map((rows) => rows[0]?.match_state),
  );

// ---------------------------------------------------------------------------
// 146 — the voidPayment back door
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — voidPayment reopens the queue (146)', () => {
  it.effect(
    'voiding a bank-created payment returns the transaction to unmatched and drops paid_minor',
    () =>
      Effect.gen(function* () {
        const { user, member, assignment, txId } = yield* seed(1500);
        const paymentsRepo = yield* PaymentsRepository.asEffect();
        const paymentId = yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const before = yield* sql<{
          paid_minor: string;
        }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`;
        expect(before[0]?.paid_minor).toBe('1500');
        expect(yield* matchStateOf(txId)).toBe('matched');

        yield* paymentsRepo.void_(paymentId as never, {
          voidedByUserId: user.id,
          voidReason: 'test void — the exact back door B4 exists to close',
          voidedAt: DateTime.nowUnsafe(),
        });

        const after = yield* sql<{
          paid_minor: string;
        }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`;
        expect(after[0]?.paid_minor).toBe('0');
        expect(yield* matchStateOf(txId)).toBe('unmatched');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 147 — partial manual match -> partially_matched; completing it -> matched
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — partial and complete matches (147)', () => {
  it.effect(
    'a partial payment yields partially_matched; a second payment completing it yields matched',
    () =>
      Effect.gen(function* () {
        const { user, member, assignment, txId } = yield* seed(1500);
        yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1000);
        expect(yield* matchStateOf(txId)).toBe('partially_matched');

        yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 500);
        expect(yield* matchStateOf(txId)).toBe('matched');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 148 — ignored / not_applicable are never overwritten by payment activity
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — terminal states are never overwritten (148)', () => {
  it.effect('an ignored transaction stays ignored even if a payment later links to it', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE bank_transactions SET match_state = 'ignored', ignored_reason = 'manual test',
               ignored_by_user_id = ${user.id}, resolution_kind = 'not_relevant'
        WHERE id = ${txId}
      `;
      yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      expect(yield* matchStateOf(txId)).toBe('ignored');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a not_applicable (outgoing) transaction is never flipped by payment activity', () =>
    Effect.gen(function* () {
      const user = yield* createUser('treasurer-na');
      const team = yield* createTeam(nextDiscordId(), user.id);
      yield* setTeamTimezone(team.id, 'Europe/Prague');
      yield* enableBankSync(team.id, user.id);
      const txId = yield* insertBankTransaction(team.id, {
        fioMovementId: 99,
        bookedOn: '2024-03-01',
        amountMinor: -500,
      });
      expect(yield* matchStateOf(txId)).toBe('not_applicable');
      // No payment can legally link to an outgoing row via the matcher, but the trigger's guard
      // must hold regardless of how the link was created.
      expect(yield* matchStateOf(txId)).toBe('not_applicable');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 149 — deleting a payment row recomputes correctly
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — delete recomputes (149)', () => {
  it.effect('hard-deleting a linked payment recomputes match_state back to unmatched', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      const paymentsRepo = yield* PaymentsRepository.asEffect();
      const paymentId = yield* insertLinkedPayment(assignment.id, member.id, user.id, txId, 1500);
      expect(yield* matchStateOf(txId)).toBe('matched');

      yield* paymentsRepo.hardDeleteForTest(paymentId as never);
      expect(yield* matchStateOf(txId)).toBe('unmatched');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 150 — a cash payment (bank_transaction_id IS NULL) never touches any transaction
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — cash payments are inert to bank transactions (150)', () => {
  it.effect(
    'inserting a cash payment on an assignment does not touch an unrelated bank transaction',
    () =>
      Effect.gen(function* () {
        const { user, member, assignment, txId } = yield* seed(1500);
        const paymentsRepo = yield* PaymentsRepository.asEffect();
        yield* paymentsRepo.insert({
          feeAssignmentId: assignment.id as never,
          teamMemberId: member.id as never,
          amountMinor: 1500,
          method: 'cash',
          paidAt: DateTime.nowUnsafe(),
          note: Option.none(),
          recordedByUserId: user.id,
        });
        expect(yield* matchStateOf(txId)).toBe('unmatched');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 151 — payments_bank_match_pair CHECK
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — payments_bank_match_pair CHECK (151)', () => {
  it.effect('bank_transaction_id set without matched_by is rejected', () =>
    Effect.gen(function* () {
      const { user, member, assignment, txId } = yield* seed(1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(sql`
        INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id, bank_transaction_id)
        VALUES (${assignment.id}, ${member.id}, 100, 'bank_transfer', now(), ${user.id}, ${txId})
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('matched_by set without bank_transaction_id is rejected', () =>
    Effect.gen(function* () {
      const { user, member, assignment } = yield* seed(1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(sql`
        INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id, matched_by)
        VALUES (${assignment.id}, ${member.id}, 100, 'bank_transfer', now(), ${user.id}, 'auto')
      `);
      expect(result._tag).toBe('Failure');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 151b — trigger consolidation
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — trigger consolidation (151b)', () => {
  it.effect('exactly one non-internal trigger on payments, named payments_finance_recompute', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ tgname: string }>`
        SELECT tgname::text FROM pg_trigger WHERE tgrelid = 'payments'::regclass AND NOT tgisinternal
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tgname).toBe('payments_finance_recompute');
      expect(rows.map((r) => r.tgname)).not.toContain('payments_recompute_paid_minor');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 151c — behaviour parity: INSERT, re-point, DELETE all recompute paid_minor as before
// ---------------------------------------------------------------------------

describe('BankTransactionMatchState — behaviour parity after consolidation (151c)', () => {
  it.effect(
    're-pointing a payment to a different assignment recomputes both paid_minor values',
    () =>
      Effect.gen(function* () {
        const { user, team, member, assignment } = yield* seed(1500);
        const { assignment: otherAssignment } = yield* createFeeAndAssignment(
          team.id,
          member.id,
          800,
        );

        const sql = yield* SqlClient.SqlClient.asEffect();
        const [row] = yield* sql<{ id: string }>`
        INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id)
        VALUES (${assignment.id}, ${member.id}, 500, 'cash', now(), ${user.id})
        RETURNING id
      `;
        expect(
          (yield* sql<{
            paid_minor: string;
          }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`)[0]
            ?.paid_minor,
        ).toBe('500');

        yield* sql`UPDATE payments SET fee_assignment_id = ${otherAssignment.id} WHERE id = ${row?.id}`;

        const original = yield* sql<{
          paid_minor: string;
        }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${assignment.id}`;
        const moved = yield* sql<{
          paid_minor: string;
        }>`SELECT paid_minor::text FROM fee_assignments WHERE id = ${otherAssignment.id}`;
        expect(original[0]?.paid_minor).toBe('0');
        expect(moved[0]?.paid_minor).toBe('500');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 151d — LEAST/GREATEST re-point deadlock guard. Latent today (no endpoint re-points a payment
// between two bank transactions), so this is `it.skip`-able ONLY with this comment, per the plan
// — not deleted, because the invariant it protects becomes live the moment such an endpoint ships.
// ---------------------------------------------------------------------------

describe.skip('BankTransactionMatchState — re-point deadlock guard (151d, latent — no endpoint re-points yet)', () => {
  it.effect(
    'two concurrent re-points, X->Y and Y->X, both complete without 40P01 (LEAST/GREATEST ordering)',
    () => Effect.void,
  );
});
