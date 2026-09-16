import type { BankSyncApi } from '@sideline/domain';
import { BankTransaction, Team } from '@sideline/domain';
import { useQuery } from '@tanstack/react-query';
import { Effect, Option, Schema } from 'effect';
import { MoreHorizontal } from 'lucide-react';
import React from 'react';
import { MatchTransactionDialog } from '~/components/organisms/MatchTransactionDialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Button } from '~/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '~/components/ui/dropdown-menu';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet';
import { Textarea } from '~/components/ui/textarea';
import { copyToClipboard } from '~/lib/clipboard';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { duplicateHint, matchReasonHint } from '~/lib/finance/matchReasons.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { MatchReasonBadge } from '../../molecules/MatchReasonBadge';

type FilterChip = 'all' | 'noVs' | 'unknownVs' | 'amountMismatch' | 'ambiguous' | 'noOpen';

const FILTER_CHIPS: ReadonlyArray<{ value: FilterChip; labelKey: string }> = [
  { value: 'all', labelKey: 'finance_filter_all' },
  { value: 'noVs', labelKey: 'bank_filter_noVs' },
  { value: 'unknownVs', labelKey: 'bank_filter_unknownVs' },
  { value: 'amountMismatch', labelKey: 'bank_filter_amountMismatch' },
  { value: 'ambiguous', labelKey: 'bank_filter_ambiguous' },
  { value: 'noOpen', labelKey: 'bank_filter_noOpen' },
];

function matchesChip(
  reason: BankTransaction.BankTransactionMatchReason | null,
  chip: FilterChip,
): boolean {
  if (chip === 'all') return true;
  if (reason === null) return false;
  switch (chip) {
    case 'noVs':
      return reason === 'no_vs';
    case 'unknownVs':
      return reason === 'no_member_for_vs';
    case 'amountMismatch':
      return reason === 'amount_mismatch_under' || reason === 'overpayment';
    case 'ambiguous':
      return (
        reason === 'ambiguous_member' ||
        reason === 'ambiguous_multiple_exact' ||
        reason === 'ambiguous_multiple_open'
      );
    case 'noOpen':
      return reason === 'no_open_assignment' || reason === 'currency_mismatch';
    default:
      return true;
  }
}

interface UnmatchedQueueProps {
  readonly teamId: string;
  readonly transactions: ReadonlyArray<BankSyncApi.BankTransactionView>;
  readonly onResolved: () => void;
}

