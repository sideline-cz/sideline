import { Fee, type FinanceApi, MemberCredit, Team, TeamMember } from '@sideline/domain';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DateTime, Effect, Option, Schema } from 'effect';
import React from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import { Label } from '~/components/ui/label';
import { Popover, PopoverContent, PopoverTrigger } from '~/components/ui/popover';
import { Textarea } from '~/components/ui/textarea';
import { formatLocalDate } from '~/lib/datetime.js';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { paymentMethodLabel } from '~/lib/finance/paymentMethodLabels.js';
import { ApiClient, ClientError, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type DepositRow = FinanceApi.MemberCreditDepositView;

interface MemberCreditPopoverProps {
  teamId: string;
  teamMemberId: string;
  memberName?: string;
  currency: string;
  /** The member's current balance in this currency — already known from the overview row, so
   * the popover never needs a separate fetch just to render "Balance". */
  balanceMinor: number;
  /** Gates the void ("Cancel") button on every unvoided row. The list itself only needs
   * finance:view, which is a precondition of seeing this page at all. */
  canRecordPayments: boolean;
  /** Called after a successful void so the parent can refetch the overview (the balance shown
   * on the row and the badge that triggers this popover both come from that loader data). */
  onVoided?: () => void;
}

// ---------------------------------------------------------------------------
// Void confirm control — one AlertDialog per deposit row, self-contained per
// "Confirm Before Destructive Actions" (AGENTS.md).
// ---------------------------------------------------------------------------

function VoidDepositControl({
  deposit,
  currency,
  onConfirm,
}: {
  deposit: DepositRow;
  currency: string;
  onConfirm: (depositId: string, reason: string) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState('');
  const [reasonError, setReasonError] = React.useState('');

  const handleOpenChange = (next: boolean) => {
    setOpen(next);
    if (!next) {
      setReason('');
      setReasonError('');
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type='button' variant='ghost' size='sm'>
          {tr('finance_credit_void_action')}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{tr('finance_credit_void_title')}</AlertDialogTitle>
          <AlertDialogDescription>
            {formatMoney(deposit.amountMinor, currency, 'en')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className='flex flex-col gap-1.5'>
          <Label htmlFor={`credit-void-reason-${deposit.depositId}`}>
            {tr('finance_credit_void_reason')}
          </Label>
          <Textarea
            id={`credit-void-reason-${deposit.depositId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          {reasonError && <p className='text-sm text-destructive'>{reasonError}</p>}
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{tr('payment_record_cancel')}</AlertDialogCancel>
          <AlertDialogAction
            onClick={(e) => {
              const trimmed = reason.trim();
              if (!trimmed) {
                e.preventDefault();
                setReasonError(tr('waive_dialog_validation_reasonRequired'));
                return;
              }
              onConfirm(deposit.depositId, trimmed);
            }}
          >
            {tr('finance_credit_void_action')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MemberCreditPopover({
  teamId,
  teamMemberId,
  memberName,
  currency,
  balanceMinor,
  canRecordPayments,
  onVoided,
}: MemberCreditPopoverProps) {
  const run = useRun();
  const queryClient = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [spentError, setSpentError] = React.useState<string | null>(null);

  const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
  const decodedMemberId = Schema.decodeSync(TeamMember.TeamMemberId)(teamMemberId);
  const decodedCurrency = Schema.decodeSync(Fee.CurrencyCode)(currency);

  const queryKey = ['memberCreditDeposits', teamId, teamMemberId, currency];

  const { data, isLoading, isError } = useQuery<ReadonlyArray<DepositRow>>({
    queryKey,
    enabled: open,
    queryFn: async () => {
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.finance.listMemberCreditDeposits({
            params: { teamId: decodedTeamId, memberId: decodedMemberId },
            query: { currency: decodedCurrency, includeVoided: Option.some(true) },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('finance_error_loadFailed'))),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
  });

  const handleVoid = async (depositId: string, reason: string) => {
    setSpentError(null);
    const decodedDepositId = Schema.decodeSync(MemberCredit.MemberCreditDepositId)(depositId);
    const payload: FinanceApi.VoidCreditDepositRequest = { reason };
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.finance.voidCreditDeposit({
          params: { teamId: decodedTeamId, memberId: decodedMemberId, depositId: decodedDepositId },
          payload,
        }),
      ),
      Effect.tapError((err) =>
        Effect.sync(() => {
          if (err._tag === 'CreditDepositSpent') {
            setSpentError(tr('finance_credit_void_spent'));
          }
        }),
      ),
      Effect.mapError((err) =>
        err._tag === 'CreditDepositSpent'
          ? new SilentClientError({ message: tr('finance_credit_void_spent') })
          : ClientError.make(tr('finance_error_loadFailed')),
      ),
      run({ success: tr('finance_credit_void_success') }),
    );
    if (Option.isSome(result)) {
      queryClient.invalidateQueries({ queryKey });
      onVoided?.();
    }
  };

  // Newest first — the server has no ordering guarantee, so sort client-side.
  const deposits = [...(data ?? [])].sort(
    (a, b) => Number(DateTime.toEpochMillis(b.paidAt)) - Number(DateTime.toEpochMillis(a.paidAt)),
  );

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setSpentError(null);
      }}
    >
      <PopoverTrigger asChild>
        <button
          type='button'
          className='text-xs font-medium text-emerald-700 hover:underline dark:text-emerald-400'
        >
          {tr('finance_credit_rowBadge', { amount: formatMoney(balanceMinor, currency, 'en') })}
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className='w-80'>
        <div className='flex flex-col gap-3'>
          <p className='font-medium'>
            {tr('finance_credit_popover_title', { member: memberName ?? '—', currency })}
          </p>
          <div className='flex items-center justify-between text-sm'>
            <span className='text-muted-foreground'>{tr('finance_credit_popover_balance')}</span>
            <span className='font-semibold tabular-nums'>
              {formatMoney(balanceMinor, currency, 'en')}
            </span>
          </div>

          {spentError && <p className='text-sm text-destructive'>{spentError}</p>}

          {isLoading && <p className='text-sm text-muted-foreground'>{tr('loading_text')}</p>}
          {isError && <p className='text-sm text-destructive'>{tr('finance_error_loadFailed')}</p>}
          {!isLoading && !isError && deposits.length === 0 && (
            <p className='text-sm text-muted-foreground'>{tr('finance_credit_popover_empty')}</p>
          )}

          {!isLoading && !isError && deposits.length > 0 && (
            <ul className='flex flex-col gap-2'>
              {deposits.map((deposit) => {
                const isVoided = Option.isSome(deposit.voidedAt);
                return (
                  <li
                    key={deposit.depositId}
                    data-voided={isVoided ? 'true' : 'false'}
                    className={`flex items-center justify-between gap-2 text-sm ${isVoided ? 'opacity-60' : ''}`}
                  >
                    <div className={`min-w-0 ${isVoided ? 'line-through' : ''}`}>
                      <div className='truncate'>
                        {formatLocalDate(deposit.paidAt)} · {paymentMethodLabel(deposit.method)}
                        {Option.match(deposit.recorderName, {
                          onNone: () => '',
                          onSome: (name) => ` · ${name}`,
                        })}
                        {isVoided ? ` (${tr('my_payments_history_voided')})` : ''}
                      </div>
                    </div>
                    <div className='flex shrink-0 items-center gap-2'>
                      <span className='tabular-nums'>
                        {formatMoney(deposit.amountMinor, currency, 'en')}
                      </span>
                      {canRecordPayments && !isVoided && (
                        <VoidDepositControl
                          deposit={deposit}
                          currency={currency}
                          onConfirm={handleVoid}
                        />
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
