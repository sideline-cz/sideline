import { type DateTime, Option } from 'effect';
import { Button } from '~/components/ui/button';
import { formatLocalDate } from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FeeView = {
  feeId: string;
  teamId: string;
  name: string;
  description: Option.Option<string>;
  amountMinor: number;
  currency: string;
  dueAt: Option.Option<DateTime.Utc>;
  targetScope: string;
  archivedAt: Option.Option<unknown>;
  assignmentCount: number;
  paidCount: number;
  pendingCount: number;
  overdueCount: number;
};

interface FeeManagementPageProps {
  fees: ReadonlyArray<FeeView>;
  canManageFees: boolean;
  onCreateFee?: () => void;
  onEditFee?: (fee: FeeView) => void;
  onArchiveFee?: (feeId: string) => void;
  onAssignMembers?: (fee: FeeView) => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeeManagementPage({
  fees,
  canManageFees,
  onCreateFee,
  onEditFee,
  onArchiveFee,
  onAssignMembers,
}: FeeManagementPageProps) {
  // Filter out archived fees
  const activeFees = fees.filter((f) => Option.isNone(f.archivedAt));

  if (activeFees.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center gap-4 py-16 text-center'>
        <h1 className='text-2xl font-bold'>{tr('fee_management_title')}</h1>
        <p className='text-muted-foreground'>{tr('fee_management_empty')}</p>
        {canManageFees && (
          <Button type='button' onClick={onCreateFee}>
            {tr('fee_management_createFee')}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div>
      <div className='mb-4 flex items-center justify-between'>
        <h1 className='text-2xl font-bold'>{tr('fee_management_title')}</h1>
        {canManageFees && (
          <Button type='button' onClick={onCreateFee}>
            {tr('fee_management_createFee')}
          </Button>
        )}
      </div>

      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b'>
              <th className='py-2 px-3 text-left font-medium'>{tr('fee_management_colName')}</th>
              <th className='py-2 px-3 text-right font-medium'>{tr('fee_management_colAmount')}</th>
              <th className='py-2 px-3 text-left font-medium'>{tr('fee_management_colDue')}</th>
              <th className='py-2 px-3 text-left font-medium'>
                {tr('fee_management_colProgress')}
              </th>
              {canManageFees && (
                <th className='py-2 px-3 text-left font-medium'>{tr('fee_management_actions')}</th>
              )}
            </tr>
          </thead>
          <tbody>
            {activeFees.map((fee) => {
              const dueLabel = Option.isSome(fee.dueAt) ? formatLocalDate(fee.dueAt.value) : '—';

              return (
                <tr key={fee.feeId} className='border-b hover:bg-muted/50'>
                  <td className='py-3 px-3 font-medium'>{fee.name}</td>
                  <td className='py-3 px-3 text-right tabular-nums'>
                    {formatMoney(fee.amountMinor, fee.currency, 'en')}
                  </td>
                  <td className='py-3 px-3 text-muted-foreground'>{dueLabel}</td>
                  <td className='py-3 px-3'>
                    {fee.paidCount} / {fee.assignmentCount}
                  </td>
                  {canManageFees && (
                    <td className='py-3 px-3'>
                      <div className='flex gap-2 items-center'>
                        {fee.targetScope === 'all_members' ? (
                          <span className='text-xs text-muted-foreground px-2 py-0.5 rounded-full border'>
                            {tr('fee_management_autoAssigned')}
                          </span>
                        ) : (
                          <Button
                            type='button'
                            size='sm'
                            variant='outline'
                            onClick={() => onAssignMembers?.(fee)}
                          >
                            {tr('fee_management_assignMembers')}
                          </Button>
                        )}
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={() => onEditFee?.(fee)}
                        >
                          {tr('fee_management_editFee')}
                        </Button>
                        <Button
                          type='button'
                          size='sm'
                          variant='outline'
                          onClick={() => onArchiveFee?.(fee.feeId)}
                        >
                          {tr('fee_management_archiveFee')}
                        </Button>
                      </div>
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
