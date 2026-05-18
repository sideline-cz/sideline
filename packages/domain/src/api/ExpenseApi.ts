import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware, UserId } from '~/api/Auth.js';
import { AmountMinor, CurrencyCode, ExpenseCategory, ExpenseId } from '~/models/Expense.js';
import { TeamId } from '~/models/Team.js';

// Net balance can be negative (income < expenses), so we allow any integer.
const _intFilter = Schema.makeFilter((n: number) => Number.isInteger(n), {
  message: 'Expected an integer',
  meta: { _tag: 'isInt' as const },
  toArbitraryConstraint: { number: { isInteger: true } },
});
export const NetAmountMinor = Schema.Union([
  Schema.Number.pipe(Schema.check(_intFilter)),
  Schema.NumberFromString.pipe(Schema.check(_intFilter)),
]).pipe(Schema.brand('NetAmountMinor'));
export type NetAmountMinor = typeof NetAmountMinor.Type;

// ---------------------------------------------------------------------------
// View types (response DTOs)
// ---------------------------------------------------------------------------

export class ExpenseView extends Schema.Class<ExpenseView>('ExpenseView')({
  expenseId: ExpenseId,
  teamId: TeamId,
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  spentAt: Schemas.DateTimeFromIsoString,
  category: ExpenseCategory,
  description: Schema.String,
  createdByUserId: UserId,
  createdByName: Schema.OptionFromNullOr(Schema.String),
  updatedByUserId: UserId,
  updatedByName: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schemas.DateTimeFromIsoString,
  updatedAt: Schemas.DateTimeFromIsoString,
}) {}

export class BalanceSummary extends Schema.Class<BalanceSummary>('BalanceSummary')({
  currency: CurrencyCode,
  incomeMinor: AmountMinor,
  expensesMinor: AmountMinor,
  netMinor: NetAmountMinor,
  byCategory: Schema.Array(
    Schema.Struct({
      category: ExpenseCategory,
      amountMinor: AmountMinor,
    }),
  ),
}) {}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const CreateExpenseRequest = Schema.Struct({
  amountMinor: AmountMinor,
  currency: CurrencyCode,
  spentAt: Schemas.DateTimeFromIsoString,
  category: ExpenseCategory,
  description: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
});
export type CreateExpenseRequest = Schema.Schema.Type<typeof CreateExpenseRequest>;

export const UpdateExpenseRequest = Schema.Struct({
  amountMinor: Schema.OptionFromOptional(AmountMinor),
  currency: Schema.OptionFromOptional(CurrencyCode),
  spentAt: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
  category: Schema.OptionFromOptional(ExpenseCategory),
  description: Schema.OptionFromOptional(Schema.String.pipe(Schema.check(Schema.isMaxLength(500)))),
});
export type UpdateExpenseRequest = Schema.Schema.Type<typeof UpdateExpenseRequest>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class ExpenseNotFound extends Schema.TaggedErrorClass<ExpenseNotFound>()(
  'ExpenseNotFound',
  {},
) {}

export class ExpenseForbidden extends Schema.TaggedErrorClass<ExpenseForbidden>()(
  'ExpenseForbidden',
  {},
) {}

export class InvalidExpenseAmount extends Schema.TaggedErrorClass<InvalidExpenseAmount>()(
  'InvalidExpenseAmount',
  {},
) {}

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class ExpenseApiGroup extends HttpApiGroup.make('expenses')
  .add(
    HttpApiEndpoint.get('listExpenses', '/teams/:teamId/expenses', {
      success: Schema.Array(ExpenseView),
      error: ExpenseForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        category: Schema.OptionFromOptional(ExpenseCategory),
        from: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
        to: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
      },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getExpense', '/teams/:teamId/expenses/:expenseId', {
      success: ExpenseView,
      error: [
        ExpenseForbidden.pipe(HttpApiSchema.status(403)),
        ExpenseNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, expenseId: ExpenseId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createExpense', '/teams/:teamId/expenses', {
      success: ExpenseView.pipe(HttpApiSchema.status(201)),
      error: [
        ExpenseForbidden.pipe(HttpApiSchema.status(403)),
        ExpenseNotFound.pipe(HttpApiSchema.status(404)),
        InvalidExpenseAmount.pipe(HttpApiSchema.status(400)),
      ],
      payload: CreateExpenseRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateExpense', '/teams/:teamId/expenses/:expenseId', {
      success: ExpenseView,
      error: [
        ExpenseForbidden.pipe(HttpApiSchema.status(403)),
        ExpenseNotFound.pipe(HttpApiSchema.status(404)),
        InvalidExpenseAmount.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpdateExpenseRequest,
      params: { teamId: TeamId, expenseId: ExpenseId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('deleteExpense', '/teams/:teamId/expenses/:expenseId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        ExpenseForbidden.pipe(HttpApiSchema.status(403)),
        ExpenseNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, expenseId: ExpenseId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('balanceSummary', '/teams/:teamId/finances/balance-summary', {
      success: Schema.Array(BalanceSummary),
      error: ExpenseForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
      query: {
        from: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
        to: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
      },
    }).middleware(AuthMiddleware),
  ) {}
