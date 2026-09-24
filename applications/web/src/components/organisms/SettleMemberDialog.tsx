import { Fee, type FinanceApi, type Payment, SettlementPlan } from '@sideline/domain';
import { DateTime, Option, Schema } from 'effect';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '~/components/ui/dialog';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { dateOnlyToUtcNoon, formatLocalDate } from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
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

/**
 * Must match `packages/domain/src/models/SettlementPlan.ts`'s internal `compareCandidates`
 * exactly — `effectiveDueAt` ascending, `Option.none()` last, tie-broken by `assignmentId`
 * ascending. This is display-only sorting for the static breakdown list (every outstanding
 * fee, regardless of what's currently typed); the actual money allocation always runs through
 * the shared `planSettlement`, never reimplemented here (§4 / §9 "breakdown ordering").
 */
function compareByPlanOrder(a: SettleAssignmentCandidate, b: SettleAssignmentCandidate): number {
  if (Option.isSome(a.effectiveDueAt) && Option.isSome(b.effectiveDueAt)) {
    const diff =
      Number(DateTime.toEpochMillis(a.effectiveDueAt.value)) -
      Number(DateTime.toEpochMillis(b.effectiveDueAt.value));
    if (diff !== 0) return diff;
  } else if (Option.isSome(a.effectiveDueAt) !== Option.isSome(b.effectiveDueAt)) {
    return Option.isSome(a.effectiveDueAt) ? -1 : 1;
  }
  return a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SettleAssignmentCandidate = {
  assignmentId: string;
  feeId: string;
  feeName: string;
  dueMinor: number;
  paidMinor: number;
  effectiveDueAt: Option.Option<DateTime.Utc>;
};

interface SettleMemberDialogProps {
  open: boolean;
  memberName?: string;
  currency: string;
  /** The member's credit balance in THIS currency only — never summed across currencies. */
  creditMinor: number;
  /** Outstanding (pending | partial | overdue) assignments for this member, in this currency,
   * with waived/paid/archived already excluded by the caller. */
  assignments: ReadonlyArray<SettleAssignmentCandidate>;
  /** Parent owns the async call (organisms take no router hooks) — while true, the footer
   * buttons and the amount input are disabled so a double-click can't become a double payment. */
  submitting: boolean;
  onSubmit: (req: FinanceApi.CreateSettlementRequest) => void;
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function SettleMemberDialog({
  open,
  memberName,
  currency,
  creditMinor,
  assignments,
  submitting,
  onSubmit,
  onCancel,
}: SettleMemberDialogProps) {
  const [amountStr, setAmountStr] = React.useState('');
  const [method, setMethod] = React.useState<Payment.ManualPaymentMethod>('cash');
  const [paidAt, setPaidAt] = React.useState(todayIsoDate());
  const [note, setNote] = React.useState('');

  const memberLabel = memberName ?? '—';

  const outstandingSorted = React.useMemo(
    () =>
      assignments
        .filter((a) => a.dueMinor > a.paidMinor)
        .slice()
        .sort(compareByPlanOrder),
    [assignments],
  );

  const candidates: ReadonlyArray<SettlementPlan.SettlementCandidate> = React.useMemo(
    () =>
      outstandingSorted.map((a) => ({
        assignmentId: a.assignmentId,
        feeId: a.feeId,
        feeName: a.feeName,
        dueMinor: a.dueMinor,
        paidMinor: a.paidMinor,
        effectiveDueAt: Option.map(a.effectiveDueAt, (d) => Number(DateTime.toEpochMillis(d))),
      })),
    [outstandingSorted],
  );

  // Baseline (amountMinor=0): outstanding / creditApplied / toPay depend only on the
  // assignments + credit balance, never on what's currently typed. This is what decides which
  // of the dialog's cases (A/C/D/E, UX spec §3.2) is showing.
  const baseline = React.useMemo(
    () => SettlementPlan.planSettlement(candidates, creditMinor, 0),
    [candidates, creditMinor],
  );
  const isAddCredit = baseline.outstandingMinor === 0; // case A
  const isCoveredByCredit = !isAddCredit && baseline.toPayMinor === 0; // case D

  // Reset only on `open` flipping true (matches RecordPaymentDialog / WaiveAssignmentDialog) —
  // deliberately NOT re-seeding the amount when `baseline` changes while the dialog stays open.
  // On SettlementStale the parent reloads fresh data and the breakdown re-renders from it (UX
  // spec §3.5), but the typed amount must survive so the treasurer can "check the amount and
  // try again" against what they typed, not have it silently overwritten out from under them.
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps are `open` only, see above
  React.useEffect(() => {
    if (open) {
      setAmountStr(baseline.toPayMinor > 0 ? String(baseline.toPayMinor / 100) : '');
      setMethod('cash');
      setPaidAt(todayIsoDate());
      setNote('');
    }
  }, [open]);

  const amountMinor = React.useMemo(() => {
    if (isCoveredByCredit) return 0;
    try {
      return parseAmount(amountStr, currency);
    } catch {
      return 0;
    }
  }, [amountStr, currency, isCoveredByCredit]);

  const plan = React.useMemo(
    () => SettlementPlan.planSettlement(candidates, creditMinor, amountMinor),
    [candidates, creditMinor, amountMinor],
  );

  const isOverpayment = !isAddCredit && !isCoveredByCredit && amountMinor > baseline.toPayMinor;

  const consequence = ((): string => {
    if (amountMinor === 0 && creditMinor === 0) {
      return tr('finance_settle_creditOnly', {
        amount: formatMoney(0, currency, 'en'),
        member: memberLabel,
      });
    }
    if (isAddCredit) {
      return tr('finance_settle_creditOnly', {
        amount: formatMoney(amountMinor, currency, 'en'),
        member: memberLabel,
      });
    }
    if (isCoveredByCredit) {
      return tr('finance_settle_coverFromCredit');
    }
    if (Option.isNone(plan.firstPartial) && plan.fullyCoveredCount === outstandingSorted.length) {
      return tr('finance_settle_coversAll', { count: outstandingSorted.length });
    }
    if (plan.fullyCoveredCount > 0 && Option.isSome(plan.firstPartial)) {
      const partial = plan.firstPartial.value;
      return tr('finance_settle_coversPartial', {
        count: plan.fullyCoveredCount,
        remaining: formatMoney(partial.remainingMinor, currency, 'en'),
        fee: partial.feeName,
      });
    }
    if (Option.isSome(plan.firstPartial)) {
      const partial = plan.firstPartial.value;
      return tr('finance_settle_coversPartialNone', {
        amount: formatMoney(amountMinor, currency, 'en'),
        fee: partial.feeName,
        remaining: formatMoney(partial.remainingMinor, currency, 'en'),
      });
    }
    return tr('finance_settle_creditOnly', {
      amount: formatMoney(amountMinor, currency, 'en'),
      member: memberLabel,
    });
  })();

  const submitLabel = isAddCredit
    ? tr('finance_settle_submitAddCredit', { amount: formatMoney(amountMinor, currency, 'en') })
    : isCoveredByCredit
      ? tr('finance_settle_submitFromCredit')
      : tr('finance_settle_submit', { amount: formatMoney(amountMinor, currency, 'en') });

  const submitDisabled =
    submitting || (!isCoveredByCredit && amountMinor === 0 && plan.creditAppliedMinor === 0);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (submitDisabled) return;

    const submitAmountMinor = isCoveredByCredit ? 0 : amountMinor;
    const req: FinanceApi.CreateSettlementRequest = {
      currency: Schema.decodeSync(Fee.CurrencyCode)(currency),
      amountMinor: Schema.decodeSync(Fee.AmountMinor)(submitAmountMinor),
      method,
      paidAt: dateOnlyToUtcNoon(paidAt),
      note: note.trim() ? Option.some(note.trim()) : Option.none(),
      expectedOutstandingMinor: Schema.decodeSync(Fee.AmountMinor)(baseline.outstandingMinor),
      // Reconciled alongside outstanding — a credit balance can move underneath an open dialog
      // (e.g. a concurrent voidDeposit) even when outstanding alone still matches.
      expectedCreditMinor: Schema.decodeSync(Fee.AmountMinor)(creditMinor),
    };
    onSubmit(req);
  };

  const title = isAddCredit
    ? tr('finance_settle_titleAddCredit', { member: memberLabel })
    : tr('finance_settle_title', { member: memberLabel });

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) onCancel();
      }}
    >
      <DialogContent aria-describedby='settle-dialog-description'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription id='settle-dialog-description'>
            {tr('finance_settle_currencyNote', { currency })}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
          {isAddCredit ? (
            <p className='text-sm text-muted-foreground'>
              {tr('finance_settle_empty', { currency })}
            </p>
          ) : (
            <dl className='flex flex-col gap-2 text-sm'>
              <p className='text-xs font-medium text-muted-foreground'>
                {tr('finance_settle_breakdownHeading')}
              </p>
              {outstandingSorted.map((a) => (
                <div key={a.assignmentId} className='flex justify-between gap-3'>
                  <dt className='min-w-0 truncate'>
                    {a.feeName}
                    <div className='text-xs text-muted-foreground'>
                      {tr('finance_column_due')}{' '}
                      {Option.match(a.effectiveDueAt, {
                        onNone: () => '—',
                        onSome: (d) => formatLocalDate(d),
                      })}
                    </div>
                  </dt>
                  <dd className='shrink-0 tabular-nums'>
                    {formatMoney(a.dueMinor - a.paidMinor, currency, 'en')}
                  </dd>
                </div>
              ))}
              <div className='flex flex-col gap-1 border-t pt-2'>
                <div className='flex justify-between gap-3'>
                  <dt>{tr('finance_settle_totalOutstanding')}</dt>
                  <dd className='tabular-nums'>
                    {formatMoney(baseline.outstandingMinor, currency, 'en')}
                  </dd>
                </div>
                {baseline.creditAppliedMinor > 0 && (
                  <div className='flex justify-between gap-3'>
                    <dt>{tr('finance_settle_creditApplied')}</dt>
                    <dd className='tabular-nums'>
                      −{formatMoney(baseline.creditAppliedMinor, currency, 'en')}
                    </dd>
                  </div>
                )}
                <div className='flex justify-between gap-3 font-semibold'>
                  <dt>{tr('finance_settle_toPay')}</dt>
                  <dd className='tabular-nums'>
                    {formatMoney(baseline.toPayMinor, currency, 'en')}
                  </dd>
                </div>
              </div>
            </dl>
          )}

          {!isCoveredByCredit && (
            <div className='flex flex-col gap-1.5'>
              <Label htmlFor='settle-amount'>{tr('finance_settle_amountReceived')}</Label>
              <Input
                id='settle-amount'
                inputMode='decimal'
                step='0.01'
                min='0'
                value={amountStr}
                onChange={(e) => setAmountStr(e.target.value)}
                aria-describedby='settle-consequence'
                disabled={submitting}
                placeholder='0.00'
              />
            </div>
          )}

          <p id='settle-consequence' role='status' aria-live='polite' className='text-sm'>
            {consequence}
          </p>

          {isOverpayment && (
            <Alert variant='warning'>
              <AlertTriangle />
              <AlertDescription>
                {tr('finance_settle_toCredit', {
                  amount: formatMoney(plan.creditAddedMinor, currency, 'en'),
                  member: memberLabel,
                })}
              </AlertDescription>
            </Alert>
          )}

          {amountMinor > 0 && (
            <>
              {/* Method / Date paid / Note — copied verbatim from RecordPaymentDialog. Hidden
                  entirely when amountMinor is 0: nothing is being received (case D, and case A
                  before the treasurer has typed anything). */}
              <div className='flex flex-col gap-1.5'>
                <span className='text-sm font-medium'>{tr('payment_record_method')}</span>
                <div className='flex flex-col gap-1'>
                  <label className='flex items-center gap-2 text-sm cursor-pointer'>
                    <input
                      type='radio'
                      name='settle-method'
                      value='cash'
                      checked={method === 'cash'}
                      onChange={() => setMethod('cash')}
                      disabled={submitting}
                    />
                    {tr('payment_record_method_cash')}
                  </label>
                  <label className='flex items-center gap-2 text-sm cursor-pointer'>
                    <input
                      type='radio'
                      name='settle-method'
                      value='bank_transfer'
                      checked={method === 'bank_transfer'}
                      onChange={() => setMethod('bank_transfer')}
                      disabled={submitting}
                    />
                    {tr('payment_record_method_bank_transfer')}
                  </label>
                </div>
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='settle-paidAt'>{tr('payment_record_paidAt')}</Label>
                <Input
                  id='settle-paidAt'
                  type='date'
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                  disabled={submitting}
                />
              </div>

              <div className='flex flex-col gap-1.5'>
                <Label htmlFor='settle-note'>{tr('payment_record_note')}</Label>
                <Textarea
                  id='settle-note'
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={tr('payment_record_note')}
                  disabled={submitting}
                />
              </div>
            </>
          )}

          {!isAddCredit && plan.lines.length > 0 && (
            <p className='text-xs text-muted-foreground'>
              {tr('finance_settle_voidHint', { count: plan.lines.length })}
            </p>
          )}

          <DialogFooter>
            <Button type='button' variant='outline' onClick={onCancel} disabled={submitting}>
              {tr('payment_record_cancel')}
            </Button>
            <Button type='submit' disabled={submitDisabled}>
              {submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
