import { Fee, type FinanceApi } from '@sideline/domain';
import { type DateTime, Option, Schema } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { dateOnlyToUtcNoon } from '~/lib/datetime.js';
import { parseAmount } from '~/lib/finance/parseAmount.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayIsoDate(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PaymentMethod = 'cash' | 'bank_transfer';

interface RecordPaymentDialogProps {
  open: boolean;
  assignmentId: string;
  feeId: string;
  teamId: string;
  memberName?: string;
  dueMinor: number;
  currency: string;
  onSubmit: (req: FinanceApi.RecordPaymentRequest) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function RecordPaymentDialog({
  open,
  memberName,
  currency,
  onSubmit,
  onCancel,
}: RecordPaymentDialogProps) {
  const [amountStr, setAmountStr] = React.useState('');
  const [method, setMethod] = React.useState<PaymentMethod>('cash');
  const [paidAt, setPaidAt] = React.useState(todayIsoDate());
  const [note, setNote] = React.useState('');
  const [amountError, setAmountError] = React.useState('');

  React.useEffect(() => {
    if (open) {
      setAmountStr('');
      setMethod('cash');
      setPaidAt(todayIsoDate());
      setNote('');
      setAmountError('');
    }
  }, [open]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    let amountMinor = 0;
    try {
      amountMinor = parseAmount(amountStr, currency);
      setAmountError('');
    } catch {
      setAmountError(tr('payment_record_validation_amountRequired'));
      return;
    }

    // Convert YYYY-MM-DD to DateTime.Utc anchored at noon to avoid timezone drift.
    // The schema (DateTimeFromIsoString = Schema.DateTimeUtcFromString) encodes
    // DateTime.Utc → ISO string automatically when the client sends the request.
    const paidAtUtc: DateTime.Utc = dateOnlyToUtcNoon(paidAt);

    const req: FinanceApi.RecordPaymentRequest = {
      amountMinor: Schema.decodeSync(Fee.AmountMinor)(amountMinor),
      method,
      paidAt: paidAtUtc,
      note: note.trim() ? Option.some(note.trim()) : Option.none(),
    };

    onSubmit(req);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>
            {tr('payment_record_title')}
            {memberName ? ` — ${memberName}` : ''}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Amount */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='payment-amount'>{tr('payment_record_amount')}</Label>
            <Input
              id='payment-amount'
              type='number'
              step='0.01'
              min='0.01'
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder='0.00'
            />
            {amountError && <p className='text-sm text-destructive'>{amountError}</p>}
          </div>

          {/* Method */}
          <div className='flex flex-col gap-1.5'>
            <span className='text-sm font-medium'>{tr('payment_record_method')}</span>
            <div className='flex flex-col gap-1'>
              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='payment-method'
                  value='cash'
                  checked={method === 'cash'}
                  onChange={() => setMethod('cash')}
                />
                {tr('payment_record_method_cash')}
              </label>
              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='payment-method'
                  value='bank_transfer'
                  checked={method === 'bank_transfer'}
                  onChange={() => setMethod('bank_transfer')}
                />
                {tr('payment_record_method_bank_transfer')}
              </label>
            </div>
          </div>

          {/* Paid at */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='payment-paidAt'>{tr('payment_record_paidAt')}</Label>
            <Input
              id='payment-paidAt'
              type='date'
              value={paidAt}
              onChange={(e) => setPaidAt(e.target.value)}
            />
          </div>

          {/* Note */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='payment-note'>{tr('payment_record_note')}</Label>
            <Textarea
              id='payment-note'
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={tr('payment_record_note')}
            />
          </div>

          <DialogFooter>
            <Button type='button' variant='outline' onClick={onCancel}>
              {tr('payment_record_cancel')}
            </Button>
            <Button type='submit'>{tr('payment_record_submit')}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
