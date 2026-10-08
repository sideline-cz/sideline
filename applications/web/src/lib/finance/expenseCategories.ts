/**
 * Expense category labels, as the explicit `Record<Category, () => string>` the
 * `lib/event-labels.ts:13` idiom prescribes — never `` tr(`expense_category_${c}`) ``, which is
 * invisible to `lib/staticTrKeys.test.ts` and prints the raw key on a miss.
 *
 * Shared by the expenses page's filter chips and the search/assistant result card, so the two
 * cannot drift. `CATEGORY_ORDER` is the display order the filter row renders in.
 */
import type { Expense } from '@sideline/domain';
import { tr } from '~/lib/translations.js';

export const expenseCategoryLabels: Record<Expense.ExpenseCategory, () => string> = {
  fields: () => tr('expense_category_fields'),
  equipment: () => tr('expense_category_equipment'),
  travel: () => tr('expense_category_travel'),
  tournaments: () => tr('expense_category_tournaments'),
  other: () => tr('expense_category_other'),
};

export const CATEGORY_ORDER: ReadonlyArray<Expense.ExpenseCategory> = [
  'fields',
  'equipment',
  'travel',
  'tournaments',
  'other',
];
