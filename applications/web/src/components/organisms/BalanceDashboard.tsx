import type { Expense } from '@sideline/domain';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { pickDominantCurrency } from '~/lib/finance/pickDominantCurrency.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ExpenseCategory = Expense.ExpenseCategory;

type CategoryBreakdownItem = {
  readonly category: ExpenseCategory;
  readonly amountMinor: number;
};

export type BalanceSummary = {
  readonly currency: string;
  readonly incomeMinor: number;
  readonly expensesMinor: number;
  readonly netMinor: number;
  readonly byCategory: ReadonlyArray<CategoryBreakdownItem>;
};

interface BalanceDashboardProps {
  summaries: ReadonlyArray<BalanceSummary>;
}

// ---------------------------------------------------------------------------
// Category colors for the stacked bar (matching ExpenseCategoryBadge palette)
// ---------------------------------------------------------------------------

const CATEGORY_BAR_COLORS: Record<ExpenseCategory, string> = {
  fields: 'bg-emerald-500',
  equipment: 'bg-sky-500',
  travel: 'bg-violet-500',
  tournaments: 'bg-amber-500',
  other: 'bg-slate-500',
};

// ---------------------------------------------------------------------------
// KPI card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  testId: string;
  netSign?: 'positive' | 'negative' | 'zero';
}

function KpiCard({ label, value, testId, netSign }: KpiCardProps) {
  const valueColor =
    netSign === 'positive'
      ? 'text-green-600 dark:text-green-400'
      : netSign === 'negative'
        ? 'text-red-600 dark:text-red-400'
        : undefined;

  return (
    <div className='rounded-lg border bg-card p-4' data-testid={testId}>
      <p className='text-sm text-muted-foreground'>{label}</p>
      <p
        className={`mt-1 text-2xl font-bold ${valueColor ?? ''}`}
        data-net-sign={netSign}
        data-variant={netSign}
      >
        {netSign === 'positive' && <ArrowUp className='mr-0.5 inline size-4' aria-hidden='true' />}
        {netSign === 'negative' && (
          <ArrowDown className='mr-0.5 inline size-4' aria-hidden='true' />
        )}
        {netSign === 'zero' && <Minus className='mr-0.5 inline size-4' aria-hidden='true' />}
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function BalanceDashboard({ summaries }: BalanceDashboardProps) {
  if (summaries.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-4 py-16 text-center'>
        <p className='text-muted-foreground'>{tr('balance_dashboard_empty')}</p>
      </div>
    );
  }

  const dominant = pickDominantCurrency(summaries) ?? summaries[0].currency;
  const dominantSummary = summaries.find((s) => s.currency === dominant) ?? summaries[0];
  const { incomeMinor, expensesMinor, netMinor, byCategory } = dominantSummary;
  const otherCount = summaries.length - 1;

  const netSign: 'positive' | 'negative' | 'zero' =
    netMinor > 0 ? 'positive' : netMinor < 0 ? 'negative' : 'zero';

  const absNetFormatted = formatMoney(Math.abs(netMinor), dominant, 'en');
  const netFormatted =
    netSign === 'positive'
      ? `+${absNetFormatted}`
      : netSign === 'negative'
        ? `-${absNetFormatted}`
        : absNetFormatted;

  // byCategory is already sorted by amount descending (server guarantees this)
  const hasBreakdown = byCategory.length > 0;

  return (
    <div className='flex flex-col gap-6'>
      {/* Multi-currency banner */}
      {otherCount > 0 && (
        <div className='rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-300'>
          {tr('balance_dashboard_multi_currency_banner')}
        </div>
      )}

      {/* KPI cards */}
      <div className='grid grid-cols-1 gap-3 sm:grid-cols-3'>
        <KpiCard
          label={tr('balance_dashboard_income')}
          value={formatMoney(incomeMinor, dominant, 'en')}
          testId='income-card'
        />
        <KpiCard
          label={tr('balance_dashboard_expenses')}
          value={formatMoney(expensesMinor, dominant, 'en')}
          testId='expenses-card'
        />
        <KpiCard
          label={tr('balance_dashboard_net')}
          value={netFormatted}
          testId='net-card'
          netSign={netSign}
        />
      </div>

      {/* Stacked bar breakdown by category */}
      {hasBreakdown ? (
        <div>
          <p className='mb-2 text-sm font-medium'>{tr('finance_breakdown_title')}</p>
          {/* Visual stacked bar — aria-hidden, screen readers use the table below */}
          <div className='flex h-6 w-full overflow-hidden rounded-full' aria-hidden='true'>
            {byCategory.map((item) => {
              const pct = expensesMinor > 0 ? (item.amountMinor / expensesMinor) * 100 : 0;
              return (
                <div
                  key={item.category}
                  className={`h-full ${CATEGORY_BAR_COLORS[item.category]}`}
                  style={{ width: `${pct}%` }}
                />
              );
            })}
          </div>

          {/* Screen-reader accessible table */}
          <table className='sr-only'>
            <caption>{tr('finance_breakdown_title')}</caption>
            <thead>
              <tr>
                <th scope='col'>{tr('finance_breakdown_categoryColumn')}</th>
                <th scope='col'>{tr('finance_breakdown_amountColumn')}</th>
                <th scope='col'>{tr('finance_breakdown_shareColumn')}</th>
              </tr>
            </thead>
            <tbody>
              {byCategory.map((item) => {
                const pct = expensesMinor > 0 ? (item.amountMinor / expensesMinor) * 100 : 0;
                return (
                  <tr key={item.category}>
                    <td>{tr(`expense_category_${item.category}`)}</td>
                    <td>{formatMoney(item.amountMinor, dominant, 'en')}</td>
                    <td>{Math.round(pct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div>
          <table className='sr-only'>
            <caption>{tr('finance_breakdown_title')}</caption>
            <thead>
              <tr>
                <th scope='col'>{tr('finance_breakdown_categoryColumn')}</th>
                <th scope='col'>{tr('finance_breakdown_amountColumn')}</th>
                <th scope='col'>{tr('finance_breakdown_shareColumn')}</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td colSpan={3}>{tr('finance_breakdown_empty')}</td>
              </tr>
            </tbody>
          </table>
          <p className='text-sm text-muted-foreground'>{tr('finance_breakdown_empty')}</p>
        </div>
      )}
    </div>
  );
}
