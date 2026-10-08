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

type MonthlyItem = {
  /** Team-local month key, 'YYYY-MM-01'. Never parsed as an instant — see ExpenseApi.MonthKey. */
  readonly month: string;
  readonly incomeMinor: number;
  readonly expensesMinor: number;
};

export type BalanceSummary = {
  readonly currency: string;
  readonly incomeMinor: number;
  readonly expensesMinor: number;
  readonly netMinor: number;
  readonly byCategory: ReadonlyArray<CategoryBreakdownItem>;
  readonly byMonth: ReadonlyArray<MonthlyItem>;
};

/**
 * The three fields of a member overview row the collection ratio needs. Declared structurally here
 * rather than importing `MemberOverviewRow` from the page — an organism importing from a page is
 * backwards, and `pickDominantCurrency` already sets this precedent with its local `VolumeRow`.
 */
type CollectionRow = {
  readonly currency: string;
  readonly totalDueMinor: number;
  readonly totalPaidMinor: number;
};

interface BalanceDashboardProps {
  summaries: ReadonlyArray<BalanceSummary>;
  /**
   * Member rows for the collection ratio. Filtered HERE by the dashboard's own dominant currency,
   * never pre-filtered by the caller: the by-member tab picks its currency by row COUNT while this
   * component picks by transaction VOLUME, and the two disagree. Omitted → no ratio is shown.
   */
  rows?: ReadonlyArray<CollectionRow>;
  /** The window the figures ACTUALLY cover, as reported by the server — not the one requested. */
  window?: 'all' | 'season';
  /** Pre-formatted season start, e.g. 'Since 1 Sep 2026'. The caller owns date formatting. */
  windowStartLabel?: string;
}

/**
 * Expand a sparse month series into a contiguous one. The server only emits months that had
 * activity, so a quiet February arrives as a hole; rendered unfilled it would put January next to
 * March and read as two consecutive months.
 */
function fillMonthGaps(items: ReadonlyArray<MonthlyItem>): ReadonlyArray<MonthlyItem> {
  if (items.length < 2) return items;
  const byKey = new Map(items.map((i) => [i.month, i]));
  const out: MonthlyItem[] = [];
  // Parsed as plain integers, never as a Date: 'YYYY-MM-01' is a team-local key, and running it
  // through Date would re-resolve it in the browser's zone.
  const [firstYear, firstMonth] = items[0].month.split('-').map(Number);
  const [lastYear, lastMonth] = items[items.length - 1].month.split('-').map(Number);
  for (let m = firstYear * 12 + (firstMonth - 1); m <= lastYear * 12 + (lastMonth - 1); m++) {
    const key = `${String(Math.floor(m / 12)).padStart(4, '0')}-${String((m % 12) + 1).padStart(2, '0')}-01`;
    out.push(byKey.get(key) ?? { month: key, incomeMinor: 0, expensesMinor: 0 });
  }
  return out;
}

/** 'YYYY-MM-01' → a short month label, without constructing a Date from the key. */
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const monthLabel = (key: string) => MONTH_LABELS[Number(key.slice(5, 7)) - 1] ?? key;

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

