import type { ExpenseApi } from '@sideline/domain';
import { DateTime } from 'effect';
import { ExpenseCategoryBadge } from '~/components/molecules/ExpenseCategoryBadge.js';
import {
  ListToolbar,
  listHeaderClass,
  listScrollClass,
} from '~/components/molecules/ListToolbar.js';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { formatLocalDate } from '~/lib/datetime.js';
import { CATEGORY_ORDER, expenseCategoryLabels } from '~/lib/finance/expenseCategories.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';
import { useListFilter } from '~/lib/useListFilter.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ExpenseView = ExpenseApi.ExpenseView;

interface ExpensesListPageProps {
  expenses: ReadonlyArray<ExpenseView>;
  canManageExpenses: boolean;
  fromFilter: string;
  toFilter: string;
  categoryFilter: ReadonlyArray<string>;
  onFromFilterChange: (value: string) => void;
  onToFilterChange: (value: string) => void;
  onCategoryFilterChange: (categories: ReadonlyArray<string>) => void;
  onClearFilters: () => void;
  onCreateExpense?: () => void;
  onEditExpense?: (expense: ExpenseView) => void;
  onDeleteExpense?: (expenseId: string) => void;
}

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

// `CATEGORY_ORDER` + `expenseCategoryLabels` live in `lib/finance/expenseCategories.ts` — the
// search result card renders the same labels, and a second copy here would drift.

// ---------------------------------------------------------------------------
// Toolbar config — module scope, not inline: `useListFilter` memoises on these, so a fresh
// array each render would recompute the whole list every time.
// ---------------------------------------------------------------------------

// The "missing invoice" chip and the "No invoice" row badge read the SAME condition — an empty
// `attachments` array. Keep them in step: a row the chip matches must be a row that is badged.
const hasNoInvoice = (e: ExpenseView) => e.attachments.length === 0;

const EXPENSE_FILTERS = [
  { value: 'all', labelKey: 'list_filter_all', predicate: () => true },
  { value: 'missingInvoice', labelKey: 'expenses_filter_missingInvoice', predicate: hasNoInvoice },
] as const;

const DEFAULT_FILTER = EXPENSE_FILTERS[0].value;

const spentMs = (e: ExpenseView) => Number(DateTime.toEpochMillis(e.spentAt));
const createdMs = (e: ExpenseView) => Number(DateTime.toEpochMillis(e.createdAt));

const EXPENSE_SORTS = [
  {
    // Default, and deliberately identical to the server's `ORDER BY spent_at DESC, created_at
    // DESC` — adopting the toolbar must not reshuffle the list on first paint.
    value: 'newest',
    labelKey: 'expenses_sort_newest',
    compare: (a: ExpenseView, b: ExpenseView) =>
      spentMs(b) - spentMs(a) || createdMs(b) - createdMs(a),
  },
  {
    value: 'oldest',
    labelKey: 'expenses_sort_oldest',
    compare: (a: ExpenseView, b: ExpenseView) =>
      spentMs(a) - spentMs(b) || createdMs(a) - createdMs(b),
  },
  {
    value: 'amountDesc',
    labelKey: 'expenses_sort_amountDesc',
    compare: (a: ExpenseView, b: ExpenseView) => b.amountMinor - a.amountMinor,
  },
  {
    value: 'amountAsc',
    labelKey: 'expenses_sort_amountAsc',
    compare: (a: ExpenseView, b: ExpenseView) => a.amountMinor - b.amountMinor,
  },
] as const;

