// `AutoApplyCreditCron` — spending held member credit without a treasurer clicking Settle.
//
// The cron owns no money arithmetic: it is a candidate query plus `MemberCreditsRepository.settle`
// with `amountMinor: 0`. So these tests deliberately do NOT re-prove allocation (oldest-due-first,
// partial coverage, the reconciliation identity) — `MemberCreditsRepository.test.ts` already pins
// all of it on the same code path, and duplicating it here would just be two suites that can
// disagree. What IS pinned here is everything the cron adds: who it picks, who it refuses to
// pick, and that running it twice spends the credit once.

import { describe, expect, it } from '@effect/vitest';
import type { Fee } from '@sideline/domain';
import { DateTime, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { MemberCreditsRepository } from '~/repositories/MemberCreditsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { autoApplyCreditCronEffect } from '~/services/AutoApplyCreditCron.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  nextDiscordId,
} from '../bankSyncFixtures.js';
import { assertCreditReconciles } from '../creditReconciliation.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

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

const CZK = 'CZK' as Fee.CurrencyCode;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Team + member + a `team_settings` row. `optIn` writes the treasurer's user id into
 *  `auto_apply_credit_by_user_id`, which is simultaneously the flag and the recorder. */
const seed = (optIn: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const treasurer = yield* createUser('auto-apply-treasurer');
    const team = yield* createTeam(nextDiscordId(), treasurer.id);
    const memberUser = yield* createUser('auto-apply-member');
    const member = yield* createTeamMember(team.id, memberUser.id);

    yield* sql`
      INSERT INTO team_settings (team_id, auto_apply_credit_by_user_id)
      VALUES (${team.id}, ${optIn ? treasurer.id : null})
      ON CONFLICT (team_id) DO UPDATE
        SET auto_apply_credit_by_user_id = EXCLUDED.auto_apply_credit_by_user_id
    `;

    return { team, member, treasurerId: treasurer.id };
  });

/** Put credit on the books the way a treasurer's deposit does — balance plus the deposit row
 *  that explains it, so `assertCreditReconciles` stays meaningful. */