export function UnmatchedQueue({ teamId, transactions, onResolved }: UnmatchedQueueProps) {
  const run = useRun();
  const [search, setSearch] = React.useState('');
  const [chip, setChip] = React.useState<FilterChip>('all');
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(new Set());
  const [resolveTarget, setResolveTarget] = React.useState<string | null>(null);
  const [detailTargetId, setDetailTargetId] = React.useState<string | null>(null);
  const [bulkKind, setBulkKind] = React.useState<'other_income' | 'not_relevant' | null>(null);
  const [bulkReason, setBulkReason] = React.useState('');
  const [bulkSubmitting, setBulkSubmitting] = React.useState(false);

  const filtered = transactions.filter((t) => {
    if (!matchesChip(Option.getOrNull(t.matchReason), chip)) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    const name = Option.getOrElse(t.counterpartyName, () => '').toLowerCase();
    const memberName = Option.getOrElse(t.matchedMemberName, () => '').toLowerCase();
    const vs = Option.getOrElse(t.variableSymbol, () => '');
    const amount = String(Math.abs(Number(t.amountMinor)) / 100);
    return (
      name.includes(needle) ||
      memberName.includes(needle) ||
      vs.includes(needle) ||
      amount.includes(needle)
    );
  });

  const toggleSelected = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleIgnoreSingle = (txId: string, kind: 'other_income' | 'not_relevant') => {
    setBulkKind(kind);
    setSelected(new Set([txId]));
  };

  const handleBulkConfirm = async () => {
    if (!bulkKind || bulkReason.trim().length === 0 || selected.size === 0) return;
    setBulkSubmitting(true);
    const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.bulkResolveBankTransactions({
          params: { teamId: teamIdBranded },
          payload: {
            txIds: Array.from(selected, (id) =>
              Schema.decodeSync(BankTransaction.BankTransactionId)(id),
            ),
            kind: bulkKind,
            reason: bulkReason.trim(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      run({ success: tr('bank_resolve_success') }),
    );
    setBulkSubmitting(false);
    if (Option.isSome(result)) {
      setBulkKind(null);
      setBulkReason('');
      setSelected(new Set());
      onResolved();
    }
  };

  const handleCopyDetails = (t: BankSyncApi.BankTransactionView) => {
    const lines = [
      `${tr('bank_col_date')}: ${t.bookedOn}`,
      `${tr('bank_col_amount')}: ${formatMoney(Math.abs(Number(t.amountMinor)), t.currency, 'en')}`,
      `${tr('bank_col_counterparty')}: ${Option.getOrElse(t.counterpartyName, () => '—')}`,
      `${tr('bank_col_vs')}: ${Option.getOrElse(t.variableSymbol, () => '—')}`,
      `${tr('bank_col_message')}: ${Option.getOrElse(t.messageForRecipient, () => '—')}`,
    ];
    void copyToClipboard(lines.join('\n'));
  };

  if (transactions.length === 0) {
    return null;
  }

  return (
    <div className='flex flex-col gap-4'>
      <div className='flex flex-wrap gap-3 items-center'>
        <Input
          type='search'
          placeholder={tr('bank_searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='h-9 w-full sm:max-w-xs'
        />
        <fieldset className='flex gap-1 flex-wrap border-0 m-0 p-0'>
          {FILTER_CHIPS.map((c) => (
            <button
              key={c.value}
              type='button'
              aria-pressed={chip === c.value}
              onClick={() => setChip(c.value)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                chip === c.value
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background text-muted-foreground hover:bg-muted'
              }`}
            >
              {tr(c.labelKey)}
            </button>
          ))}
        </fieldset>
      </div>

      {filtered.length === 0 ? (
        <div className='flex flex-col items-center gap-3 py-12 text-center'>
          <p className='text-muted-foreground'>{tr('bank_empty_noResults')}</p>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => {
              setSearch('');
              setChip('all');
            }}
          >
            {tr('expenses_clearFilters')}
          </Button>
        </div>
      ) : (
        <div className='overflow-x-auto md:overflow-visible'>
          <table className='w-full text-sm'>
            <thead className='hidden md:table-header-group'>
              <tr className='border-b'>
                <th className='w-8 py-2 px-3'>
                  <span className='sr-only'>{tr('bank_select_all')}</span>
                </th>
                <th className='py-2 px-3 text-left font-medium'>{tr('bank_col_date')}</th>
                <th className='py-2 px-3 text-right font-medium'>{tr('bank_col_amount')}</th>
                <th className='py-2 px-3 text-left font-medium'>{tr('bank_col_counterparty')}</th>
                <th className='py-2 px-3 text-left font-medium'>{tr('bank_col_reason')}</th>
                <th className='py-2 px-3' />
              </tr>
            </thead>
            <tbody>
              {filtered.map((t) => {
                const reason = Option.getOrNull(t.matchReason);
                const amountLabel = formatMoney(Math.abs(Number(t.amountMinor)), t.currency, 'en');
                const hint = matchReasonHint({
                  matchReason: reason,
                  matchedMemberName: Option.getOrElse(
                    t.matchedMemberName,
                    () => null as string | null,
                  ),
                  variableSymbol: Option.getOrElse(t.variableSymbol, () => null as string | null),
                  duplicateOfTransactionId: Option.getOrElse(
                    t.duplicateOfTransactionId,
                    () => null as string | null,
                  ),
                });
                const dupHint = duplicateHint({
                  matchReason: reason,
                  matchedMemberName: null,
                  variableSymbol: null,
                  duplicateOfTransactionId: Option.getOrElse(
                    t.duplicateOfTransactionId,
                    () => null as string | null,
                  ),
                });

                return (
                  <tr
                    key={t.id}
                    className='flex flex-col gap-1 border-b p-3 md:table-row md:p-0 md:hover:bg-muted/50'
                  >
                    <td className='order-1 md:order-none md:table-cell md:py-3 md:px-3 md:align-top'>
                      <input
                        type='checkbox'
                        checked={selected.has(t.id)}
                        onChange={() => toggleSelected(t.id)}
                        aria-label={tr('bank_select_row', {
                          amount: amountLabel,
                          date: t.bookedOn,
                        })}
                        className='hidden md:inline-block'
                      />
                    </td>
                    {/* Reason first on mobile (design §4) */}
                    <td className='order-0 md:order-none md:table-cell md:py-3 md:px-3 md:align-top'>
                      {reason ? <MatchReasonBadge reason={reason} /> : null}
                      {hint && <p className='text-xs text-muted-foreground mt-1'>{hint}</p>}
                      {dupHint && (
                        <p className='text-xs text-muted-foreground mt-1'>
                          {dupHint}{' '}
                          <button
                            type='button'
                            className='underline'
                            onClick={() =>
                              Option.isSome(t.duplicateOfTransactionId) && setDetailTargetId(t.id)
                            }
                          >
                            {tr('bank_reason_duplicateShowOriginal')}
                          </button>
                        </p>
                      )}
                    </td>
                    <td className='order-2 md:order-none flex items-baseline justify-between md:table-cell md:py-3 md:px-3 md:text-right md:align-top'>
                      <span className='text-lg font-bold tabular-nums md:text-sm md:font-normal'>
                        {amountLabel}
                      </span>
                      <span className='text-muted-foreground md:hidden'>{t.bookedOn}</span>
                    </td>
                    <td className='hidden md:table-cell py-3 px-3 align-top tabular-nums'>
                      {t.bookedOn}
                    </td>
                    <td className='order-3 md:order-none md:table-cell md:py-3 md:px-3 md:align-top'>
                      <p>{Option.getOrElse(t.counterpartyName, () => '—')}</p>
                      <p className='text-xs text-muted-foreground'>
                        {Option.getOrElse(t.counterpartyAccount, () => '—')}
                      </p>
                      <p className='text-xs text-muted-foreground'>
                        {tr('bank_col_vs')}: {Option.getOrElse(t.variableSymbol, () => '—')} ·{' '}
                        {tr('bank_col_message')}:{' '}
                        {Option.getOrElse(t.messageForRecipient, () => '—')}
                      </p>
                    </td>
                    <td className='order-4 md:order-none flex items-center gap-2 md:table-cell md:py-3 md:px-3 md:align-top'>
                      <Button
                        type='button'
                        size='sm'
                        className='w-full md:w-auto min-h-11 md:min-h-0'
                        onClick={() => setResolveTarget(t.id)}
                      >
                        {tr('bank_action_assign')}
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            type='button'
                            variant='ghost'
                            size='icon'
                            className='size-11 md:size-8 shrink-0'
                          >
                            <MoreHorizontal className='size-4' aria-hidden='true' />
                            <span className='sr-only'>
                              {tr('bank_action_more', { amount: amountLabel, date: t.bookedOn })}
                            </span>
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align='end'>
                          <DropdownMenuItem onClick={() => setDetailTargetId(t.id)}>
                            {tr('bank_action_detail')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleIgnoreSingle(t.id, 'other_income')}
                          >
                            {tr('bank_action_otherIncome')}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleIgnoreSingle(t.id, 'not_relevant')}
                          >
                            {tr('bank_action_ignore')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleCopyDetails(t)}>
                            {tr('bank_action_copyDetails')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selected.size > 0 && (
        <section
          aria-label={tr('bank_bulk_regionLabel')}
          className='sticky bottom-0 flex items-center gap-3 rounded-md border bg-card p-3 shadow-sm'
        >
          <span aria-live='polite' className='text-sm'>
            {tr('bank_bulk_selected', { count: selected.size })}
          </span>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => setBulkKind('other_income')}
          >
            {tr('bank_action_otherIncome')}
          </Button>
          <Button
            type='button'
            variant='outline'
            size='sm'
            onClick={() => setBulkKind('not_relevant')}
          >
            {tr('bank_action_ignore')}
          </Button>
        </section>
      )}

      <MatchTransactionDialog
        teamId={teamId}
        txId={resolveTarget}
        onCancel={() => setResolveTarget(null)}
        onResolved={() => {
          setResolveTarget(null);
          onResolved();
        }}
      />

      <AlertDialog
        open={bulkKind !== null}
        onOpenChange={(open) => {
          if (!open) {
            setBulkKind(null);
            setBulkReason('');
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {bulkKind === 'other_income'
                ? tr('bank_bulk_otherIncomeTitle')
                : tr('bank_bulk_ignoreTitle')}
            </AlertDialogTitle>
          </AlertDialogHeader>
          <p className='text-sm text-muted-foreground'>
            {bulkKind === 'other_income'
              ? tr('bank_bulk_otherIncomeBody', { count: selected.size })
              : tr('bank_bulk_ignoreBody', { count: selected.size })}
          </p>
          <div className='flex flex-col gap-1.5'>
            <Label htmlFor='bulk-reason'>{tr('bank_resolve_ignoreReason')}</Label>
            <Textarea
              id='bulk-reason'
              value={bulkReason}
              onChange={(e) => setBulkReason(e.target.value)}
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={bulkSubmitting || bulkReason.trim().length === 0}
              onClick={handleBulkConfirm}
            >
              {bulkKind === 'other_income'
                ? tr('bank_action_otherIncome')
                : tr('bank_action_ignore')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <Sheet
        open={detailTargetId !== null}
        onOpenChange={(open) => !open && setDetailTargetId(null)}
      >
        <SheetContent>
          <SheetHeader>
            <SheetTitle>{tr('bank_detail_title')}</SheetTitle>
          </SheetHeader>
          <TransactionDetailSheetBody teamId={teamId} txId={detailTargetId} />
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** The row overflow menu's "Zobrazit detail pohybu" — every raw field Fio returned. */
function TransactionDetailSheetBody({
  teamId,
  txId,
}: {
  readonly teamId: string;
  readonly txId: string | null;
}) {
  const run = useRun();

  const { data, isLoading } = useQuery<BankSyncApi.BankTransactionDetailView | null>({
    queryKey: ['bankTransactionDetail', teamId, txId],
    enabled: txId !== null,
    queryFn: async () => {
      if (txId === null) return null;
      const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
      const txIdBranded = Schema.decodeSync(BankTransaction.BankTransactionId)(txId);
      const effect = ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.bankSync.getBankTransaction({ params: { teamId: teamIdBranded, txId: txIdBranded } }),
        ),
        Effect.mapError(() => ClientError.make(tr('bank_resolve_error'))),
      );
      const result = await run()(effect);
      return Option.getOrThrow(result);
    },
    retry: false,
    throwOnError: false,
  });

  if (txId === null) return null;
  if (isLoading || !data) {
    return <p className='p-4 text-sm text-muted-foreground'>{tr('loading_text')}</p>;
  }

  return (
    <div className='flex flex-col gap-2 p-4 text-sm'>
      <p>
        <strong>{tr('bank_col_date')}:</strong> {data.bookedOn}
      </p>
      <p>
        <strong>{tr('bank_col_amount')}:</strong>{' '}
        {formatMoney(Math.abs(Number(data.amountMinor)), data.currency, 'en')}
      </p>
      <p>
        <strong>{tr('bank_col_counterparty')}:</strong>{' '}
        {Option.getOrElse(data.counterpartyName, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_counterpartyBank')}:</strong>{' '}
        {Option.getOrElse(data.counterpartyBankName, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_bic')}:</strong>{' '}
        {Option.getOrElse(data.counterpartyBic, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_col_vs')}:</strong> {Option.getOrElse(data.variableSymbol, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_ks')}:</strong> {Option.getOrElse(data.constantSymbol, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_ss')}:</strong> {Option.getOrElse(data.specificSymbol, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_col_message')}:</strong>{' '}
        {Option.getOrElse(data.messageForRecipient, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_comment')}:</strong> {Option.getOrElse(data.comment, () => '—')}
      </p>
      <p>
        <strong>{tr('bank_detail_userIdentification')}:</strong>{' '}
        {Option.getOrElse(data.userIdentification, () => '—')}
      </p>
    </div>
  );
}
