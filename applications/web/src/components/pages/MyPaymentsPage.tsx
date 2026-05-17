import { type DateTime, Option } from 'effect';
import { ChevronRight } from 'lucide-react';
import React from 'react';
import { PaymentStatusBadge } from '~/components/molecules/PaymentStatusBadge.js';
import { MyPaymentHistoryRow } from '~/components/organisms/MyPaymentHistoryRow.js';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { formatLocalDate } from '~/lib/datetime';
import { computeKpis } from '~/lib/finance/computeKpis.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { sortAssignments } from '~/lib/finance/sortAssignments.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeeAssignmentStatus = 'pending' | 'partial' | 'overdue' | 'paid' | 'waived';

type FeeAssignmentView = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: FeeAssignmentStatus;
  effectiveDueAt: Option.Option<DateTime.Utc>;
  waivedReason: Option.Option<string>;
};

type MyFinanceStatus = {
  currency: string;
  assignments: ReadonlyArray<FeeAssignmentView>;
  totalOutstandingMinor: number;
};

type FilterValue = 'all' | 'outstanding' | 'paid' | 'waived';

interface MyPaymentsPageProps {
  teamId: string;
  myStatus: ReadonlyArray<MyFinanceStatus>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOutstandingStatus(status: FeeAssignmentStatus): boolean {
  return status === 'pending' || status === 'partial' || status === 'overdue';
}

function matchesFilter(assignment: FeeAssignmentView, filter: FilterValue): boolean {
  if (filter === 'all') return true;
  if (filter === 'outstanding') return isOutstandingStatus(assignment.status);
  if (filter === 'paid') return assignment.status === 'paid';
  if (filter === 'waived') return assignment.status === 'waived';
  return true;
}

// ---------------------------------------------------------------------------
// KPI Cards
// ---------------------------------------------------------------------------

function KpiCard({
  label,
  value,
  showLabel = true,
}: {
  label: string;
  value: string;
  showLabel?: boolean;
}) {
  return (
    <Card className='py-4 gap-2' aria-label={label}>
      <CardContent className='px-4'>
        {showLabel && <p className='text-xs text-muted-foreground mb-1'>{label}</p>}
        <p className='text-xl font-bold tracking-tight'>{value}</p>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Filter chips
// ---------------------------------------------------------------------------

const FILTER_CHIPS: ReadonlyArray<{ value: FilterValue; labelKey: string }> = [
  { value: 'all', labelKey: 'my_payments_filter_all' },
  { value: 'outstanding', labelKey: 'my_payments_filter_outstanding' },
  { value: 'paid', labelKey: 'my_payments_filter_paid' },
  { value: 'waived', labelKey: 'my_payments_filter_waived' },
];

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function MyPaymentsPage({ teamId, myStatus }: MyPaymentsPageProps) {
  const kpis = computeKpis(myStatus);
  const hasOutstanding = myStatus.some((g) =>
    g.assignments.some((a) => isOutstandingStatus(a.status)),
  );

  const [filter, setFilter] = React.useState<FilterValue>(() =>
    hasOutstanding ? 'outstanding' : 'all',
  );

  // Per-row expanded state: assignmentId → boolean
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  const toggleExpanded = (assignmentId: string) => {
    setExpanded((prev) => ({ ...prev, [assignmentId]: !prev[assignmentId] }));
  };

  // KPI values
  const none = tr('my_payments_kpi_none');

  const outstandingValue =
    kpis.outstandingTotal.length === 0
      ? none
      : kpis.outstandingTotal
          .slice(0, 1)
          .map((e) => formatMoney(e.amountMinor, e.currency, 'en'))
          .join('') +
        (kpis.outstandingTotal.length > 1
          ? ` ${tr('my_payments_kpi_multiCurrencyMore').replace('{n}', String(kpis.outstandingTotal.length - 1))}`
          : '');

  const paidValue =
    kpis.paidTotal.length === 0
      ? none
      : kpis.paidTotal
          .slice(0, 1)
          .map((e) => formatMoney(e.amountMinor, e.currency, 'en'))
          .join('') +
        (kpis.paidTotal.length > 1
          ? ` ${tr('my_payments_kpi_multiCurrencyMore').replace('{n}', String(kpis.paidTotal.length - 1))}`
          : '');

  const nextDueValue = Option.match(kpis.nextDue, {
    onNone: () => none,
    onSome: (nd) =>
      `${formatMoney(nd.amountMinor, nd.currency, 'en')} · ${formatLocalDate(nd.effectiveDueAt)}`,
  });

  const isEmpty = myStatus.length === 0;

  return (
    <div className='space-y-6'>
      <h1 className='text-2xl font-bold'>{tr('my_payments_pageTitle')}</h1>

      {/* KPI Cards */}
      <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
        {/* showLabel=false: 'Outstanding' conflicts with the Outstanding filter chip */}
        <KpiCard label={tr('finance_kpi_outstanding')} value={outstandingValue} showLabel={false} />
        <KpiCard label={tr('finance_kpi_overdue')} value={String(kpis.overdueCount)} />
        <KpiCard label={tr('my_payments_kpi_paidTotal')} value={paidValue} />
        <KpiCard label={tr('my_payments_kpi_nextDue')} value={nextDueValue} />
      </div>

      {isEmpty ? (
        <p className='text-center text-muted-foreground py-12'>{tr('my_payments_empty')}</p>
      ) : (
        <>
          {/* Filter chips */}
          <div className='flex flex-wrap gap-1'>
            {FILTER_CHIPS.map((chip) => {
              const label = tr(chip.labelKey);
              return (
                <button
                  key={chip.value}
                  type='button'
                  aria-pressed={filter === chip.value}
                  onClick={() => setFilter(chip.value)}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                    filter === chip.value
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background text-muted-foreground hover:bg-muted'
                  }`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {/* Per-currency sections */}
          {myStatus.map((group) => {
            const sorted = sortAssignments(
              group.assignments as ReadonlyArray<
                FeeAssignmentView & { status: FeeAssignmentStatus }
              >,
            );
            const filtered = sorted.filter((a) => matchesFilter(a as FeeAssignmentView, filter));

            if (filtered.length === 0) {
              return null;
            }

            return (
              <section key={group.currency} data-currency={group.currency}>
                <Card>
                  <CardHeader>
                    <CardTitle className='text-base'>{group.currency}</CardTitle>
                  </CardHeader>
                  <CardContent className='p-0'>
                    <div className='overflow-x-auto'>
                      <table className='w-full text-sm'>
                        <thead>
                          <tr className='border-b text-muted-foreground text-xs'>
                            <th className='w-8 py-2 px-3' />
                            <th className='py-2 px-3 text-left'>{tr('finance_column_fee')}</th>
                            <th className='py-2 px-3 text-left'>{tr('finance_column_due')}</th>
                            {/* Use aria-label to avoid 'Paid' text conflicting with filter chip */}
                            <th
                              className='py-2 px-3 text-right'
                              aria-label={tr('finance_column_paid')}
                            />
                            <th className='py-2 px-3 text-right'>{tr('finance_column_status')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {filtered.map((assignment) => {
                            const a = assignment as FeeAssignmentView;
                            const hasPayments = a.paidMinor > 0;
                            const isExpanded = !!expanded[a.assignmentId];
                            return (
                              <React.Fragment key={a.assignmentId}>
                                <tr className='border-b last:border-0'>
                                  <td className='py-2 px-3'>
                                    {hasPayments && (
                                      <button
                                        type='button'
                                        data-testid='payment-history-toggle'
                                        aria-label={tr('my_payments_history_toggle')}
                                        aria-expanded={isExpanded}
                                        aria-controls={`payment-history-${a.assignmentId}`}
                                        onClick={() => toggleExpanded(a.assignmentId)}
                                        className='flex items-center justify-center size-6 rounded hover:bg-muted transition-colors'
                                      >
                                        <ChevronRight
                                          className={`size-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                          aria-hidden='true'
                                        />
                                      </button>
                                    )}
                                  </td>
                                  <td className='py-2 px-3 font-medium'>{a.feeName}</td>
                                  <td className='py-2 px-3 text-muted-foreground'>
                                    {Option.match(a.effectiveDueAt, {
                                      onNone: () => '—',
                                      onSome: (d) => formatLocalDate(d),
                                    })}
                                  </td>
                                  <td className='py-2 px-3 text-right'>
                                    {a.paidMinor > 0
                                      ? formatMoney(a.paidMinor, group.currency, 'en')
                                      : '—'}
                                  </td>
                                  <td className='py-2 px-3 text-right'>
                                    <PaymentStatusBadge
                                      status={
                                        a.status as import('@sideline/domain').FeeAssignment.FeeAssignmentStatus
                                      }
                                    />
                                  </td>
                                </tr>
                                {isExpanded && (
                                  <tr id={`payment-history-${a.assignmentId}`}>
                                    <td colSpan={5} className='bg-muted/30'>
                                      <MyPaymentHistoryRow
                                        teamId={teamId}
                                        feeId={a.feeId}
                                        currency={group.currency}
                                      />
                                    </td>
                                  </tr>
                                )}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  </CardContent>
                </Card>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
