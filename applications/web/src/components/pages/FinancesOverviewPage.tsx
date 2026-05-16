import { Link } from '@tanstack/react-router';
import React from 'react';
import { PaymentStatusBadge } from '~/components/molecules/PaymentStatusBadge.js';
import { Button } from '~/components/ui/button.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MemberOverviewRow = {
  teamMemberId: string;
  memberName: string | null;
  currency: string;
  totalDueMinor: number;
  totalPaidMinor: number;
  overdueCount: number;
  pendingCount: number;
  paidCount: number;
};

interface FinancesOverviewPageProps {
  rows: ReadonlyArray<MemberOverviewRow>;
  /**
   * Optional teamId, used for the "Record payment" dialog trigger.
   * Not required in test scenarios.
   */
  teamId?: string;
  /**
   * When provided, renders a tab bar with "By member" and "By assignment" tabs.
   * The provided ReactNode is rendered when the "By assignment" tab is active.
   */
  assignmentsTabContent?: React.ReactNode;
  /**
   * When provided, the empty-state "Create a fee" button links to this href.
   */
  createFeeHref?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorstStatus = 'overdue' | 'partial' | 'pending' | 'paid' | 'waived';

function worstStatus(row: MemberOverviewRow): WorstStatus {
  if (row.overdueCount > 0) return 'overdue';
  const outstandingMinor = row.totalDueMinor - row.totalPaidMinor;
  if (outstandingMinor <= 0 && row.paidCount > 0) return 'paid';
  if (row.totalPaidMinor > 0) return 'partial';
  if (row.pendingCount > 0) return 'pending';
  if (row.paidCount > 0) return 'paid';
  return 'pending';
}

/**
 * For v1 KPIs we pick the most common currency across rows and only display
 * figures in that currency. Multi-currency teams will see a caveat in a future PR.
 *
 * TODO(finance-multi-currency): When we support multi-currency display, aggregate
 * KPI values should be shown per-currency or converted to a team base currency.
 */
function pickDominantCurrency(rows: ReadonlyArray<MemberOverviewRow>): string {
  if (rows.length === 0) return 'CZK';
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.currency, (counts.get(row.currency) ?? 0) + 1);
  }
  let best = rows[0].currency;
  let bestCount = 0;
  for (const [currency, count] of counts) {
    if (count > bestCount) {
      bestCount = count;
      best = currency;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// KPI Card
// ---------------------------------------------------------------------------

interface KpiCardProps {
  label: string;
  value: string;
  kpiKey: string;
}

function KpiCard({ label, value, kpiKey }: KpiCardProps) {
  return (
    <div className='rounded-lg border bg-card p-4'>
      <p className='text-sm text-muted-foreground'>{label}</p>
      <p className='mt-1 text-2xl font-bold' data-kpi={kpiKey}>
        {value}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Filter type
// ---------------------------------------------------------------------------

type FilterValue = 'all' | 'overdue' | 'pending' | 'paid' | 'waived';

const FILTERS: ReadonlyArray<{ value: FilterValue; labelKey: string }> = [
  { value: 'all', labelKey: 'finance_filter_all' },
  { value: 'overdue', labelKey: 'finance_filter_overdue' },
  { value: 'pending', labelKey: 'finance_filter_pending' },
  { value: 'paid', labelKey: 'finance_filter_paid' },
  { value: 'waived', labelKey: 'finance_filter_waived' },
];

// ---------------------------------------------------------------------------
// By-member content
// ---------------------------------------------------------------------------

function ByMemberContent({
  rows,
  createFeeHref,
}: {
  rows: ReadonlyArray<MemberOverviewRow>;
  createFeeHref?: string;
}) {
  const [search, setSearch] = React.useState('');
  const [filter, setFilter] = React.useState<FilterValue>('all');

  const currency = pickDominantCurrency(rows);
  const currencyRows = rows.filter((r) => r.currency === currency);
  const totalDueMinor = currencyRows.reduce((s, r) => s + r.totalDueMinor, 0);
  const totalPaidMinor = currencyRows.reduce((s, r) => s + r.totalPaidMinor, 0);
  const totalOutstandingMinor = totalDueMinor - totalPaidMinor;
  const overdueCount = currencyRows.filter((r) => r.overdueCount > 0).length;

  const filtered = rows.filter((row) => {
    const name = (row.memberName ?? '').toLowerCase();
    if (search && !name.includes(search.toLowerCase())) return false;
    if (filter === 'all') return true;
    const status = worstStatus(row);
    if (filter === 'overdue') return status === 'overdue';
    if (filter === 'pending') return status === 'pending' || status === 'partial';
    if (filter === 'paid') return status === 'paid';
    if (filter === 'waived') return status === 'waived';
    return true;
  });

  // Empty state: no rows at all
  if (rows.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-4 py-16 text-center'>
        <p className='text-xl font-semibold'>{tr('finance_overview_noFees')}</p>
        <p className='text-sm text-muted-foreground'>{tr('finance_empty_noFeesBody')}</p>
        {createFeeHref !== undefined ? (
          <Button asChild className='mt-2'>
            <Link to={createFeeHref}>{tr('finance_overview_createFee')}</Link>
          </Button>
        ) : (
          <Button className='mt-2' disabled>
            {tr('finance_overview_createFee')}
          </Button>
        )}
      </div>
    );
  }

  // Empty state: all paid
  const allPaid = rows.every((r) => worstStatus(r) === 'paid');
  if (allPaid && filter === 'all' && !search) {
    return (
      <div>
        <KPISection
          totalDueMinor={totalDueMinor}
          totalOutstandingMinor={totalOutstandingMinor}
          totalPaidMinor={totalPaidMinor}
          overdueCount={overdueCount}
          currency={currency}
        />
        <div className='mt-8 flex flex-col items-center justify-center gap-2 py-8 text-center text-green-600'>
          <p className='font-semibold'>{tr('finance_empty_allPaid')}</p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <KPISection
        totalDueMinor={totalDueMinor}
        totalOutstandingMinor={totalOutstandingMinor}
        totalPaidMinor={totalPaidMinor}
        overdueCount={overdueCount}
        currency={currency}
      />

      {/* Search + filter */}
      <div className='mt-6 flex flex-wrap items-center gap-3'>
        <input
          type='search'
          placeholder={tr('finance_searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-9 rounded-md border bg-background px-3 text-sm w-full sm:max-w-xs'
        />
        <div className='flex gap-1 flex-wrap'>
          {FILTERS.map((f) => (
            <button
              key={f.value}
              type='button'
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                filter === f.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {tr(f.labelKey)}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className='mt-4 overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b'>
              <th className='py-2 px-3 text-left text-xs font-medium text-muted-foreground'>
                {tr('finance_column_member')}
              </th>
              <th className='py-2 px-3 text-right text-xs font-medium text-muted-foreground'>
                {tr('finance_column_outstanding')}
              </th>
              <th className='py-2 px-3 text-right text-xs font-medium text-muted-foreground'>
                {tr('finance_column_paid')}
              </th>
              <th className='py-2 px-3 text-left text-xs font-medium text-muted-foreground'>
                {tr('finance_column_status')}
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const outstanding = row.totalDueMinor - row.totalPaidMinor;
              const status = worstStatus(row);
              return (
                <tr key={row.teamMemberId} className='border-b hover:bg-muted/50'>
                  <td className='py-3 px-3 font-medium'>{row.memberName ?? '—'}</td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(Math.max(0, outstanding), row.currency, 'en')}
                  </td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(row.totalPaidMinor, row.currency, 'en')}
                  </td>
                  <td className='py-3 px-3'>
                    <PaymentStatusBadge status={status} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function FinancesOverviewPage({
  rows,
  assignmentsTabContent,
  createFeeHref,
}: FinancesOverviewPageProps) {
  const [activeTab, setActiveTab] = React.useState<'by-member' | 'by-assignment'>('by-member');

  // When no tabs are requested, render the by-member content directly
  if (!assignmentsTabContent) {
    return <ByMemberContent rows={rows} createFeeHref={createFeeHref} />;
  }

  // Tab navigation
  return (
    <div>
      {/* Tab bar */}
      <div className='flex border-b mb-4' role='tablist'>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === 'by-member'}
          onClick={() => setActiveTab('by-member')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'by-member'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tr('finance_tab_byMember')}
        </button>
        <button
          type='button'
          role='tab'
          aria-selected={activeTab === 'by-assignment'}
          onClick={() => setActiveTab('by-assignment')}
          className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors ${
            activeTab === 'by-assignment'
              ? 'border-primary text-primary'
              : 'border-transparent text-muted-foreground hover:text-foreground'
          }`}
        >
          {tr('finance_tab_byAssignment')}
        </button>
      </div>

      {/* Tab content */}
      {activeTab === 'by-member' ? (
        <ByMemberContent rows={rows} createFeeHref={createFeeHref} />
      ) : (
        assignmentsTabContent
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// KPI Section sub-component
// ---------------------------------------------------------------------------

interface KPISectionProps {
  totalDueMinor: number;
  totalOutstandingMinor: number;
  totalPaidMinor: number;
  overdueCount: number;
  currency: string;
}

function KPISection({
  totalDueMinor,
  totalOutstandingMinor,
  totalPaidMinor,
  overdueCount,
  currency,
}: KPISectionProps) {
  return (
    <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
      <KpiCard
        label={tr('finance_overview_totalDue')}
        value={formatMoney(totalDueMinor, currency, 'en')}
        kpiKey='total-due'
      />
      <KpiCard
        label={tr('finance_kpi_outstanding')}
        value={formatMoney(Math.max(0, totalOutstandingMinor), currency, 'en')}
        kpiKey='outstanding'
      />
      <KpiCard
        label={tr('finance_overview_totalPaid')}
        value={formatMoney(totalPaidMinor, currency, 'en')}
        kpiKey='total-paid'
      />
      <KpiCard
        label={tr('finance_kpi_overdue')}
        value={String(overdueCount)}
        kpiKey='overdue-count'
      />
    </div>
  );
}
