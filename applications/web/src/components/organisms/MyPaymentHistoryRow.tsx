import { Fee, Team } from '@sideline/domain';
import { useQuery } from '@tanstack/react-query';
import { DateTime, Effect, Option, Schema } from 'effect';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type PaymentView = {
  paymentId: string;
  feeAssignmentId: string;
  teamMemberId: string;
  memberName: Option.Option<string>;
  amountMinor: number;
  method: string;
  paidAt: DateTime.Utc;
  note: Option.Option<string>;
  recorderName: Option.Option<string>;
  voidedAt: Option.Option<DateTime.Utc>;
  voidReason: Option.Option<string>;
};

interface MyPaymentHistoryRowProps {
  teamId: string;
  feeId: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function MyPaymentHistoryRow({ teamId, feeId, currency }: MyPaymentHistoryRowProps) {
  const run = useRun();

  const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
  const decodedFeeId = Schema.decodeSync(Fee.FeeId)(feeId);

  const { data, isLoading, isError } = useQuery<ReadonlyArray<PaymentView>>({
    queryKey: ['myPaymentHistory', teamId, feeId],
    queryFn: async () => {
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.finance.myPaymentHistory({
            params: { teamId: decodedTeamId },
            query: { feeId: Option.some(decodedFeeId) },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('my_payments_history_error'))),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
  });

  if (isLoading) {
    return (
      <div
        data-testid='payment-history-loading'
        className='px-4 py-3 text-sm text-muted-foreground'
      >
        {tr('my_payments_history_loading')}
      </div>
    );
  }

  if (isError) {
    return (
      <div className='px-4 py-3 text-sm text-destructive'>{tr('my_payments_history_error')}</div>
    );
  }

  const list: ReadonlyArray<PaymentView> = data ?? [];

  if (list.length === 0) {
    return (
      <div className='px-4 py-3 text-sm text-muted-foreground'>
        {tr('my_payments_history_empty')}
      </div>
    );
  }

  return (
    <div className='divide-y'>
      {list.map((payment) => {
        const isVoided = Option.isSome(payment.voidedAt);
        return (
          <div
            key={payment.paymentId}
            data-voided={isVoided ? 'true' : 'false'}
            className={`flex items-center justify-between gap-3 px-4 py-3 ${isVoided ? 'opacity-60' : ''}`}
          >
            <div className='flex-1 min-w-0'>
              <div className={`flex items-center gap-2 ${isVoided ? 'line-through' : ''}`}>
                <span className='text-sm font-medium'>
                  {formatMoney(payment.amountMinor, currency, 'en')}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {new Date(Number(DateTime.toEpochMillis(payment.paidAt))).toLocaleDateString()}
                </span>
                <span className='text-xs text-muted-foreground'>
                  {tr(`finance_payment_method_${payment.method}`)}
                </span>
              </div>
              <div className='text-xs text-muted-foreground mt-0.5'>
                {tr('my_payments_history_recordedBy', {
                  name: Option.match(payment.recorderName, {
                    onSome: (name) => name,
                    onNone: () => '—',
                  }),
                })}
              </div>
            </div>
            {isVoided && (
              <span className='shrink-0 inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground'>
                {tr('my_payments_history_voided')}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
