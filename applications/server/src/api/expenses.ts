import { Auth, ExpenseApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { BankTransactionsRepository } from '~/repositories/BankTransactionsRepository.js';
import {
  type BalanceSummaryRow,
  ExpensesRepository,
  type ExpenseWithNamesRow,
} from '~/repositories/ExpensesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const forbidden = new ExpenseApi.ExpenseForbidden();
const expenseNotFound = new ExpenseApi.ExpenseNotFound();
const invalidAmount = new ExpenseApi.InvalidExpenseAmount();
const alreadyExpensed = new ExpenseApi.BankTransactionAlreadyExpensed();
const invalidBankTransaction = new ExpenseApi.InvalidBankTransactionForExpense();

// ---------------------------------------------------------------------------
// Helpers: build view DTOs from repo rows
// ---------------------------------------------------------------------------

const fromExpenseRow = (row: ExpenseWithNamesRow): ExpenseApi.ExpenseView =>
  new ExpenseApi.ExpenseView({
    expenseId: row.id,
    teamId: row.team_id,
    amountMinor: row.amount_minor,
    currency: row.currency,
    spentAt: row.spent_at,
    category: row.category,
    description: row.description,
    bankTransactionId: row.bank_transaction_id,
    createdByUserId: row.created_by_user_id,
    createdByName: row.created_by_name,
    updatedByUserId: row.updated_by_user_id,
    updatedByName: row.updated_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toBalanceSummary = (row: BalanceSummaryRow): ExpenseApi.BalanceSummary =>
  new ExpenseApi.BalanceSummary({
    currency: row.currency,
    incomeMinor: row.incomeMinor,
    expensesMinor: row.expensesMinor,
    netMinor: row.netMinor,
    byCategory: row.byCategory,
  });

// `Option.match` boilerplate that maps `None → fail(expenseNotFound)`, `Some → succeed(value)`.
const requireFound = <A>(option: Option.Option<A>) =>
  Option.match(option, {
    onNone: () => Effect.fail(expenseNotFound),
    onSome: Effect.succeed,
  });

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const ExpenseApiLive = HttpApiBuilder.group(Api, 'expenses', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('expenses', () => ExpensesRepository.asEffect()),
    Effect.bind('bankTransactions', () => BankTransactionsRepository.asEffect()),
    Effect.map(({ members, expenses, bankTransactions }) =>
      handlers
        // ------------------------------------------------------------------
        // listExpenses
        // ------------------------------------------------------------------
        .handle('listExpenses', ({ params: { teamId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('list', () =>
              expenses.listByTeam(teamId, {
                category: Option.getOrUndefined(query.category),
                from: Option.getOrUndefined(query.from),
                to: Option.getOrUndefined(query.to),
              }),
            ),
            Effect.map(({ list }) => list.map(fromExpenseRow)),
          ),
        )
        // ------------------------------------------------------------------
        // getExpense
        // ------------------------------------------------------------------
        .handle('getExpense', ({ params: { teamId, expenseId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('expense', () =>
              expenses.findById(expenseId, teamId).pipe(Effect.flatMap(requireFound)),
            ),
            Effect.map(({ expense }) => fromExpenseRow(expense)),
          ),
        )
        // ------------------------------------------------------------------
        // createExpense
        // ------------------------------------------------------------------
        .handle('createExpense', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            // 'finance:manage_fees' also gates expense write operations; Captain remains read-only by lacking this permission.
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            Effect.tap(() => (payload.amountMinor <= 0 ? Effect.fail(invalidAmount) : Effect.void)),
            // Provenance link, when the treasurer created this from the bank tab. Only checks
            // that the movement is this team's and is outgoing — "already expensed?" is left
            // entirely to the `uq_expenses_bank_transaction_id` violation below, so two
            // concurrent creates for one movement cannot both succeed.
            Effect.tap(() =>
              Option.match(payload.bankTransactionId, {
                onNone: () => Effect.void,
                onSome: (txId) =>
                  bankTransactions.findByIdAndTeam(txId, teamId).pipe(
                    Effect.flatMap(
                      Option.match({
                        onNone: () => Effect.fail(invalidBankTransaction),
                        onSome: (tx) =>
                          tx.direction === 'outgoing'
                            ? Effect.void
                            : Effect.fail(invalidBankTransaction),
                      }),
                    ),
                  ),
              }),
            ),
            Effect.bind('expense', ({ currentUser }) =>
              expenses.insert({
                team_id: teamId,
                amount_minor: payload.amountMinor,
                currency: payload.currency,
                spent_at: payload.spentAt,
                category: payload.category,
                description: payload.description,
                bank_transaction_id: payload.bankTransactionId,
                created_by_user_id: currentUser.id,
                updated_by_user_id: currentUser.id,
              }),
            ),
            Effect.map(({ expense }) => fromExpenseRow(expense)),
            Effect.catchTag('BankTransactionAlreadyExpensed', () => Effect.fail(alreadyExpensed)),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Expense insert returned no row'),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // updateExpense
        // ------------------------------------------------------------------
        .handle('updateExpense', ({ params: { teamId, expenseId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            // 'finance:manage_fees' also gates expense write operations; Captain remains read-only by lacking this permission.
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            // Existence check before business-rule validation so a missing/cross-team id
            // returns 404 rather than 400.
            Effect.tap(() =>
              expenses.findById(expenseId, teamId).pipe(Effect.flatMap(requireFound)),
            ),
            Effect.tap(() => {
              const invalidAmt =
                Option.isSome(payload.amountMinor) && payload.amountMinor.value <= 0;
              const currencyWithoutAmount =
                Option.isSome(payload.currency) && Option.isNone(payload.amountMinor);
              return invalidAmt || currencyWithoutAmount ? Effect.fail(invalidAmount) : Effect.void;
            }),
            Effect.bind('updated', ({ currentUser }) =>
              expenses
                .update(expenseId, teamId, currentUser.id, {
                  amount_minor: payload.amountMinor,
                  currency: payload.currency,
                  spent_at: payload.spentAt,
                  category: payload.category,
                  description: payload.description,
                })
                // Race-safety: row may have been deleted between existence check and update.
                .pipe(Effect.flatMap(requireFound)),
            ),
            Effect.map(({ updated }) => fromExpenseRow(updated)),
          ),
        )
        // ------------------------------------------------------------------
        // deleteExpense
        // ------------------------------------------------------------------
        .handle('deleteExpense', ({ params: { teamId, expenseId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            // 'finance:manage_fees' also gates expense write operations; Captain remains read-only by lacking this permission.
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:manage_fees', forbidden),
            ),
            Effect.bind('deleted', ({ currentUser }) =>
              expenses.delete(expenseId, teamId, currentUser.id),
            ),
            Effect.tap(({ deleted }) => (deleted ? Effect.void : Effect.fail(expenseNotFound))),
            Effect.asVoid,
          ),
        )
        // ------------------------------------------------------------------
        // balanceSummary
        // ------------------------------------------------------------------
        .handle('balanceSummary', ({ params: { teamId }, query }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'finance:view', forbidden),
            ),
            Effect.bind('summary', () =>
              expenses.balanceSummaryByTeam(teamId, {
                from: Option.getOrUndefined(query.from),
                to: Option.getOrUndefined(query.to),
              }),
            ),
            Effect.map(({ summary }) => summary.map(toBalanceSummary)),
          ),
        ),
    ),
  ),
);
