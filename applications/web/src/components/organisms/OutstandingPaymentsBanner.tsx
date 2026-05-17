import { Link } from '@tanstack/react-router';
import { DateTime, Option } from 'effect';
import { AlertTriangle, Clock, CreditCard } from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types (local mirror)
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

export type MyFinanceStatus = {
  currency: string;
  assignments: ReadonlyArray<FeeAssignmentView>;
  totalOutstandingMinor: number;
};

interface OutstandingPaymentsBannerProps {
  teamId: string;
  groups: ReadonlyArray<MyFinanceStatus>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isOutstanding(status: FeeAssignmentStatus): boolean {
  return status === 'pending' || status === 'partial' || status === 'overdue';
}

/** Sort outstanding assignments: overdue first by effectiveDueAt asc, then pending/partial by effectiveDueAt asc */
function sortOutstanding(
  assignments: ReadonlyArray<FeeAssignmentView>,
): ReadonlyArray<FeeAssignmentView> {
  return [...assignments].sort((a, b) => {
    const groupWeight = (s: FeeAssignmentStatus) => (s === 'overdue' ? 0 : 1);
    const gA = groupWeight(a.status);
    const gB = groupWeight(b.status);
    if (gA !== gB) return gA - gB;
    // Same group — sort by effectiveDueAt asc, none last
    if (Option.isNone(a.effectiveDueAt) && Option.isNone(b.effectiveDueAt)) return 0;
    if (Option.isNone(a.effectiveDueAt)) return 1;
    if (Option.isNone(b.effectiveDueAt)) return -1;
    const aMs = Number(DateTime.toEpochMillis(a.effectiveDueAt.value));
    const bMs = Number(DateTime.toEpochMillis(b.effectiveDueAt.value));
    return aMs < bMs ? -1 : aMs > bMs ? 1 : 0;
  });
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function OutstandingPaymentsBanner({ teamId, groups }: OutstandingPaymentsBannerProps) {
  // Collect all outstanding assignments across all groups
  const allOutstanding: Array<FeeAssignmentView & { currency: string }> = [];
  for (const group of groups) {
    for (const assignment of group.assignments) {
      if (isOutstanding(assignment.status)) {
        allOutstanding.push({ ...assignment, currency: group.currency });
      }
    }
  }

  if (allOutstanding.length === 0) return null;

  const hasOverdue = allOutstanding.some((a) => a.status === 'overdue');
  const variant = hasOverdue ? 'red' : 'amber';

  const sorted = sortOutstanding(allOutstanding);
  const displayed = sorted.slice(0, 3);
  const overflow = sorted.length - displayed.length;

  const title = hasOverdue
    ? tr('my_payments_banner_titleRed')
    : tr('my_payments_banner_titleAmber');

  const cardClass = hasOverdue
    ? 'border-red-200 bg-red-50/50 dark:border-red-800 dark:bg-red-950/20 py-4 gap-3'
    : 'border-amber-200 bg-amber-50/50 dark:border-amber-800 dark:bg-amber-950/20 py-4 gap-3';

  const iconContainerClass = hasOverdue
    ? 'flex size-6 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/50'
    : 'flex size-6 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50';

  const IconComponent = hasOverdue ? AlertTriangle : CreditCard;
  const iconClass = hasOverdue
    ? 'size-3.5 text-red-600 dark:text-red-400'
    : 'size-3.5 text-amber-600 dark:text-amber-400';

  const badgeClass = hasOverdue
    ? 'bg-red-100 text-red-700 border-red-200 dark:bg-red-900/50 dark:text-red-300 dark:border-red-800'
    : 'bg-amber-100 text-amber-700 border-amber-200 dark:bg-amber-900/50 dark:text-amber-300 dark:border-amber-800';

  const rowBorderClass = hasOverdue
    ? 'border-red-200 hover:bg-red-50 dark:border-red-800 dark:bg-red-950/30 dark:hover:bg-red-950/50'
    : 'border-amber-200 hover:bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 dark:hover:bg-amber-950/50';

  const clockIconClass = hasOverdue ? 'size-3 text-red-500' : 'size-3 text-amber-500';

  return (
    <Card data-variant={variant} className={cardClass}>
      <CardHeader className='px-4 sm:px-6 py-0'>
        <div className='flex items-center justify-between'>
          <div className='flex items-center gap-2'>
            <div className={iconContainerClass}>
              <IconComponent className={iconClass} />
            </div>
            <CardTitle className='text-sm font-semibold'>{title}</CardTitle>
            <Badge variant='secondary' className={badgeClass}>
              {allOutstanding.length}
            </Badge>
          </div>
          <Link
            to='/teams/$teamId/my-payments'
            params={{ teamId }}
            className='text-xs font-medium text-muted-foreground hover:underline'
          >
            {tr('my_payments_banner_cta_viewAll')}
          </Link>
        </div>
      </CardHeader>
      <CardContent className='px-4 sm:px-6 py-0'>
        <div className='flex flex-col gap-2'>
          {displayed.map((assignment) => (
            <div
              key={assignment.assignmentId}
              data-testid='banner-fee-row'
              data-status={assignment.status}
              className={`flex items-center justify-between gap-3 rounded-lg border bg-white p-3 transition-colors ${rowBorderClass}`}
            >
              <div className='min-w-0 flex-1'>
                <p className='font-medium truncate text-sm'>{assignment.feeName}</p>
                {Option.isSome(assignment.effectiveDueAt) && (
                  <p className='flex items-center gap-1 text-xs text-muted-foreground mt-0.5'>
                    <Clock className={clockIconClass} />
                    {tr('finance_column_due')}:{' '}
                    {new Date(
                      Number(DateTime.toEpochMillis(assignment.effectiveDueAt.value)),
                    ).toLocaleDateString()}
                  </p>
                )}
              </div>
              <div className='shrink-0 text-right'>
                <span className='text-sm font-semibold'>
                  {formatMoney(
                    Math.max(0, assignment.dueMinor - assignment.paidMinor),
                    assignment.currency,
                    'en',
                  )}
                </span>
              </div>
            </div>
          ))}
          {overflow > 0 && (
            <p className='text-xs text-muted-foreground text-center py-1'>
              {tr('my_payments_banner_more').replace('{n}', String(overflow))}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