const giveCredit = (teamMemberId: string, recordedByUserId: string, amountMinor: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
      VALUES (${teamMemberId}::uuid, ${CZK}, ${amountMinor})
      ON CONFLICT (team_member_id, currency)
        DO UPDATE SET balance_minor = member_credit_accounts.balance_minor + ${amountMinor}
    `;
    yield* sql`
      INSERT INTO member_credit_deposits
        (team_member_id, currency, amount_minor, method, paid_at, recorded_by_user_id)
      VALUES (${teamMemberId}::uuid, ${CZK}, ${amountMinor}, 'cash', now(), ${recordedByUserId}::uuid)
    `;
  });

/** A training-kind fee for `monthsAgo` months back, plus this member's assignment on it.
 *  `monthsAgo: 0` is the CURRENT period — the one `recompute_training_period_fees` is still
 *  revising, and the one the sweep must refuse to touch. */
const createTrainingFeeAndAssignment = (
  teamId: string,
  teamMemberId: string,
  amountMinor: number,
  monthsAgo: number,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly id: string }>`
      INSERT INTO fees (team_id, kind, period_start, name, amount_minor, currency, due_at, target_scope)
      VALUES (
        ${teamId}::uuid, 'training',
        (date_trunc('month', now()) - (${monthsAgo} || ' months')::interval)::date,
        'training-' || ${monthsAgo}::text, ${amountMinor}, ${CZK},
        now() + INTERVAL '30 days', 'custom'
      )
      RETURNING id::text AS id
    `;
    const feeId = rows[0]?.id;
    if (feeId === undefined) throw new Error('training fee insert returned no row');
    yield* sql`
      INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
      VALUES (${feeId}::uuid, ${teamMemberId}::uuid, ${amountMinor})
    `;
    return feeId;
  });

const balanceOf = (teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly balance_minor: string }>`
        SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
         WHERE team_member_id = ${teamMemberId}::uuid AND currency = ${CZK}
      `,
    ),
    Effect.map((rows) => Number(rows[0]?.balance_minor ?? 0)),
  );

/** Every non-voided credit-method payment for a member, newest-insert last. */
const creditPaymentsOf = (teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly amount_minor: string; readonly recorded_by_user_id: string }>`
        SELECT p.amount_minor::text AS amount_minor,
               p.recorded_by_user_id::text AS recorded_by_user_id
          FROM payments p
         WHERE p.team_member_id = ${teamMemberId}::uuid
           AND p.method = 'credit' AND p.voided_at IS NULL
         ORDER BY p.created_at ASC, p.id ASC
      `,
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AutoApplyCreditCron', () => {
  it.effect('a team that has NOT opted in is untouched', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(false);
      yield* createFeeAndAssignment(team.id, member.id, 50_000);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('applies held credit against an outstanding fee once the team opts in', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 50_000);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      // Partial coverage: 300 CZK of credit against 500 CZK of debt leaves 200 outstanding and
      // zero credit — `planSettlement` drains the pool, it never rounds or refuses a partial.
      expect(yield* balanceOf(member.id)).toBe(0);
      const payments = yield* creditPaymentsOf(member.id);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0]?.amount_minor)).toBe(30_000);
      // The recorder is the user named by the opt-in column, NOT a system sentinel —
      // `payments.recorded_by_user_id` is NOT NULL and this is where the value comes from.
      expect(payments[0]?.recorded_by_user_id).toBe(treasurerId);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // THE acceptance criterion. Spending credit is a stateful transfer, not a derivation, so the
  // idempotence `recompute_training_period_fees` gets for free by recomputing from scratch does
  // NOT transfer here. This runs the sweep twice over the same starting state and pins that the
  // balance moved exactly once.
  it.effect('running the sweep twice spends the credit once', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 50_000);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;
      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(0);
      const payments = yield* creditPaymentsOf(member.id);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0]?.amount_minor)).toBe(30_000);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a second tick applies nothing when the credit is already spent in full', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 20_000);
      yield* giveCredit(member.id, treasurerId, 20_000);

      yield* autoApplyCreditCronEffect;
      const afterFirst = yield* balanceOf(member.id);
      yield* autoApplyCreditCronEffect;

      // Fully covered on tick one; the member is simply not a candidate on tick two, which is
      // what keeps the steady state at zero writes per minute.
      expect(afterFirst).toBe(0);
      expect(yield* balanceOf(member.id)).toBe(0);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(1);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Question 4 of the ticket, and the reason the candidate query is bespoke rather than "anyone
  // with a balance". While the period is open, `recompute_training_period_fees` is still revising
  // `amount_minor`; credit applied now and recomputed DOWNWARD later would freeze the fee at the
  // inflated amount the S3 `GREATEST(charge, paid_minor)` clamp holds it to.
  it.effect('skips a member while they owe an OPEN-period training fee', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createTrainingFeeAndAssignment(team.id, member.id, 50_000, 0);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // The gate is per MEMBER, not per assignment: one open training fee parks the whole member,
  // because `settle` derives its own candidate set and reconciles against the FULL outstanding
  // total, so "settle everything except the training row" is not expressible.
  it.effect('an open-period training fee parks the member’s OTHER fees too', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 20_000);
      yield* createTrainingFeeAndAssignment(team.id, member.id, 50_000, 0);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Once the period is over the recompute early-returns (migration 1793200000) and the amount can
  // never move again, so the hazard above is unreachable rather than merely tolerated.
  it.effect('applies credit to a training fee whose period has CLOSED', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createTrainingFeeAndAssignment(team.id, member.id, 50_000, 2);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(0);
      const payments = yield* creditPaymentsOf(member.id);
      expect(payments).toHaveLength(1);
      expect(Number(payments[0]?.amount_minor)).toBe(30_000);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('leaves a member holding credit but owing nothing alone', () =>
    Effect.gen(function* () {
      const { member, treasurerId } = yield* seed(true);
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      // Pure "paid in advance". No outstanding row means no candidate at all — the sweep must not
      // invent one, and must not touch the balance.
      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('allocates oldest-due-first across several fees, exactly as Settle would', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const now = DateTime.nowUnsafe();
      const older = DateTime.add(now, { days: -20 });
      const newer = DateTime.add(now, { days: -5 });
      yield* createFeeAndAssignment(team.id, member.id, 20_000, {
        name: 'newer',
        dueAt: newer,
      });
      yield* createFeeAndAssignment(team.id, member.id, 20_000, {
        name: 'older',
        dueAt: older,
      });
      yield* giveCredit(member.id, treasurerId, 25_000);

      yield* autoApplyCreditCronEffect;

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly name: string; readonly paid_minor: string }>`
        SELECT f.name, fa.paid_minor::text AS paid_minor
          FROM fee_assignments fa JOIN fees f ON f.id = fa.fee_id
         WHERE fa.team_member_id = ${member.id}::uuid
         ORDER BY f.name ASC
      `;
      const paidByName = new Map(rows.map((r) => [r.name, Number(r.paid_minor)]));
      // 250 of credit over two 200 fees: the OLDER one is covered in full and the remainder
      // lands on the newer one. The reverse split would mean the cron had its own allocator.
      expect(paidByName.get('older')).toBe(20_000);
      expect(paidByName.get('newer')).toBe(5_000);
      expect(yield* balanceOf(member.id)).toBe(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('never crosses currencies', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 50_000, { currency: 'EUR' });
      yield* giveCredit(member.id, treasurerId, 30_000);

      yield* autoApplyCreditCronEffect;

      // CZK credit cannot pay a EUR fee: the candidate join is keyed on the account's currency.
      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('ignores waived and archived rows, exactly as Settle does', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const waived = yield* createFeeAndAssignment(team.id, member.id, 20_000, { name: 'waived' });
      const archived = yield* createFeeAndAssignment(team.id, member.id, 20_000, {
        name: 'archived',
      });
      yield* giveCredit(member.id, treasurerId, 30_000);

      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fee_assignments SET stored_status = 'waived' WHERE id = ${waived.assignment.id}::uuid`;
      yield* sql`UPDATE fees SET archived_at = now() WHERE id = ${archived.fee.id}::uuid`;

      yield* autoApplyCreditCronEffect;

      // Neither is collectable debt, so there is no candidate at all and the balance stands.
      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a deleted opt-in user turns the sweep off rather than mis-attributing money', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 50_000);
      yield* giveCredit(member.id, treasurerId, 30_000);

      // ON DELETE SET NULL on the column: losing the named user is losing the flag. The
      // alternative — keeping it on with nobody to record the payments under — cannot satisfy
      // `payments.recorded_by_user_id NOT NULL`.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE team_settings SET auto_apply_credit_by_user_id = NULL WHERE team_id = ${team.id}`;

      yield* autoApplyCreditCronEffect;

      expect(yield* balanceOf(member.id)).toBe(30_000);
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a member with no credit account is never a candidate', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      yield* createFeeAndAssignment(team.id, member.id, 50_000);

      yield* autoApplyCreditCronEffect;

      // The account join is INNER: no row, no candidate. A member who has simply never held
      // credit must not have one minted for them by a sweep.
      expect(yield* creditPaymentsOf(member.id)).toHaveLength(0);
      expect(yield* balanceOf(member.id)).toBe(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});
