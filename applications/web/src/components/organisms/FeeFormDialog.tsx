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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Textarea } from '~/components/ui/textarea';
import { dateOnlyToUtcNoon, formatLocalDate } from '~/lib/datetime.js';
import { parseAmount } from '~/lib/finance/parseAmount.js';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type FeeView = {
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

type TargetScope = 'all_members' | 'custom';

interface FeeFormDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  fee?: FeeView;
  teamId: string;
  onSubmit: (req: FinanceApi.CreateFeeRequest | FinanceApi.UpdateFeeRequest) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a YYYY-MM-DD string to a DateTime.Utc anchored at noon to avoid
 * timezone-drift issues (UTC±12 coverage). Empty string returns none.
 */
function parseDueAtField(value: string): Option.Option<DateTime.Utc> {
  const trimmed = value.trim();
  if (!trimmed) return Option.none();
  return Option.some(dateOnlyToUtcNoon(trimmed));
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function FeeFormDialog({ open, mode, fee, onSubmit, onCancel }: FeeFormDialogProps) {
  const isEdit = mode === 'edit';

  const [name, setName] = React.useState(isEdit && fee ? fee.name : '');
  const [description, setDescription] = React.useState(
    isEdit && fee ? Option.getOrElse(fee.description, () => '') : '',
  );
  const [amountStr, setAmountStr] = React.useState(
    isEdit && fee ? String(fee.amountMinor / 100) : '',
  );
  const [currency, setCurrency] = React.useState(isEdit && fee ? fee.currency : 'CZK');
  const [dueAt, setDueAt] = React.useState(
    isEdit && fee && Option.isSome(fee.dueAt) ? formatLocalDate(fee.dueAt.value) : '',
  );
  const [targetScope, setTargetScope] = React.useState<TargetScope>(
    isEdit && fee ? (fee.targetScope as TargetScope) : 'all_members',
  );
  const [nameError, setNameError] = React.useState('');
  const [amountError, setAmountError] = React.useState('');

  // Reset when dialog opens/closes or mode changes
  React.useEffect(() => {
    if (open) {
      setName(isEdit && fee ? fee.name : '');
      setDescription(isEdit && fee ? Option.getOrElse(fee.description, () => '') : '');
      setAmountStr(isEdit && fee ? String(fee.amountMinor / 100) : '');
      setCurrency(isEdit && fee ? fee.currency : 'CZK');
      setDueAt(isEdit && fee && Option.isSome(fee.dueAt) ? formatLocalDate(fee.dueAt.value) : '');
      setTargetScope(isEdit && fee ? (fee.targetScope as TargetScope) : 'all_members');
      setNameError('');
      setAmountError('');
    }
  }, [open, isEdit, fee]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    let hasError = false;

    if (!name.trim()) {
      setNameError(tr('fee_form_validation_nameRequired'));
      hasError = true;
    } else {
      setNameError('');
    }

    let amountMinor = 0;
    try {
      amountMinor = parseAmount(amountStr, currency);
      setAmountError('');
    } catch {
      setAmountError(tr('fee_form_validation_amountRequired'));
      hasError = true;
    }

    if (hasError) return;

    const dueAtOption = parseDueAtField(dueAt);
    const descriptionOption: Option.Option<string> =
      description.trim() === '' ? Option.none() : Option.some(description.trim());

    const brandedAmount = Schema.decodeSync(Fee.AmountMinor)(amountMinor);
    const brandedCurrency = Schema.decodeSync(Fee.CurrencyCode)(currency);

    if (isEdit) {
      const req: FinanceApi.UpdateFeeRequest = {
        name: Option.some(name.trim()),
        amountMinor: Option.some(brandedAmount),
        currency: Option.some(brandedCurrency),
        targetScope: Option.some(targetScope),
        description: Option.some(descriptionOption),
        dueAt: Option.some(dueAtOption),
      };
      onSubmit(req);
    } else {
      const req: FinanceApi.CreateFeeRequest = {
        name: name.trim(),
        amountMinor: brandedAmount,
        currency: brandedCurrency,
        targetScope,
        description: descriptionOption,
        dueAt: dueAtOption,
        recurrence: Option.none(),
      };
      onSubmit(req);
    }
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
            {isEdit ? tr('fee_form_title_edit') : tr('fee_form_title_create')}
          </DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {/* Name */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='fee-name'>{tr('fee_form_name')}</Label>
            <Input
              id='fee-name'
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={tr('fee_form_name')}
            />
            {nameError && <p className='text-sm text-destructive'>{nameError}</p>}
          </div>

          {/* Description */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='fee-description'>{tr('fee_form_description')}</Label>
            <Textarea
              id='fee-description'
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={tr('fee_form_descriptionPlaceholder')}
            />
          </div>

          {/* Amount */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='fee-amount'>{tr('fee_form_amount')}</Label>
            <Input
              id='fee-amount'
              type='number'
              step='0.01'
              min='0.01'
              value={amountStr}
              onChange={(e) => setAmountStr(e.target.value)}
              placeholder='0.00'
            />
            {amountError && <p className='text-sm text-destructive'>{amountError}</p>}
          </div>

          {/* Currency */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='fee-currency'>{tr('fee_form_currency')}</Label>
            <Select value={currency} onValueChange={setCurrency}>
              <SelectTrigger id='fee-currency'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value='CZK'>CZK</SelectItem>
                <SelectItem value='EUR'>EUR</SelectItem>
                <SelectItem value='USD'>USD</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Due date */}
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='fee-dueAt'>{tr('fee_form_dueAt')}</Label>
            <Input
              id='fee-dueAt'
              type='date'
              value={dueAt}
              onChange={(e) => setDueAt(e.target.value)}
            />
          </div>

          {/* Target scope — radio buttons so text is always visible in DOM */}
          <div className='flex flex-col gap-1.5'>
            <span className='text-sm font-medium'>{tr('fee_form_targetScope')}</span>
            <div className='flex flex-col gap-1'>
              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='fee-targetScope'
                  value='all_members'
                  checked={targetScope === 'all_members'}
                  onChange={() => setTargetScope('all_members')}
                />
                {tr('fee_form_targetScope_all_members')}
              </label>
              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='fee-targetScope'
                  value='custom'
                  checked={targetScope === 'custom'}
                  onChange={() => setTargetScope('custom')}
                />
                {tr('fee_form_targetScope_manual')}
              </label>
            </div>
          </div>

          <DialogFooter>
            <Button type='button' variant='outline' onClick={onCancel}>
              {tr('fee_form_cancel')}
            </Button>
            <Button type='submit'>
              {isEdit ? tr('fee_form_submit_edit') : tr('fee_form_submit_create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
