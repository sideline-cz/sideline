/**
 * Finance write bodies shared by the HTTP handlers (`api/finance.ts`, `api/expenses.ts`,
 * `api/membership-plan.ts`) and the AI write path (`services/ai/actions.ts`). Moved out
 * unchanged, so the assistant goes through the same permission, team-scoping and validation as
 * the page. No `sql.withTransaction` here — the caller owns it (the AI confirm runs inside the
 * proposal-claim transaction, which is what makes a double confirm write nothing twice).
 */
import {
  ExpenseApi,
  type Fee,
  type FeeAssignment,
  FinanceApi,
  type MembershipPlan,
  MembershipPlanApi,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { requirePermission } from '~/api/permissions.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';

interface WriteContext {
  readonly teamId: Team.TeamId;
  readonly membership: MembershipWithRole;
}

// ---------------------------------------------------------------------------
// recordPayment — `finance:record_payments`
// ---------------------------------------------------------------------------

export const recordPaymentForMemberTx = (
  args: WriteContext & {
    readonly feeId: Fee.FeeId;
    readonly assignmentId: FeeAssignment.FeeAssignmentId;
    readonly payload: FinanceApi.RecordPaymentRequest;
  },
) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      requirePermission(
        args.membership,
        'finance:record_payments',
        new FinanceApi.FinanceForbidden(),
      ),
    ),
    Effect.bind('fee', () =>
      FeesRepository.asEffect().pipe(
        Effect.flatMap((fees) => fees.findById(args.feeId)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new FinanceApi.FeeNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ fee }) =>
      fee.team_id !== args.teamId ? Effect.fail(new FinanceApi.FeeNotFound()) : Effect.void,
    ),
    Effect.tap(({ fee }) =>
      Option.isSome(fee.archived_at) ? Effect.fail(new FinanceApi.FeeArchived()) : Effect.void,
    ),
    Effect.bind('assignment', () =>
      FeeAssignmentsRepository.asEffect().pipe(
        Effect.flatMap((assignments) => assignments.findById(args.assignmentId)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new FinanceApi.AssignmentNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ assignment }) =>
      assignment.fee_id !== args.feeId
        ? Effect.fail(new FinanceApi.AssignmentNotFound())
        : Effect.void,
    ),
    Effect.tap(() =>
      args.payload.amountMinor === 0 ? Effect.fail(new FinanceApi.InvalidAmount()) : Effect.void,
    ),
    Effect.flatMap(({ assignment }) =>
      PaymentsRepository.asEffect().pipe(
        Effect.flatMap((payments) =>
          payments.insert({
            feeAssignmentId: args.assignmentId,
            teamMemberId: assignment.team_member_id,
            amountMinor: args.payload.amountMinor,
            method: args.payload.method,
            paidAt: args.payload.paidAt,
            note: args.payload.note,
            recordedByUserId: args.membership.user_id,
          }),
        ),
      ),
    ),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'Failed recording payment — no row returned'),
    ),
  );

// ---------------------------------------------------------------------------
// createExpense — `finance:manage_fees` (it also gates expense writes; Captain stays read-only by
// lacking it)
// ---------------------------------------------------------------------------

export const createExpenseForMemberTx = (
  args: WriteContext & { readonly payload: ExpenseApi.CreateExpenseRequest },
) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      requirePermission(args.membership, 'finance:manage_fees', new ExpenseApi.ExpenseForbidden()),
    ),
    Effect.tap(() =>
      args.payload.amountMinor <= 0
        ? Effect.fail(new ExpenseApi.InvalidExpenseAmount())
        : Effect.void,
    ),
    // Provenance link, when the treasurer created this from the bank tab. Only checks that the
    // movement is this team's and is outgoing — "already expensed?" is left entirely to the
    // `uq_expenses_bank_transaction_id` violation below, so two concurrent creates for one
    // movement cannot both succeed.
    Effect.tap(() =>
      Option.match(args.payload.bankTransactionId, {
        onNone: () => Effect.void,
        onSome: (txId) =>
          BankTransactionsRepository.asEffect().pipe(
            Effect.flatMap((bankTransactions) =>
              bankTransactions.findByIdAndTeam(txId, args.teamId),
            ),
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new ExpenseApi.InvalidBankTransactionForExpense()),
                onSome: (tx) =>
                  tx.direction === 'outgoing'
                    ? Effect.void
                    : Effect.fail(new ExpenseApi.InvalidBankTransactionForExpense()),
              }),
            ),
          ),
      }),
    ),
    Effect.flatMap(() =>
      ExpensesRepository.asEffect().pipe(
        Effect.flatMap((expenses) =>
          expenses.insert({
            team_id: args.teamId,
            amount_minor: args.payload.amountMinor,
            currency: args.payload.currency,
            spent_at: args.payload.spentAt,
            category: args.payload.category,
            description: args.payload.description,
            bank_transaction_id: args.payload.bankTransactionId,
            created_by_user_id: args.membership.user_id,
            updated_by_user_id: args.membership.user_id,
          }),
        ),
      ),
    ),
    Effect.catchTag('BankTransactionAlreadyExpensed', () =>
      Effect.fail(new ExpenseApi.BankTransactionAlreadyExpensed()),
    ),
    Effect.catchTag(
      'NoSuchElementError',
      LogicError.withMessage(() => 'Expense insert returned no row'),
    ),
  );

// ---------------------------------------------------------------------------
// assignMembershipPlan — `finance:manage_fees`. No deadline check: the deadline binds members,
// not the treasurer (§B.2).
// ---------------------------------------------------------------------------

export const assignMembershipPlanForMemberTx = (
  args: WriteContext & {
    readonly memberId: TeamMember.TeamMemberId;
    readonly membershipPlanId: Option.Option<MembershipPlan.MembershipPlanId>;
  },
) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      requirePermission(args.membership, 'finance:manage_fees', new MembershipPlanApi.Forbidden()),
    ),
    Effect.bind('rowsAffected', () =>
      MembershipPlansRepository.asEffect().pipe(
        Effect.flatMap((plans) =>
          plans.assignMembershipPlan({
            member_id: args.memberId,
            team_id: args.teamId,
            plan_id: args.membershipPlanId,
          }),
        ),
        Effect.catchTag('MembershipPlanCurrencyHasPaymentsError', () =>
          Effect.fail(new MembershipPlanApi.MembershipPlanCurrencyHasPayments()),
        ),
      ),
    ),
    // 0 rows IS the Atomic Conditional UPDATE's combined guard result. ONE 404 covers both "plan
    // bad/archived/foreign" and "member gone/inactive/wrong team" — unlike `selectMembershipPlan`
    // there is no deadline to tell apart, both mean "reload the page", and classifying would cost
    // a query. Deliberately NO re-read.
    Effect.flatMap(({ rowsAffected }) =>
      rowsAffected === 0
        ? Effect.fail(new MembershipPlanApi.MembershipPlanNotFound())
        : Effect.void,
    ),
  );