export function BalanceDashboard({
  summaries,
  rows,
  window,
  windowStartLabel,
}: BalanceDashboardProps) {
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

  // Rows are filtered by THIS component's currency pick, not the caller's — see `rows` on the
  // props. An overpaid team must not render a negative "still owed" or a bar past 100%.
  const currencyRows = (rows ?? []).filter((r) => r.currency === dominant);
  const dueMinor = currencyRows.reduce((sum, r) => sum + r.totalDueMinor, 0);
  const paidMinor = currencyRows.reduce((sum, r) => sum + r.totalPaidMinor, 0);
  const collectedPct = dueMinor > 0 ? Math.min(100, Math.round((paidMinor / dueMinor) * 100)) : 0;
  const outstandingMinor = Math.max(0, dueMinor - paidMinor);

  const months = fillMonthGaps(dominantSummary.byMonth);
  // One scale for both series so the bars are comparable to each other, not just within a month.
  const monthPeak = months.reduce((peak, m) => Math.max(peak, m.incomeMinor, m.expensesMinor), 0);
  const windowLabel =
    window === 'season'
      ? (windowStartLabel ?? tr('balance_dashboard_window_season'))
      : window === 'all'
        ? tr('balance_dashboard_window_all')
        : null;

  return (
    <div className='flex flex-col gap-6'>
      {windowLabel !== null && (
        <p className='text-sm text-muted-foreground' data-testid='window-label'>
          {windowLabel}
        </p>
      )}

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

      {/* Collection ratio — how much of what was billed has actually arrived. */}
      {dueMinor > 0 && (
        <div data-testid='collection-ratio'>
          <div className='mb-2 flex items-baseline justify-between gap-2 text-sm'>
            <span className='font-medium'>{tr('balance_dashboard_collected')}</span>
            <span className='tabular-nums font-semibold'>{collectedPct}%</span>
          </div>
          <div
            className='h-2 w-full overflow-hidden rounded-full bg-muted'
            role='progressbar'
            aria-valuenow={collectedPct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={tr('balance_dashboard_collected')}
          >
            <div className='h-full bg-green-600' style={{ width: `${collectedPct}%` }} />
          </div>
          <p className='mt-1 text-sm text-muted-foreground tabular-nums'>
            {formatMoney(outstandingMinor, dominant, 'en')} {tr('balance_dashboard_stillOwed')}
          </p>
        </div>
      )}

      {/* Income and spending by month */}
      {months.length > 0 && (
        <div>
          <p className='mb-2 text-sm font-medium'>{tr('balance_dashboard_trend_title')}</p>
          {/* Visual only — the sr-only table below carries the same figures. */}
          <div className='flex items-end gap-2 overflow-x-auto' aria-hidden='true'>
            {months.map((m) => (
              <div
                key={m.month}
                data-testid='trend-month'
                data-month={m.month}
                className='flex min-w-8 flex-1 flex-col items-center gap-1'
              >
                <div className='flex h-24 w-full items-end justify-center gap-0.5'>
                  {/* monthPeak is 0 only when every month is empty, and then both bars are 0% */}
                  <div
                    className='w-1/2 rounded-t-sm bg-green-600'
                    style={{
                      height: `${monthPeak > 0 ? (m.incomeMinor / monthPeak) * 100 : 0}%`,
                    }}
                  />
                  <div
                    className='w-1/2 rounded-t-sm bg-red-500'
                    style={{
                      height: `${monthPeak > 0 ? (m.expensesMinor / monthPeak) * 100 : 0}%`,
                    }}
                  />
                </div>
                <span className='text-[10px] text-muted-foreground'>{monthLabel(m.month)}</span>
              </div>
            ))}
          </div>
          <div className='mt-2 flex gap-4 text-xs text-muted-foreground'>
            <span className='flex items-center gap-1.5'>
              <span className='size-2 rounded-full bg-green-600' aria-hidden='true' />
              {tr('balance_dashboard_trend_income')}
            </span>
            <span className='flex items-center gap-1.5'>
              <span className='size-2 rounded-full bg-red-500' aria-hidden='true' />
              {tr('balance_dashboard_trend_expenses')}
            </span>
          </div>

          <table className='sr-only'>
            <caption>{tr('balance_dashboard_trend_title')}</caption>
            <thead>
              <tr>
                <th scope='col'>{tr('balance_dashboard_trend_monthColumn')}</th>
                <th scope='col'>{tr('balance_dashboard_trend_income')}</th>
                <th scope='col'>{tr('balance_dashboard_trend_expenses')}</th>
              </tr>
            </thead>
            <tbody>
              {months.map((m) => (
                <tr key={m.month}>
                  <td>{m.month}</td>
                  <td>{formatMoney(m.incomeMinor, dominant, 'en')}</td>
                  <td>{formatMoney(m.expensesMinor, dominant, 'en')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

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

          {/* The same figures the sr-only table carries, made visible — without these the bar is
              an unlabelled strip of colour to everyone who can see it. */}
          <ul className='mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs' data-testid='category-legend'>
            {byCategory.map((item) => {
              const pct = expensesMinor > 0 ? (item.amountMinor / expensesMinor) * 100 : 0;
              return (
                <li key={item.category} className='flex items-center gap-1.5'>
                  <span
                    className={`size-2 rounded-full ${CATEGORY_BAR_COLORS[item.category]}`}
                    aria-hidden='true'
                  />
                  <span>{tr(`expense_category_${item.category}`)}</span>
                  <span className='tabular-nums text-muted-foreground'>
                    {formatMoney(item.amountMinor, dominant, 'en')} · {Math.round(pct)}%
                  </span>
                </li>
              );
            })}
          </ul>

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
