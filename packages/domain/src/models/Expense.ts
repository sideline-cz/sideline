import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { UserId } from '~/api/Auth.js';
import { BankTransactionId } from '~/models/BankTransaction.js';
import { AmountMinor, CurrencyCode } from '~/models/Fee.js';
import { TeamId } from '~/models/Team.js';

export { AmountMinor, CurrencyCode } from '~/models/Fee.js';

export const ExpenseId = Schema.String.pipe(Schema.brand('ExpenseId'));
export type ExpenseId = typeof ExpenseId.Type;

export const ExpenseCategory = Schema.Literals([
  'fields',
  'equipment',
  'travel',
  'tournaments',
  'other',
]);
export type ExpenseCategory = typeof ExpenseCategory.Type;

export class Expense extends Model.Class<Expense>('Expense')({
  id: Model.Generated(ExpenseId),
  team_id: TeamId,
  amount_minor: AmountMinor,
  currency: CurrencyCode,
  spent_at: Schemas.DateTimeFromDate,
  category: ExpenseCategory,
  description: Schema.String.pipe(Schema.check(Schema.isMaxLength(500))),
  // The outgoing bank movement this expense came from; None for hand-entered expenses. The
  // column is UNIQUE, so one movement can never produce two expenses.
  bank_transaction_id: Schema.OptionFromNullOr(BankTransactionId),
  created_by_user_id: UserId,
  updated_by_user_id: UserId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
