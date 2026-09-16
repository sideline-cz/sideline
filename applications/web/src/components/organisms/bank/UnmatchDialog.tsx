import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { tr } from '~/lib/translations.js';

export interface UnmatchTarget {
  readonly txId: string;
  readonly amountLabel: string;
  readonly dateLabel: string;
  readonly feeName: string;
  readonly memberName: string;
}

interface UnmatchDialogProps {
  readonly target: UnmatchTarget | null;
  readonly onCancel: () => void;
  readonly onConfirm: (txId: string, reason: string) => void;
  readonly submitting: boolean;
}

/**
 * The undo path — voids, never deletes (design §3.9). A toast-level undo was rejected
 * deliberately: it cannot collect the mandatory reason, so it would have produced a void with an
 * empty `void_reason`, exactly the audit hole this dialog exists to close.
 */
export function UnmatchDialog({ target, onCancel, onConfirm, submitting }: UnmatchDialogProps) {
  const targetRef = React.useRef<UnmatchTarget | null>(null);
  if (target !== null) targetRef.current = target;
  const shown = target ?? targetRef.current;

  const [reason, setReason] = React.useState('');

  React.useEffect(() => {
    if (target !== null) setReason('');
  }, [target]);

  const canSubmit = reason.trim().length >= 3;

  return (
    <AlertDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('bank_unmatch_title')}</AlertDialogTitle>
        </AlertDialogHeader>
        {shown ? (
          <div className='flex flex-col gap-3 text-sm'>
            <p>
              {tr('bank_unmatch_body', {
                amount: shown.amountLabel,
                date: shown.dateLabel,
                fee: shown.feeName,
                member: shown.memberName,
              })}
            </p>
            <p className='text-muted-foreground'>{tr('bank_unmatch_effect')}</p>
            <p className='text-muted-foreground'>{tr('bank_unmatch_audit')}</p>
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='unmatch-reason'>{tr('bank_unmatch_reason')} *</Label>
              <Textarea
                id='unmatch-reason'
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              {!canSubmit && reason.length > 0 && (
                <p className='text-xs text-destructive'>{tr('bank_unmatch_reasonRequired')}</p>
              )}
            </div>
          </div>
        ) : null}
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={!canSubmit || submitting}
            onClick={() => shown && onConfirm(shown.txId, reason.trim())}
          >
            {tr('bank_unmatch_confirm')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
