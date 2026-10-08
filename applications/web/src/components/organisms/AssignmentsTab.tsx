import type { FeeAssignment } from '@sideline/domain';
import { Option } from 'effect';
import React from 'react';
import { listHeaderClass, listScrollClass } from '~/components/molecules/ListToolbar.js';
import { PaymentStatusBadge } from '~/components/molecules/PaymentStatusBadge.js';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeAssignmentView = {
  assignmentId: string;
  feeId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  // Use string for broader test compatibility; cast to FeeAssignmentStatus when rendering
  status: string;
  effectiveDueAt: Option.Option<unknown>;
  waivedReason: Option.Option<string>;
};

export type FeeViewMinimal = { feeId: string; name: string };
export type MemberSummary = { teamMemberId: string; memberName: string | null };

type StatusFilter = 'all' | 'pending' | 'paid' | 'overdue' | 'waived';

interface AssignmentsTabProps {
  assignments: ReadonlyArray<FeeAssignmentView>;
  fees: ReadonlyArray<FeeViewMinimal>;
  members: ReadonlyArray<MemberSummary>;
  canRecordPayments: boolean;
  canManageFees: boolean;
  onLogPayment?: (assignment: FeeAssignmentView) => void;
  onWaive?: (assignment: FeeAssignmentView) => void;
  onUnwaive?: (assignment: FeeAssignmentView) => void;
}

// ---------------------------------------------------------------------------
// Status filter chips
// ---------------------------------------------------------------------------

const STATUS_CHIPS: ReadonlyArray<{ value: StatusFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'assignments_tab_filterAll' },
  { value: 'pending', labelKey: 'assignments_tab_filterPending' },
  { value: 'paid', labelKey: 'assignments_tab_filterPaid' },
  { value: 'overdue', labelKey: 'assignments_tab_filterOverdue' },
  { value: 'waived', labelKey: 'assignments_tab_filterWaived' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Calculate outstanding amount for a row.
 * Paid and waived rows show 0; all others show max(0, due - paid).
 */
function outstandingMinor(assignment: FeeAssignmentView): number {
  if (assignment.status === 'paid' || assignment.status === 'waived') return 0;
  return Math.max(0, assignment.dueMinor - assignment.paidMinor);
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AssignmentsTab({
  assignments,
  canRecordPayments,
  canManageFees,
  onLogPayment,
  onWaive,
  onUnwaive,
}: AssignmentsTabProps) {
  const [search, setSearch] = React.useState('');
  const [statusFilter, setStatusFilter] = React.useState<StatusFilter>('all');

  const clearFilters = () => {
    setSearch('');
    setStatusFilter('all');
  };

  const hasFilters = search !== '' || statusFilter !== 'all';

  // Apply filters
  const filtered = assignments.filter((a) => {
    const memberName = Option.getOrElse(a.memberName, () => '');
    if (search && !memberName.toLowerCase().includes(search.toLowerCase())) return false;
    if (statusFilter !== 'all' && a.status !== statusFilter) return false;
    return true;
  });

  // Empty state: no assignments at all
  if (assignments.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-2 py-16 text-center'>
        <p className='text-muted-foreground'>{tr('assignments_tab_empty_noFees')}</p>
      </div>
    );
  }

  return (
    <div>
      {/* Filters */}
      <div className='mb-4 flex flex-wrap gap-3 items-center'>
        <Input
          type='search'
          placeholder={tr('assignments_tab_searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-9 w-full sm:max-w-xs'
        />
        <fieldset className='flex gap-1 flex-wrap border-0 m-0 p-0'>
          {STATUS_CHIPS.map((chip) => {
            const label = tr(chip.labelKey);
            return (
              <button
                key={chip.value}
                type='button'
                aria-label={label}
                aria-pressed={statusFilter === chip.value}
                onClick={() => setStatusFilter(chip.value)}
                className={`rounded-full border px-3 py-1 text-xs font-medium min-w-[2.5rem] transition-colors ${
                  statusFilter === chip.value
                    ? 'bg-primary text-primary-foreground border-primary'
                    : 'bg-background text-muted-foreground hover:bg-muted'
                }`}
              >
                {label}
              </button>
            );
          })}
        </fieldset>
      </div>

      {/* No results after filtering */}
      {filtered.length === 0 && hasFilters ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <p className='text-muted-foreground'>{tr('assignments_tab_empty_noResults')}</p>
          <Button type='button' variant='outline' size='sm' onClick={clearFilters}>
            {tr('assignments_tab_clearFilters')}
          </Button>
        </div>
      ) : (
        <div className={listScrollClass}>
          <table className='w-full text-sm'>
            <thead className={listHeaderClass}>
              <tr className='border-b'>
                <th className='py-2 px-3 text-left font-medium'>
                  {tr('assignments_tab_colMember')}
                </th>
                <th className='py-2 px-3 text-left font-medium'>{tr('assignments_tab_colFee')}</th>
                <th className='py-2 px-3 text-right font-medium'>{tr('assignments_tab_colDue')}</th>
                <th className='py-2 px-3 text-left font-medium'>
                  {tr('assignments_tab_colStatus')}
                </th>
                {(canRecordPayments || canManageFees) && (
                  <th className='py-2 px-3 text-left font-medium'>
                    {tr('assignments_tab_colActions')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {filtered.map((assignment) => (
                <tr key={assignment.assignmentId} className='border-b hover:bg-muted/50'>
                  <td className='py-3 px-3'>
                    {Option.getOrElse(assignment.memberName, () => '—')}
                  </td>
                  <td className='py-3 px-3'>{assignment.feeName}</td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(outstandingMinor(assignment), assignment.currency, 'en')}
                  </td>
                  <td className='py-3 px-3'>
                    <PaymentStatusBadge
                      status={assignment.status as FeeAssignment.FeeAssignmentStatus}
                    />
                  </td>
                  {(canRecordPayments || canManageFees) && (
                    <td className='py-3 px-3'>
                      <div className='flex gap-2'>
                        {canRecordPayments && (
                          <button
                            type='button'
                            className='text-xs underline hover:no-underline'
                            onClick={() => onLogPayment?.(assignment)}
                          >
                            {tr('assignments_tab_actionLogPayment')}
                          </button>
                        )}
                        {canManageFees && assignment.status !== 'waived' && (
                          <button
                            type='button'
                            className='text-xs underline hover:no-underline'
                            onClick={() => onWaive?.(assignment)}
                          >
                            {tr('assignments_tab_actionWaive')}
                          </button>
                        )}
                        {canManageFees && assignment.status === 'waived' && (
                          <button
                            type='button'
                            className='text-xs underline hover:no-underline'
                            onClick={() => onUnwaive?.(assignment)}
                          >
                            {tr('assignments_tab_actionUnwaive')}
                          </button>
                        )}
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
