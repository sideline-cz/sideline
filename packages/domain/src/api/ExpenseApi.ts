import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware, UserId } from '~/api/Auth.js';
import { BankTransactionId } from '~/models/BankTransaction.js';
import {
  AmountMinor,
  CurrencyCode,
  ExpenseAttachmentId,
  ExpenseAttachmentMeta,
  ExpenseCategory,
  ExpenseId,
} from '~/models/Expense.js';
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
  // Set when the expense was created from an outgoing bank movement (either by a treasurer from
  // the bank tab, or by the poller's opt-in auto-create).
  bankTransactionId: Schema.OptionFromNullOr(BankTransactionId),
  createdByUserId: UserId,
  createdByName: Schema.OptionFromNullOr(Schema.String),
  updatedByUserId: UserId,
  updatedByName: Schema.OptionFromNullOr(Schema.String),
  createdAt: Schemas.DateTimeFromIsoString,
  updatedAt: Schemas.DateTimeFromIsoString,
  // Metadata only, never bytes. Empty array = no invoice attached, which is what the list
  // page's "no invoice" badge and the missing-invoice filter read.
  attachments: Schema.Array(ExpenseAttachmentMeta),
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
  // Optional provenance link. When present the movement must belong to this team and be
  // outgoing; a movement that already has an expense is rejected with `BankTransactionAlreadyExpensed`.
  bankTransactionId: Schema.OptionFromOptional(BankTransactionId),
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

export const UploadExpenseAttachmentRequest = Schema.Struct({
  filename: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(255)),
  ),
  contentType: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))),
  // The 7e6 ceiling is the absurd-body backstop, NOT the file-size limit. Base64 of the real
  // 5 MB cap is 6,990,508 chars, so every legitimate file passes and the 413 from
  // `checkExpenseAttachment` still owns the actual limit. Without it the schema accepts a 1 GB
  // string that gets fully read, JSON-parsed and then `Buffer.from`-decoded into a second
  // allocation before anything checks the size — an authenticated member can OOM the process.
  contentBase64: Schema.String.pipe(
    Schema.check(Schema.isMinLength(1)),
    Schema.check(Schema.isMaxLength(7_000_000)),
  ),
});
export type UploadExpenseAttachmentRequest = Schema.Schema.Type<
  typeof UploadExpenseAttachmentRequest
>;

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

// The referenced movement already produced an expense. Raised from the `expenses.bank_transaction_id`
// unique violation, never from a pre-flight SELECT — the constraint is the only arbiter.
export class BankTransactionAlreadyExpensed extends Schema.TaggedErrorClass<BankTransactionAlreadyExpensed>()(
  'BankTransactionAlreadyExpensed',
  {},
) {}

// The referenced movement is not an outgoing movement of this team.
export class InvalidBankTransactionForExpense extends Schema.TaggedErrorClass<InvalidBankTransactionForExpense>()(
  'InvalidBankTransactionForExpense',
  {},
) {}

export class ExpenseAttachmentNotFound extends Schema.TaggedErrorClass<ExpenseAttachmentNotFound>()(
  'ExpenseAttachmentNotFound',
  {},
) {}

// The decoded file exceeds MAX_EXPENSE_ATTACHMENT_BYTES (5 MB).
export class ExpenseAttachmentTooLarge extends Schema.TaggedErrorClass<ExpenseAttachmentTooLarge>()(
  'ExpenseAttachmentTooLarge',
  {},
) {}

// Either the declared content type is not on the allowlist, or the decoded bytes do not carry
// that type's signature. One error for both: the declared value is attacker-controlled, so
// "you lied about the type" and "that type is not allowed" are the same answer to the client.
export class ExpenseAttachmentTypeNotAllowed extends Schema.TaggedErrorClass<ExpenseAttachmentTypeNotAllowed>()(
  'ExpenseAttachmentTypeNotAllowed',
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
        InvalidBankTransactionForExpense.pipe(HttpApiSchema.status(400)),
        BankTransactionAlreadyExpensed.pipe(HttpApiSchema.status(409)),
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
    HttpApiEndpoint.post(
      'uploadExpenseAttachment',
      '/teams/:teamId/expenses/:expenseId/attachments',
      {
        success: ExpenseAttachmentMeta.pipe(HttpApiSchema.status(201)),
        error: [
          ExpenseForbidden.pipe(HttpApiSchema.status(403)),
          ExpenseNotFound.pipe(HttpApiSchema.status(404)),
          ExpenseAttachmentTooLarge.pipe(HttpApiSchema.status(413)),
          ExpenseAttachmentTypeNotAllowed.pipe(HttpApiSchema.status(415)),
        ],
        payload: UploadExpenseAttachmentRequest,
        params: { teamId: TeamId, expenseId: ExpenseId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'downloadExpenseAttachment',
      '/teams/:teamId/expenses/:expenseId/attachments/:attachmentId',
      {
        // Raw bytes; the handler returns HttpServerResponse.uint8Array directly.
        success: Schema.Void,
        error: [
          ExpenseForbidden.pipe(HttpApiSchema.status(403)),
          ExpenseNotFound.pipe(HttpApiSchema.status(404)),
          ExpenseAttachmentNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, expenseId: ExpenseId, attachmentId: ExpenseAttachmentId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete(
      'deleteExpenseAttachment',
      '/teams/:teamId/expenses/:expenseId/attachments/:attachmentId',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          ExpenseForbidden.pipe(HttpApiSchema.status(403)),
          ExpenseNotFound.pipe(HttpApiSchema.status(404)),
          ExpenseAttachmentNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, expenseId: ExpenseId, attachmentId: ExpenseAttachmentId },
      },
    ).middleware(AuthMiddleware),
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
