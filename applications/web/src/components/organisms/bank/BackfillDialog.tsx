import type { BankSyncConfig } from '@sideline/domain';
import React from 'react';
import { Button } from '~/components/ui/button';
import { DatePicker } from '~/components/ui/date-picker';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { tr } from '~/lib/translations.js';

interface BackfillDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onStart: (from: string, to: string) => void;
  readonly starting: boolean;
  /** `null` before a run has ever started this session. */
  readonly backfillStatus: BankSyncConfig.BankSyncBackfillStatus | null;
  /** Pre-fills the range — the export panel's "Načíst chybějící období" deep link (design §7.2.1). */
  readonly initialFrom?: string;
  readonly initialTo?: string;
}

const currentYear = new Date().getFullYear();

/**
 * The 90-day history unlock flow (design §2.5 F). Fio only releases movements older than 90 days
 * inside a 10-minute window opened in Internetbanking; this dialog explains that, collects the
 * range, and reflects the bounded backfill loop's progress via `backfillStatus` — polled by the
 * parent from `GET /bank-sync` (§5 of the plan: the loop runs `Effect.forkDaemon`, the endpoint
 * returns 202 immediately).
 */
export function BackfillDialog({
  open,
  onOpenChange,
  onStart,
  starting,
  backfillStatus,
  initialFrom,
  initialTo,
}: BackfillDialogProps) {
  const [from, setFrom] = React.useState(initialFrom ?? '');
  const [to, setTo] = React.useState(initialTo ?? '');

  React.useEffect(() => {
    if (open) {
      setFrom(initialFrom ?? '');
      setTo(initialTo ?? '');
    }
  }, [open, initialFrom, initialTo]);

  const running = backfillStatus === 'running' || starting;
  const canStart = from !== '' && to !== '' && !running;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby='backfill-dialog-description'>
        <DialogHeader>
          <DialogTitle>{tr('fio_backfill_title')}</DialogTitle>
          <DialogDescription id='backfill-dialog-description'>
            {tr('fio_backfill_body')}
          </DialogDescription>
        </DialogHeader>

        <ol className='list-decimal pl-5 text-sm text-muted-foreground flex flex-col gap-1'>
          <li>{tr('fio_backfill_step1')}</li>
          <li>{tr('fio_backfill_step2')}</li>
          <li>{tr('fio_backfill_step3')}</li>
        </ol>

        <div className='grid grid-cols-2 gap-3'>
          <div>
            <span className='text-sm font-medium mb-1 block'>{tr('bank_export_from')}</span>
            <DatePicker
              value={from}
              onChange={setFrom}
              fromYear={currentYear - 5}
              toYear={currentYear}
            />
          </div>
          <div>
            <span className='text-sm font-medium mb-1 block'>{tr('bank_export_to')}</span>
            <DatePicker
              value={to}
              onChange={setTo}
              fromYear={currentYear - 5}
              toYear={currentYear}
            />
          </div>
        </div>

        {running ? (
          <p role='status' aria-busy='true' className='text-sm text-muted-foreground'>
            {tr('fio_backfill_running')}
          </p>
        ) : null}

        {backfillStatus === 'history_locked' ? (
          <div className='flex flex-col gap-2'>
            <p className='text-sm text-destructive'>{tr('fio_backfill_lockedTitle')}</p>
            <p className='text-sm text-muted-foreground'>{tr('fio_backfill_lockedBody')}</p>
          </div>
        ) : null}

        <DialogFooter>
          <Button type='button' variant='outline' onClick={() => onOpenChange(false)}>
            {tr('common_cancel')}
          </Button>
          <Button type='button' disabled={!canStart} onClick={() => onStart(from, to)}>
            {tr('fio_backfill_action')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