const expenseSearchFields = (e: ExpenseView) => [e.description, e.category];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ExpensesListPage({
  expenses,
  canManageExpenses,
  fromFilter,
  toFilter,
  categoryFilter,
  onFromFilterChange,
  onToFilterChange,
  onCategoryFilterChange,
  onClearFilters,
  onCreateExpense,
  onEditExpense,
  onDeleteExpense,
}: ExpensesListPageProps) {
  const list = useListFilter(expenses, {
    searchOf: expenseSearchFields,
    filters: EXPENSE_FILTERS,
    sorts: EXPENSE_SORTS,
  });

  const hasFilters =
    fromFilter !== '' ||
    toFilter !== '' ||
    categoryFilter.length > 0 ||
    list.search !== '' ||
    list.filter !== DEFAULT_FILTER;

  const toggleCategory = (value: string) => {
    if (categoryFilter.includes(value)) {
      onCategoryFilterChange(categoryFilter.filter((c) => c !== value));
    } else {
      onCategoryFilterChange([...categoryFilter, value]);
    }
  };

  // The date/category filters live in the route, search and the chip live in this hook — one
  // button has to clear both halves or the toolbar state is unclearable.
  const clearAll = () => {
    onClearFilters();
    list.setSearch('');
    list.setFilter(DEFAULT_FILTER);
  };

  const header = <PageHeader canManageExpenses={canManageExpenses} onCreate={onCreateExpense} />;

  // No expenses at all — not the same thing as "nothing matched", so don't tell someone to log
  // an expense they already have.
  if (expenses.length === 0 && !hasFilters) {
    return (
      <div className='flex flex-col gap-4'>
        {header}
        <div className='flex flex-col items-center justify-center gap-4 py-16 text-center'>
          <p className='text-xl font-semibold'>{tr('expenses_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('expenses_empty_body')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {header}

      <ListToolbar
        search={list.search}
        onSearchChange={list.setSearch}
        searchPlaceholderKey='expenses_searchPlaceholder'
        filters={EXPENSE_FILTERS}
        filter={list.filter}
        onFilterChange={list.setFilter}
        sorts={EXPENSE_SORTS}
        sort={list.sort}
        onSortChange={list.setSort}
      />

      <FilterBar
        fromFilter={fromFilter}
        toFilter={toFilter}
        categoryFilter={categoryFilter}
        onFromFilterChange={onFromFilterChange}
        onToFilterChange={onToFilterChange}
        onToggleCategory={toggleCategory}
        onClearFilters={clearAll}
        hasFilters={hasFilters}
      />

      {list.filtered.length === 0 ? (
        <p className='text-muted-foreground'>{tr('list_noMatches')}</p>
      ) : (
        <div className={listScrollClass}>
          <table className='w-full text-sm'>
            <thead className={listHeaderClass}>
              <tr className='border-b'>
                <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_date')}</th>
                <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_category')}</th>
                <th className='py-2 px-3 text-left font-medium'>
                  {tr('expenses_col_description')}
                </th>
                <th className='py-2 px-3 text-right font-medium'>{tr('expenses_col_amount')}</th>
                {canManageExpenses && (
                  <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_actions')}</th>
                )}
              </tr>
            </thead>
            <tbody>
              {list.filtered.map((expense) => (
                <tr key={expense.expenseId} className='border-b hover:bg-muted/50'>
                  <td className='py-3 px-3 text-muted-foreground'>
                    {formatLocalDate(expense.spentAt)}
                  </td>
                  <td className='py-3 px-3'>
                    <ExpenseCategoryBadge category={expense.category} />
                  </td>
                  <td className='py-3 px-3 max-w-xs'>
                    {/* The badge sits OUTSIDE the truncating span: inside it, `overflow:hidden`
                        clips the nudge away on any long description while the missing-invoice
                        filter still matches the row. */}
                    <div className='flex items-center gap-2 min-w-0'>
                      <span className='truncate'>{expense.description || '—'}</span>
                      {hasNoInvoice(expense) && (
                        <Badge variant='outline' className='shrink-0'>
                          {tr('expenses_badge_noInvoice')}
                        </Badge>
                      )}
                    </div>
                  </td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(expense.amountMinor, expense.currency, 'en')}
                  </td>
                  {canManageExpenses && (
                    <td className='py-3 px-3'>
                      <div className='flex gap-2 items-center'>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={() => onEditExpense?.(expense)}
                        >
                          {tr('expenses_action_edit')}
                        </Button>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={() => onDeleteExpense?.(expense.expenseId)}
                        >
                          {tr('expenses_action_delete')}
                        </Button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header sub-component
// ---------------------------------------------------------------------------

function PageHeader({
  canManageExpenses,
  onCreate,
}: {
  canManageExpenses: boolean;
  onCreate?: () => void;
}) {
  return (
    <div className='mb-4 flex items-center justify-between'>
      <h1 className='text-2xl font-bold'>{tr('expenses_title')}</h1>
      {canManageExpenses && (
        <Button type='button' onClick={onCreate}>
          {tr('expenses_create')}
        </Button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter bar sub-component
//
// Stays beside the toolbar rather than folding into `EXPENSE_FILTERS`: the toolbar's chips are
// single-select, while categories are multi-select and a date range is not a chip at all.
// ---------------------------------------------------------------------------

interface FilterBarProps {
  fromFilter: string;
  toFilter: string;
  categoryFilter: ReadonlyArray<string>;
  onFromFilterChange: (value: string) => void;
  onToFilterChange: (value: string) => void;
  onToggleCategory: (value: string) => void;
  onClearFilters: () => void;
  hasFilters: boolean;
}

function FilterBar({
  fromFilter,
  toFilter,
  categoryFilter,
  onFromFilterChange,
  onToFilterChange,
  onToggleCategory,
  onClearFilters,
  hasFilters,
}: FilterBarProps) {
  return (
    <div className='flex flex-wrap items-center gap-3'>
      <div className='flex items-center gap-1.5'>
        <Label htmlFor='expense-filter-from' className='text-sm text-muted-foreground'>
          {tr('expenses_filter_from')}
        </Label>
        <Input
          id='expense-filter-from'
          type='date'
          value={fromFilter}
          onChange={(e) => onFromFilterChange(e.target.value)}
          className='h-8 px-2 text-sm'
        />
      </div>
      <div className='flex items-center gap-1.5'>
        <Label htmlFor='expense-filter-to' className='text-sm text-muted-foreground'>
          {tr('expenses_filter_to')}
        </Label>
        <Input
          id='expense-filter-to'
          type='date'
          value={toFilter}
          onChange={(e) => onToFilterChange(e.target.value)}
          className='h-8 px-2 text-sm'
        />
      </div>
      <div className='flex flex-wrap gap-1'>
        {CATEGORY_ORDER.map((c) => (
          <Button
            key={c}
            type='button'
            size='sm'
            variant={categoryFilter.includes(c) ? 'secondary' : 'outline'}
            aria-pressed={categoryFilter.includes(c)}
            onClick={() => onToggleCategory(c)}
          >
            {expenseCategoryLabels[c]()}
          </Button>
        ))}
      </div>
      {hasFilters && (
        <Button type='button' variant='ghost' size='sm' onClick={onClearFilters}>
          {tr('expenses_clearFilters')}
        </Button>
      )}
    </div>
  );
}
