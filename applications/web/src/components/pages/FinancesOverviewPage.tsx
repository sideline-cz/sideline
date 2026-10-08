import type { ExpenseApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import React from 'react';
import {
  ListToolbar,
  listHeaderClass,
  listScrollClass,
} from '~/components/molecules/ListToolbar.js';
import { PaymentStatusBadge } from '~/components/molecules/PaymentStatusBadge.js';
import { BalanceDashboard } from '~/components/organisms/BalanceDashboard.js';
import { MemberCreditPopover } from '~/components/organisms/MemberCreditPopover.js';
import { Button } from '~/components/ui/button.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';
import { useListFilter } from '~/lib/useListFilter.js';

const overviewTabSeenKey = (userId: string) => `sideline:finances-overview-tab-seen:${userId}`;

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
  /** Outstanding and not overdue — includes the partially paid. */
  pendingCount: number;
  /** Subset of pendingCount: assignments paid in part. */
  partialCount: number;
  paidCount: number;
  // This row's currency, 0 when the member holds no credit in it.
  creditMinor: number;
};

interface FinancesOverviewPageProps {
  rows: ReadonlyArray<MemberOverviewRow>;
  /**
   * Optional teamId, used for the "Record payment" dialog trigger and the credit popover.
   * Not required in test scenarios.
   */
  teamId?: string;
  /**
   * The authenticated user's id, used to scope the "New" badge localStorage key.
   * When omitted the badge is hidden (treated as already-seen — safe default for test scenarios).
   */
  userId?: string;
  /**
   * When provided, renders a tab bar with "By member" and "By assignment" tabs.
   * The provided ReactNode is rendered when the "By assignment" tab is active.
   */
  assignmentsTabContent?: React.ReactNode;
  /**
   * When provided, the empty-state "Create a fee" button links to this href.
   */
  createFeeHref?: string;
  /**
   * Balance summaries for the Overview tab. When provided, the Overview tab is shown.
   */
  balanceSummaries?: ReadonlyArray<ExpenseApi.BalanceSummary>;
  /** The window the Overview figures ACTUALLY cover, as reported by the server. */
  balanceWindow?: 'all' | 'season';
  /** Pre-formatted season start for the Overview heading, e.g. 'Since 1 Sep 2026'. */
  balanceWindowStartLabel?: string;
  /** User picked a different window. Omitted → the window control is not rendered. */
  onBalanceWindowChange?: (window: 'all' | 'season') => void;
  /**
   * Controlled active tab value. When provided together with onTabChange,
   * the component operates in controlled mode (URL-synced).
   */
  activeTab?: ActiveTab;
  /** Called when the user selects a different tab in controlled mode. */
  onTabChange?: (tab: ActiveTab) => void;
  /**
   * Gates the Actions column (settle-all / add-credit) and the void button inside the credit
   * popover. Omitted/false in test scenarios that don't exercise the treasurer actions.
   */
  canRecordPayments?: boolean;
  /** Row's "Settle all" / "Add credit" button was clicked — parent owns the dialog. */
  onSettleRow?: (row: MemberOverviewRow) => void;
  /** A credit deposit was voided from a row's popover — parent should refetch the overview. */
  onCreditVoided?: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type WorstStatus = 'overdue' | 'partial' | 'pending' | 'paid' | 'waived';

function worstStatus(row: MemberOverviewRow): WorstStatus {
  // [R3] A credit-only row (a member who paid in advance and has never had a fee assigned)
  // has zero counts and zero totals — the fall-through below would otherwise read that as
  // 'pending' and put a member who owes NOTHING under a Pending badge and the Pending filter.
  if (row.overdueCount + row.pendingCount + row.paidCount === 0) return 'paid';
  if (row.overdueCount > 0) return 'overdue';
  const outstandingMinor = row.totalDueMinor - row.totalPaidMinor;
  if (outstandingMinor <= 0 && row.paidCount > 0) return 'paid';
  // Partial means a single fee is half-settled — not "some fees paid, some not". Reading
  // totalPaidMinor here badged a member with one fee cleared and the next untouched as partial.
  if (row.partialCount > 0) return 'partial';
  if (row.pendingCount > 0) return 'pending';
  if (row.paidCount > 0) return 'paid';
  return 'pending';
}

/**
 * For v1 KPIs we pick the most common currency across rows (by row count) and only
 * display figures in that currency. See BalanceDashboard for the balance view which
 * handles multi-currency display by picking the dominant currency by payment volume.
 */
function pickMostFrequentCurrency(rows: ReadonlyArray<MemberOverviewRow>): string {
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

// Same five filters and the same semantics as before `ListToolbar` existed — the if-chain that
// used to live inside `ByMemberContent` is now a `predicate` per entry. Note `pending` still
// deliberately covers 'partial' too.
const FILTERS = [
  { value: 'all', labelKey: 'finance_filter_all', predicate: () => true },
  {
    value: 'overdue',
    labelKey: 'finance_filter_overdue',
    predicate: (r: MemberOverviewRow) => worstStatus(r) === 'overdue',
  },
  {
    value: 'pending',
    labelKey: 'finance_filter_pending',
    predicate: (r: MemberOverviewRow) =>
      worstStatus(r) === 'pending' || worstStatus(r) === 'partial',
  },
  {
    value: 'paid',
    labelKey: 'finance_filter_paid',
    predicate: (r: MemberOverviewRow) => worstStatus(r) === 'paid',
  },
  {
    value: 'waived',
    labelKey: 'finance_filter_waived',
    predicate: (r: MemberOverviewRow) => worstStatus(r) === 'waived',
  },
] as const satisfies ReadonlyArray<{ value: FilterValue; labelKey: string; predicate: unknown }>;

const memberRowSearchFields = (r: MemberOverviewRow) => [r.memberName ?? ''];

// ---------------------------------------------------------------------------
// By-member content
// ---------------------------------------------------------------------------

function ByMemberContent({
  rows,
  createFeeHref,
  teamId,
  canRecordPayments,
  onSettleRow,
  onCreditVoided,
}: {
  rows: ReadonlyArray<MemberOverviewRow>;
  createFeeHref?: string;
  teamId?: string;
  canRecordPayments?: boolean;
  onSettleRow?: (row: MemberOverviewRow) => void;
  onCreditVoided?: () => void;
}) {
  const { search, setSearch, filter, setFilter, filtered } = useListFilter(rows, {
    searchOf: memberRowSearchFields,
    filters: FILTERS,
  });

  // [R2] A credit-only row (no assignments, balance > 0) must not get a vote in the currency
  // pick — pickMostFrequentCurrency votes by row COUNT, so one member's EUR credit can flip a
  // CZK team's KPI cards to "Total due €0.00". Fall back to all rows only when every row is
  // credit-only (nothing else to vote with).
  const kpiRows = rows.filter((r) => r.overdueCount + r.pendingCount + r.paidCount > 0);
  const currency = pickMostFrequentCurrency(kpiRows.length > 0 ? kpiRows : rows);
  const currencyRows = rows.filter((r) => r.currency === currency);
  const totalDueMinor = currencyRows.reduce((s, r) => s + r.totalDueMinor, 0);
  const totalPaidMinor = currencyRows.reduce((s, r) => s + r.totalPaidMinor, 0);
  const totalOutstandingMinor = totalDueMinor - totalPaidMinor;
  const overdueCount = currencyRows.filter((r) => r.overdueCount > 0).length;

  // Empty state: no rows at all. Deliberately keyed off `rows`, not `kpiRows` — `kpiRows`
  // excludes every row with zero overdue/pending/paid counts (credit-only AND all-waived
  // members alike), so a team whose fees are ALL waived would otherwise have `kpiRows === []`
  // and see "you have no fees yet" instead of its (all-waived) member list.
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
      <ListToolbar
        className='mt-6'
        search={search}
        onSearchChange={setSearch}
        searchPlaceholderKey='finance_searchPlaceholder'
        filters={FILTERS}
        filter={filter}
        onFilterChange={setFilter}
      />

      {/* Table */}
      <div className={`mt-4 ${listScrollClass}`}>
        <table className='w-full text-sm'>
          <thead className={listHeaderClass}>
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
              {canRecordPayments && (
                <th className='py-2 px-3 text-left text-xs font-medium text-muted-foreground'>
                  {/* Reuses the sibling "By assignment" tab's Actions column key — same
                      table, same meaning, no need for a finance-overview-specific duplicate. */}
                  {tr('assignments_tab_colActions')}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {filtered.map((row) => {
              const outstanding = row.totalDueMinor - row.totalPaidMinor;
              const status = worstStatus(row);
              const memberLabel = row.memberName ?? '—';
              return (
                <tr
                  key={`${row.teamMemberId}-${row.currency}`}
                  className='border-b hover:bg-muted/50'
                >
                  <td className='py-3 px-3 font-medium'>
                    {memberLabel}
                    <span className='ml-1.5 text-xs font-normal text-muted-foreground'>
                      {row.currency}
                    </span>
                  </td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    <div>{formatMoney(Math.max(0, outstanding), row.currency, 'en')}</div>
                    {row.creditMinor > 0 && teamId !== undefined && (
                      <MemberCreditPopover
                        teamId={teamId}
                        teamMemberId={row.teamMemberId}
                        memberName={row.memberName ?? undefined}
                        currency={row.currency}
                        balanceMinor={row.creditMinor}
                        canRecordPayments={canRecordPayments ?? false}
                        onVoided={onCreditVoided}
                      />
                    )}
                  </td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(row.totalPaidMinor, row.currency, 'en')}
                  </td>
                  <td className='py-3 px-3'>
                    <PaymentStatusBadge status={status} />
                  </td>
                  {canRecordPayments && (
                    <td className='py-3 px-3'>
                      <Button
                        type='button'
                        variant='outline'
                        size='sm'
                        aria-label={tr(
                          outstanding > 0
                            ? 'finance_settle_rowAria'
                            : 'finance_settle_rowAriaAddCredit',
                          { member: memberLabel, currency: row.currency },
                        )}
                        onClick={() => onSettleRow?.(row)}
                      >
                        {tr(
                          outstanding > 0
                            ? 'finance_settle_action'
                            : 'finance_settle_actionAddCredit',
                        )}
                      </Button>
                    </td>
                  )}
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

type ActiveTab = 'overview' | 'by-member' | 'by-assignment';

export function FinancesOverviewPage({
  rows,
  teamId,
  userId,
  assignmentsTabContent,
  createFeeHref,
  balanceSummaries,
  balanceWindow,
  balanceWindowStartLabel,
  onBalanceWindowChange,
  activeTab: controlledActiveTab,
  onTabChange,
  canRecordPayments,
  onSettleRow,
  onCreditVoided,
}: FinancesOverviewPageProps) {
  const hasOverviewTab = balanceSummaries !== undefined;
  const defaultTab: ActiveTab = hasOverviewTab ? 'overview' : 'by-member';
  const [internalActiveTab, setInternalActiveTab] = React.useState<ActiveTab>(defaultTab);

  // Support both controlled (URL-synced) and uncontrolled mode.
  const isControlled = controlledActiveTab !== undefined && onTabChange !== undefined;
  const activeTab = isControlled ? controlledActiveTab : internalActiveTab;

  const [overviewTabSeen, setOverviewTabSeen] = React.useState(() => {
    if (!userId) return true;
    try {
      return localStorage.getItem(overviewTabSeenKey(userId)) === 'true';
    } catch {
      return true;
    }
  });

  const handleTabChange = (tab: ActiveTab) => {
    if (isControlled) {
      onTabChange(tab);
    } else {
      setInternalActiveTab(tab);
    }
    if (tab === 'overview' && !overviewTabSeen) {
      setOverviewTabSeen(true);
      if (userId) {
        try {
          localStorage.setItem(overviewTabSeenKey(userId), 'true');
        } catch {
          // ignore
        }
      }
    }
  };

  // When no tabs are requested and no overview, render the by-member content directly
  if (!assignmentsTabContent && !hasOverviewTab) {
    return (
      <div>
        <h1 className='text-2xl font-bold mb-4'>{tr('finance_overview_title')}</h1>
        <ByMemberContent
          rows={rows}
          createFeeHref={createFeeHref}
          teamId={teamId}
          canRecordPayments={canRecordPayments}
          onSettleRow={onSettleRow}
          onCreditVoided={onCreditVoided}
        />
      </div>
    );
  }

  // Tab navigation
  return (
    <div>
      <h1 className='text-2xl font-bold mb-4'>{tr('finance_overview_title')}</h1>
      {/* Tab bar */}
      {/* overflow-x-auto: 3 tabs (Overview + its "New" badge, By member, By assignment) don't
          all fit a 360px viewport — scroll the strip itself rather than the document. */}
      <div className='flex overflow-x-auto border-b mb-4' role='tablist'>
        {hasOverviewTab && (
          <Button
            type='button'
            role='tab'
            variant={activeTab === 'overview' ? 'secondary' : 'ghost'}
            aria-selected={activeTab === 'overview'}
            onClick={() => handleTabChange('overview')}
            className={`rounded-none border-b-2 -mb-px transition-colors flex items-center gap-1.5 ${
              activeTab === 'overview' ? 'border-primary' : 'border-transparent'
            }`}
          >
            {tr('finance_overview_tab')}
            {!overviewTabSeen && (
              <span className='rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-semibold text-primary-foreground'>
                {tr('finance_overview_tab_new_badge')}
              </span>
            )}
          </Button>
        )}
        <Button
          type='button'
          role='tab'
          variant={activeTab === 'by-member' ? 'secondary' : 'ghost'}
          aria-selected={activeTab === 'by-member'}
          onClick={() => handleTabChange('by-member')}
          className={`rounded-none border-b-2 -mb-px transition-colors ${
            activeTab === 'by-member' ? 'border-primary' : 'border-transparent'
          }`}
        >
          {tr('finance_tab_byMember')}
        </Button>
        {assignmentsTabContent && (
          <Button
            type='button'
            role='tab'
            variant={activeTab === 'by-assignment' ? 'secondary' : 'ghost'}
            aria-selected={activeTab === 'by-assignment'}
            onClick={() => handleTabChange('by-assignment')}
            className={`rounded-none border-b-2 -mb-px transition-colors ${
              activeTab === 'by-assignment' ? 'border-primary' : 'border-transparent'
            }`}
          >
            {tr('finance_tab_byAssignment')}
          </Button>
        )}
      </div>

      {/* Tab content */}
      {activeTab === 'overview' && hasOverviewTab ? (
        <div className='flex flex-col gap-4'>
          {/* Deliberately OUTSIDE BalanceDashboard: it early-returns an empty state when a
              window has no activity, and a control rendered inside it would disappear exactly
              when the user needs it to get back. */}
          {onBalanceWindowChange !== undefined && (
            <fieldset className='flex gap-1 border-0 p-0 m-0'>
              <legend className='sr-only'>{tr('finance_window_label')}</legend>
              {(['all', 'season'] as const).map((value) => (
                <Button
                  key={value}
                  type='button'
                  size='sm'
                  variant={(balanceWindow ?? 'all') === value ? 'secondary' : 'ghost'}
                  aria-pressed={(balanceWindow ?? 'all') === value}
                  onClick={() => onBalanceWindowChange(value)}
                >
                  {tr(value === 'all' ? 'finance_window_allTime' : 'finance_window_season')}
                </Button>
              ))}
            </fieldset>
          )}
          <BalanceDashboard
            summaries={balanceSummaries ?? []}
            rows={rows}
            window={balanceWindow}
            windowStartLabel={balanceWindowStartLabel}
          />
        </div>
      ) : activeTab === 'by-member' ? (
        <ByMemberContent
          rows={rows}
          createFeeHref={createFeeHref}
          teamId={teamId}
          canRecordPayments={canRecordPayments}
          onSettleRow={onSettleRow}
          onCreditVoided={onCreditVoided}
        />
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
