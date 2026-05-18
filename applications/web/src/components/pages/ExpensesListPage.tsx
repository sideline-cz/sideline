import type { ExpenseApi } from '@sideline/domain';
import { ExpenseCategoryBadge } from '~/components/molecules/ExpenseCategoryBadge.js';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { formatLocalDate } from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

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

const CATEGORIES: ReadonlyArray<{ value: string; labelKey: string }> = [
  { value: 'fields', labelKey: 'expense_category_fields' },
  { value: 'equipment', labelKey: 'expense_category_equipment' },
  { value: 'travel', labelKey: 'expense_category_travel' },
  { value: 'tournaments', labelKey: 'expense_category_tournaments' },
  { value: 'other', labelKey: 'expense_category_other' },
];

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
  const hasFilters = fromFilter !== '' || toFilter !== '' || categoryFilter.length > 0;

  const toggleCategory = (value: string) => {
    if (categoryFilter.includes(value)) {
      onCategoryFilterChange(categoryFilter.filter((c) => c !== value));
    } else {
      onCategoryFilterChange([...categoryFilter, value]);
    }
  };

  const header = <PageHeader canManageExpenses={canManageExpenses} onCreate={onCreateExpense} />;

  // Empty state: no expenses ever
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

  // Empty state: filters applied but no results
  if (expenses.length === 0 && hasFilters) {
    return (
      <div className='flex flex-col gap-4'>
        {header}
        <FilterBar
          fromFilter={fromFilter}
          toFilter={toFilter}
          categoryFilter={categoryFilter}
          onFromFilterChange={onFromFilterChange}
          onToFilterChange={onToFilterChange}
          onToggleCategory={toggleCategory}
          onClearFilters={onClearFilters}
          hasFilters={hasFilters}
        />
        <div className='flex flex-col items-center justify-center gap-4 py-16 text-center'>
          <p className='text-muted-foreground'>{tr('expenses_empty_noResults')}</p>
          <Button type='button' variant='outline' onClick={onClearFilters}>
            {tr('expenses_clearFilters')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-4'>
      {header}

      {/* Filter bar */}
      <FilterBar
        fromFilter={fromFilter}
        toFilter={toFilter}
        categoryFilter={categoryFilter}
        onFromFilterChange={onFromFilterChange}
        onToFilterChange={onToFilterChange}
        onToggleCategory={toggleCategory}
        onClearFilters={onClearFilters}
        hasFilters={hasFilters}
      />

      {/* Table */}
      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b'>
              <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_date')}</th>
              <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_category')}</th>
              <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_description')}</th>
              <th className='py-2 px-3 text-right font-medium'>{tr('expenses_col_amount')}</th>
              {canManageExpenses && (
                <th className='py-2 px-3 text-left font-medium'>{tr('expenses_col_actions')}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {expenses.map((expense) => (
              <tr key={expense.expenseId} className='border-b hover:bg-muted/50'>
                <td className='py-3 px-3 text-muted-foreground'>
                  {formatLocalDate(expense.spentAt)}
                </td>
                <td className='py-3 px-3'>
                  <ExpenseCategoryBadge category={expense.category} />
                </td>
                <td className='py-3 px-3 max-w-xs truncate'>{expense.description || '—'}</td>
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
        {CATEGORIES.map((c) => (
          <Button
            key={c.value}
            type='button'
            size='sm'
            variant={categoryFilter.includes(c.value) ? 'secondary' : 'outline'}
            aria-pressed={categoryFilter.includes(c.value)}
            onClick={() => onToggleCategory(c.value)}
          >
            {tr(c.labelKey)}
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
