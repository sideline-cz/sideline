import type { BankSyncApi } from '@sideline/domain';
import { BankTransaction, Fee, FeeAssignment, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { Plus, X } from 'lucide-react';
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
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { parseAmount } from '~/lib/finance/parseAmount.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type ResolveMode = 'assign' | 'split' | 'other' | 'ignore';

interface MatchTransactionDialogProps {
  readonly teamId: string;
  readonly txId: string | null;
  readonly onCancel: () => void;
  readonly onResolved: () => void;
}

const defaultModeFor = (reason: BankTransaction.BankTransactionMatchReason | null): ResolveMode => {
  switch (reason) {
    case 'ambiguous_multiple_open':
      return 'split';
    case 'no_open_assignment':
    case 'currency_mismatch':
      return 'other';
    default:
      return 'assign';
  }
};

/**
 * The four-mode resolve dialog (design §3.6). Always-mounted, driven by `open={txId !== null}`
 * with the target frozen so the closing animation never blanks (AGENTS.md "Dialogs Must Be
 * Always-Mounted").
 *
 * Note on scope: `MatchBankTransactionRequest` carries only `allocations` — there is no
 * client-editable note field on the wire (the payment `note`, incl. the overpayment sentence,
 * is written server-side, D5/§3.6.1). The consequence sentence is therefore rendered as
 * information, not as an editable input.
 */
export function MatchTransactionDialog({
  teamId,
  txId,
  onCancel,
  onResolved,
}: MatchTransactionDialogProps) {
  const run = useRun();
  const txIdRef = React.useRef<string | null>(null);
  if (txId !== null) txIdRef.current = txId;
  const shownTxId = txId ?? txIdRef.current;

  const [detail, setDetail] = React.useState<BankSyncApi.BankTransactionDetailView | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [mode, setMode] = React.useState<ResolveMode>('assign');
  const [selectedAssignmentId, setSelectedAssignmentId] = React.useState('');
  const [amountStr, setAmountStr] = React.useState('');
  const [overpayChoice, setOverpayChoice] = React.useState<'full' | 'split' | null>(null);
  const [splitRows, setSplitRows] = React.useState<
    ReadonlyArray<{ assignmentId: string; amountStr: string }>
  >([]);
  const [otherDescription, setOtherDescription] = React.useState('');
  const [ignoreReason, setIgnoreReason] = React.useState('');
  const [error, setError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (txId === null) return;
    let cancelled = false;
    setLoading(true);
    setDetail(null);
    setError(null);
    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const txIdBranded = Schema.decodeSync(BankTransaction.BankTransactionId)(txId);
    void (async () => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.getBankTransaction({ params: { teamId: teamIdBranded, txId: txIdBranded } }),
        ),
        Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
        run({}),
      );
      if (cancelled) return;
      setLoading(false);
      if (Option.isSome(result)) {
        const d = result.value;
        setDetail(d);
        setMode(defaultModeFor(Option.getOrNull(d.matchReason)));
        setOverpayChoice(null);
        setOtherDescription('');
        setIgnoreReason(
          Option.isSome(d.duplicateOfTransactionId)
            ? tr('bank_resolve_ignoreDuplicateReason', { date: '' })
            : '',
        );
        if (d.candidateAssignments.length === 1) {
          setSelectedAssignmentId(d.candidateAssignments[0].assignmentId);
        } else {
          setSelectedAssignmentId('');
        }
        setSplitRows([]);
        setAmountStr('');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [txId, teamId, run]);

  const selectedCandidate = detail?.candidateAssignments.find(
    (c) => c.assignmentId === selectedAssignmentId,
  );
  const txAmountMinor = detail ? Math.abs(Number(detail.amountMinor)) : 0;
  const isOverpayment =
    selectedCandidate !== undefined && txAmountMinor > selectedCandidate.outstandingMinor;

  const handleSubmitAssign = async () => {
    if (!detail || !selectedCandidate) return;
    let amountMinor: number;
    if (isOverpayment) {
      if (overpayChoice !== 'full') {
        setError(tr('bank_resolve_overChoose'));
        return;
      }
      amountMinor = txAmountMinor;
    } else {
      try {
        amountMinor =
          amountStr.trim() === ''
            ? Math.min(txAmountMinor, selectedCandidate.outstandingMinor)
            : parseAmount(amountStr, detail.currency);
      } catch {
        setError(tr('bank_resolve_error'));
        return;
      }
    }
    await submitMatch([
      {
        assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(
          selectedCandidate.assignmentId,
        ),
        amountMinor: Schema.decodeSync(Fee.AmountMinor)(amountMinor),
      },
    ]);
  };

  const handleSubmitSplit = async () => {
    if (!detail) return;
    const allocations: Array<{ assignmentId: string; amountMinor: number }> = [];
    for (const row of splitRows) {
      if (!row.assignmentId || !row.amountStr.trim()) continue;
      try {
        allocations.push({
          assignmentId: row.assignmentId,
          amountMinor: parseAmount(row.amountStr, detail.currency),
        });
      } catch {
        setError(tr('bank_resolve_error'));
        return;
      }
    }
    if (allocations.length === 0) {
      setError(tr('bank_resolve_error'));
      return;
    }
    const allocatedMinor = allocations.reduce((sum, a) => sum + a.amountMinor, 0);
    if (allocatedMinor !== txAmountMinor) {
      setError(
        tr('bank_resolve_splitRemaining', {
          remaining: formatMoney(txAmountMinor - allocatedMinor, detail.currency, 'en'),
        }),
      );
      return;
    }
    await submitMatch(
      allocations.map((a) => ({
        assignmentId: Schema.decodeSync(FeeAssignment.FeeAssignmentId)(a.assignmentId),
        amountMinor: Schema.decodeSync(Fee.AmountMinor)(a.amountMinor),
      })),
    );
  };

  const submitMatch = async (
    allocations: BankSyncApi.MatchBankTransactionRequest['allocations'],
  ) => {
    if (!shownTxId) return;
    setSubmitting(true);
    setError(null);
    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const txIdBranded = Schema.decodeSync(BankTransaction.BankTransactionId)(shownTxId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.matchBankTransaction({
          params: { teamId: teamIdBranded, txId: txIdBranded },
          payload: { allocations: [...allocations] },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      run({ success: tr('bank_resolve_success') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      onResolved();
    }
  };

  const handleSubmitIgnore = async (kind: 'other_income' | 'not_relevant', reason: string) => {
    if (!shownTxId || !reason.trim()) {
      setError(tr('bank_resolve_error'));
      return;
    }
    setSubmitting(true);
    setError(null);
    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const txIdBranded = Schema.decodeSync(BankTransaction.BankTransactionId)(shownTxId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.ignoreBankTransaction({
          params: { teamId: teamIdBranded, txId: txIdBranded },
          payload: { kind, reason: reason.trim() },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      run({ success: tr('bank_resolve_success') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      onResolved();
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'assign') await handleSubmitAssign();
    else if (mode === 'split') await handleSubmitSplit();
    else if (mode === 'other') await handleSubmitIgnore('other_income', otherDescription);
    else await handleSubmitIgnore('not_relevant', ignoreReason);
  };

  const addSplitRow = () => {
    const used = new Set(splitRows.map((r) => r.assignmentId));
    const next = detail?.candidateAssignments.find((c) => !used.has(c.assignmentId));
    if (!next) return;
    setSplitRows((prev) => [...prev, { assignmentId: next.assignmentId, amountStr: '' }]);
  };

  const splitTotal = splitRows.reduce((sum, r) => {
    const n = Number(r.amountStr.replace(',', '.'));
    return sum + (Number.isFinite(n) ? Math.round(n * 100) : 0);
  }, 0);
  const splitTarget = txAmountMinor;

  return (
    <Dialog
      open={txId !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent aria-describedby={undefined} className='max-w-lg'>
        <DialogHeader>
          <DialogTitle>
            {tr('bank_resolve_title')}
            {detail ? ` · ${formatMoney(txAmountMinor, detail.currency, 'en')}` : ''}
          </DialogTitle>
        </DialogHeader>

        {loading || !detail ? (
          <p className='text-sm text-muted-foreground'>{tr('loading_text')}</p>
        ) : (
          <form onSubmit={handleSubmit} className='flex flex-col gap-4'>
            <fieldset className='flex flex-col gap-2 border-0 p-0 m-0'>
              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='resolve-mode'
                  checked={mode === 'assign'}
                  onChange={() => setMode('assign')}
                  disabled={detail.candidateAssignments.length === 0}
                />
                {tr('bank_resolve_modeAssign')}
              </label>
              {mode === 'assign' && (
                <div className='pl-6 flex flex-col gap-2'>
                  <Label htmlFor='resolve-assignment'>{tr('bank_resolve_fee')}</Label>
                  <select
                    id='resolve-assignment'
                    className='border rounded-md h-9 px-2 text-sm bg-background'
                    value={selectedAssignmentId}
                    onChange={(e) => setSelectedAssignmentId(e.target.value)}
                  >
                    <option value='' disabled>
                      —
                    </option>
                    {detail.candidateAssignments.map((c) => (
                      <option key={c.assignmentId} value={c.assignmentId}>
                        {tr('bank_resolve_feeOption', {
                          fee: c.feeName,
                          remaining: formatMoney(c.outstandingMinor, c.currency, 'en'),
                        })}
                      </option>
                    ))}
                  </select>

                  {selectedCandidate && !isOverpayment && (
                    <div>
                      <Label htmlFor='resolve-amount'>{tr('bank_col_amount')}</Label>
                      <Input
                        id='resolve-amount'
                        inputMode='decimal'
                        value={amountStr}
                        placeholder={String(
                          Math.min(txAmountMinor, selectedCandidate.outstandingMinor) / 100,
                        )}
                        onChange={(e) => setAmountStr(e.target.value)}
                      />
                    </div>
                  )}

                  {selectedCandidate && isOverpayment && (
                    <div className='flex flex-col gap-2 rounded-md border p-3'>
                      <p className='text-sm font-medium'>{tr('bank_resolve_overTitle')}</p>
                      <label className='flex items-start gap-2 text-sm cursor-pointer'>
                        <input
                          type='radio'
                          name='overpay-choice'
                          checked={overpayChoice === 'full'}
                          onChange={() => setOverpayChoice('full')}
                        />
                        <span>
                          {tr('bank_resolve_overFull', {
                            amount: formatMoney(txAmountMinor, detail.currency, 'en'),
                          })}
                          <br />
                          <span className='text-xs text-muted-foreground'>
                            {tr('bank_resolve_overFullHint', {
                              fee: selectedCandidate.feeName,
                              diff: formatMoney(
                                txAmountMinor - selectedCandidate.outstandingMinor,
                                detail.currency,
                                'en',
                              ),
                            })}
                          </span>
                        </span>
                      </label>
                      <label className='flex items-center gap-2 text-sm cursor-pointer'>
                        <input
                          type='radio'
                          name='overpay-choice'
                          checked={overpayChoice === 'split'}
                          onChange={() => {
                            setOverpayChoice('split');
                            setMode('split');
                          }}
                        />
                        {tr('bank_resolve_overSplit')}
                      </label>
                    </div>
                  )}
                </div>
              )}

              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='resolve-mode'
                  checked={mode === 'split'}
                  onChange={() => setMode('split')}
                  disabled={detail.candidateAssignments.length === 0}
                />
                {tr('bank_resolve_modeSplit')}
              </label>
              {mode === 'split' && (
                <div className='pl-6 flex flex-col gap-2'>
                  {splitRows.map((row, i) => {
                    const candidate = detail.candidateAssignments.find(
                      (c) => c.assignmentId === row.assignmentId,
                    );
                    return (
                      <div key={row.assignmentId} className='flex items-center gap-2'>
                        <span className='text-sm flex-1 truncate'>{candidate?.feeName}</span>
                        <Input
                          inputMode='decimal'
                          className='w-24'
                          value={row.amountStr}
                          onChange={(e) => {
                            const v = e.target.value;
                            setSplitRows((prev) =>
                              prev.map((r, idx) => (idx === i ? { ...r, amountStr: v } : r)),
                            );
                          }}
                        />
                        <button
                          type='button'
                          onClick={() => setSplitRows((prev) => prev.filter((_, idx) => idx !== i))}
                          aria-label={tr('common_cancel')}
                        >
                          <X className='size-3' aria-hidden='true' />
                        </button>
                      </div>
                    );
                  })}
                  <button
                    type='button'
                    onClick={addSplitRow}
                    className='inline-flex items-center gap-1 text-xs underline self-start'
                  >
                    <Plus className='size-3' aria-hidden='true' />
                    {tr('bank_resolve_splitAdd')}
                  </button>
                  <p aria-live='polite' className='text-xs text-muted-foreground'>
                    {splitTotal === splitTarget
                      ? tr('bank_resolve_splitBalanced', {
                          allocated: formatMoney(splitTotal, detail.currency, 'en'),
                          total: formatMoney(splitTarget, detail.currency, 'en'),
                        })
                      : tr('bank_resolve_splitRemaining', {
                          remaining: formatMoney(splitTarget - splitTotal, detail.currency, 'en'),
                        })}
                  </p>
                </div>
              )}

              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='resolve-mode'
                  checked={mode === 'other'}
                  onChange={() => setMode('other')}
                />
                {tr('bank_resolve_modeOther')}
              </label>
              {mode === 'other' && (
                <div className='pl-6'>
                  <Label htmlFor='resolve-other-description'>
                    {tr('bank_resolve_otherDescription')}
                  </Label>
                  <Input
                    id='resolve-other-description'
                    value={otherDescription}
                    onChange={(e) => setOtherDescription(e.target.value)}
                  />
                </div>
              )}

              <label className='flex items-center gap-2 text-sm cursor-pointer'>
                <input
                  type='radio'
                  name='resolve-mode'
                  checked={mode === 'ignore'}
                  onChange={() => setMode('ignore')}
                />
                {tr('bank_resolve_modeIgnore')}
              </label>
              {mode === 'ignore' && (
                <div className='pl-6'>
                  <Label htmlFor='resolve-ignore-reason'>{tr('bank_resolve_ignoreReason')}</Label>
                  <Textarea
                    id='resolve-ignore-reason'
                    value={ignoreReason}
                    onChange={(e) => setIgnoreReason(e.target.value)}
                  />
                </div>
              )}
            </fieldset>

            {error && <p className='text-sm text-destructive'>{error}</p>}

            <DialogFooter>
              <Button type='button' variant='outline' onClick={onCancel}>
                {tr('common_cancel')}
              </Button>
              <Button type='submit' disabled={submitting}>
                {tr('bank_resolve_submit')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
