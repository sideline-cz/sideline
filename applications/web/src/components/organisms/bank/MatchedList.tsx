import type { BankSyncApi } from '@sideline/domain';
import { BankTransaction, Team } from '@sideline/domain';
import { useQuery } from '@tanstack/react-query';
import { Effect, Option, Schema } from 'effect';
import { ChevronRight } from 'lucide-react';
import React from 'react';
import { UnmatchDialog } from '~/components/organisms/bank/UnmatchDialog';
import { Button } from '~/components/ui/button';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type MatchedFilter = 'all' | 'matched' | 'other_income' | 'ignored' | 'voided';

const FILTER_CHIPS: ReadonlyArray<{ value: MatchedFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'bank_matched_filterAll' },
  { value: 'matched', labelKey: 'bank_tab_matched' },
  { value: 'other_income', labelKey: 'bank_matched_filterOther' },
  { value: 'ignored', labelKey: 'bank_matched_filterIgnored' },
  { value: 'voided', labelKey: 'bank_matched_filterVoided' },
];

interface MatchedListProps {
  readonly teamId: string;
  readonly transactions: ReadonlyArray<BankSyncApi.BankTransactionView>;
  readonly onChanged: () => void;
}

/** The audit trail (design §3.10) — auto-matched transactions must not be invisible. */
export function MatchedList({ teamId, transactions, onChanged }: MatchedListProps) {
  const [filter, setFilter] = React.useState<MatchedFilter>('all');
  const [expanded, setExpanded] = React.useState<string | null>(null);
  const [unmatchTargetId, setUnmatchTargetId] = React.useState<string | null>(null);

  const filtered = transactions.filter((t) => {
    if (filter === 'all') return true;
    if (filter === 'matched')
      return t.matchState === 'matched' || t.matchState === 'partially_matched';
    if (filter === 'other_income') {
      return t.matchState === 'ignored' && Option.getOrNull(t.resolutionKind) === 'other_income';
    }
    if (filter === 'ignored') {
      return t.matchState === 'ignored' && Option.getOrNull(t.resolutionKind) === 'not_relevant';
    }
    return false;
  });

  if (transactions.length === 0) {
    return <p className='text-muted-foreground py-8 text-center'>{tr('bank_empty_noResults')}</p>;
  }

  return (
    <div className='flex flex-col gap-4'>
      <fieldset className='flex gap-1 flex-wrap border-0 m-0 p-0'>
        {FILTER_CHIPS.map((c) => (
          <button
            key={c.value}
            type='button'
            aria-pressed={filter === c.value}
            onClick={() => setFilter(c.value)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              filter === c.value
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            {tr(c.labelKey)}
          </button>
        ))}
      </fieldset>

      <div className='overflow-x-auto'>
        <table className='w-full text-sm'>
          <thead>
            <tr className='border-b'>
              <th className='w-8 py-2 px-3' />
              <th className='py-2 px-3 text-left font-medium'>{tr('bank_col_date')}</th>
              <th className='py-2 px-3 text-right font-medium'>{tr('bank_col_amount')}</th>
              <th className='py-2 px-3 text-left font-medium'>{tr('bank_col_counterparty')}</th>
              <th className='py-2 px-3 text-left font-medium'>{tr('finance_column_status')}</th>
              <th className='py-2 px-3' />
            </tr>
          </thead>
          <tbody>
            {filtered.map((t) => {
              const isExpanded = expanded === t.id;
              const amountLabel = formatMoney(Math.abs(Number(t.amountMinor)), t.currency, 'en');
              return (
                <React.Fragment key={t.id}>
                  <tr className='border-b hover:bg-muted/50'>
                    <td className='py-2 px-3'>
                      <button
                        type='button'
                        aria-expanded={isExpanded}
                        aria-controls={`matched-detail-${t.id}`}
                        onClick={() => setExpanded(isExpanded ? null : t.id)}
                        className='flex items-center justify-center size-6 rounded hover:bg-muted transition-colors'
                      >
                        <ChevronRight
                          className={`size-4 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                          aria-hidden='true'
                        />
                        <span className='sr-only'>{tr('bank_matched_toggle')}</span>
                      </button>
                    </td>
                    <td className='py-3 px-3 tabular-nums'>{t.bookedOn}</td>
                    <td className='py-3 px-3 text-right tabular-nums'>{amountLabel}</td>
                    <td className='py-3 px-3'>{Option.getOrElse(t.counterpartyName, () => '—')}</td>
                    <td className='py-3 px-3'>
                      {t.matchState === 'ignored'
                        ? Option.getOrNull(t.resolutionKind) === 'other_income'
                          ? tr('bank_matched_filterOther')
                          : tr('bank_matched_filterIgnored')
                        : Option.getOrElse(t.matchedMemberName, () => '—')}
                    </td>
                    <td className='py-3 px-3' />
                  </tr>
                  {isExpanded && (
                    <tr id={`matched-detail-${t.id}`}>
                      <td colSpan={6} className='bg-muted/30'>
                        <MatchedRowDetail
                          teamId={teamId}
                          txId={t.id}
                          onUnmatch={() => setUnmatchTargetId(t.id)}
                          onChanged={onChanged}
                        />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>

      <UnmatchTargetLoader
        teamId={teamId}
        txId={unmatchTargetId}
        onCancel={() => setUnmatchTargetId(null)}
        onUnmatched={() => {
          setUnmatchTargetId(null);
          onChanged();
        }}
      />
    </div>
  );
}

function MatchedRowDetail({
  teamId,
  txId,
  onUnmatch,
  onChanged,
}: {
  readonly teamId: string;
  readonly txId: string;
  readonly onUnmatch: () => void;
  readonly onChanged: () => void;
}) {
  const run = useRun();
  const [unignoring, setUnignoring] = React.useState(false);
  const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
  const decodedTxId = Schema.decodeSync(BankTransaction.BankTransactionId)(txId);

  const { data, isLoading } = useQuery<BankSyncApi.BankTransactionDetailView>({
    queryKey: ['bankTransactionDetail', teamId, txId],
    queryFn: async () => {
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.getBankTransaction({
            params: { teamId: decodedTeamId, txId: decodedTxId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
  });

  if (isLoading || !data) {
    return <p className='p-4 text-sm text-muted-foreground'>{tr('loading_text')}</p>;
  }

  const handleUnignore = async () => {
    setUnignoring(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.unignoreBankTransaction({
          params: { teamId: decodedTeamId, txId: decodedTxId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      run({ success: tr('bank_unignore_success') }),
    );
    setUnignoring(false);
    if (Option.isSome(result)) onChanged();
  };

  return (
    <div className='flex flex-col gap-2 p-4 text-sm'>
      {data.matchedPayments.map((p) => (
        <p key={p.paymentId}>
          {p.matchedBy === 'auto'
            ? tr('bank_matched_evidence', {
                date: p.recordedAt,
                vs: Option.getOrElse(data.variableSymbol, () => ''),
                member: Option.getOrElse(data.resolvedMemberName, () => ''),
                fee: p.feeName,
                amount: formatMoney(p.amountMinor, data.currency, 'en'),
              })
            : `${p.feeName} — ${formatMoney(p.amountMinor, data.currency, 'en')}`}
        </p>
      ))}
      {data.matchState === 'ignored' && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='self-start'
          disabled={unignoring}
          onClick={() => void handleUnignore()}
        >
          {tr('bank_unignore_confirm')}
        </Button>
      )}
      {data.matchState !== 'ignored' && (
        <Button
          type='button'
          variant='outline'
          size='sm'
          className='self-start'
          onClick={onUnmatch}
        >
          {tr('bank_unmatch_confirm')}
        </Button>
      )}
    </div>
  );
}

/** Loads the frozen unmatch target's display data lazily, then hands off to `UnmatchDialog`. */
function UnmatchTargetLoader({
  teamId,
  txId,
  onCancel,
  onUnmatched,
}: {
  readonly teamId: string;
  readonly txId: string | null;
  readonly onCancel: () => void;
  readonly onUnmatched: () => void;
}) {
  const run = useRun();
  const [detail, setDetail] = React.useState<BankSyncApi.BankTransactionDetailView | null>(null);
  const [submitting, setSubmitting] = React.useState(false);

  React.useEffect(() => {
    if (txId === null) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
    const decodedTxId = Schema.decodeSync(BankTransaction.BankTransactionId)(txId);
    void (async () => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.getBankTransaction({
            params: { teamId: decodedTeamId, txId: decodedTxId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
        run({}),
      );
      if (!cancelled && Option.isSome(result)) setDetail(result.value);
    })();
    return () => {
      cancelled = true;
    };
  }, [txId, teamId, run]);

  const handleConfirm = async (id: string, reason: string) => {
    setSubmitting(true);
    const decodedTeamId = Schema.decodeSync(Team.TeamId)(teamId);
    const decodedTxId = Schema.decodeSync(BankTransaction.BankTransactionId)(id);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.unmatchBankTransaction({
          params: { teamId: decodedTeamId, txId: decodedTxId },
          payload: { reason },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      run({ success: tr('bank_unmatch_success') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) onUnmatched();
  };

  const target =
    txId !== null && detail
      ? {
          txId,
          amountLabel: formatMoney(Math.abs(Number(detail.amountMinor)), detail.currency, 'en'),
          dateLabel: detail.bookedOn,
          feeName: detail.matchedPayments[0]?.feeName ?? '',
          memberName: Option.getOrElse(detail.resolvedMemberName, () => ''),
        }
      : null;

  return (
    <UnmatchDialog
      target={target}
      onCancel={onCancel}
      onConfirm={handleConfirm}
      submitting={submitting}
    />
  );
}
