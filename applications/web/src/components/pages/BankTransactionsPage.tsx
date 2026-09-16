import type { BankSyncApi } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { AlertTriangle, CheckCircle2, Landmark } from 'lucide-react';
import React from 'react';
import { BackfillDialog } from '~/components/organisms/bank/BackfillDialog';
import { BankExportPanel } from '~/components/organisms/bank/BankExportPanel';
import { MatchedList } from '~/components/organisms/bank/MatchedList';
import { UnmatchedQueue } from '~/components/organisms/bank/UnmatchedQueue';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { formatMoney } from '~/lib/finance/formatMoney.js';
import { tr } from '~/lib/translations.js';

export type BankTab = 'queue' | 'matched' | 'export';

interface BankTransactionsPageProps {
  readonly teamId: string;
  readonly config: BankSyncApi.BankSyncConfigView | null;
  readonly summary: BankSyncApi.BankSyncSummaryView | null;
  readonly transactions: ReadonlyArray<BankSyncApi.BankTransactionView>;
  readonly activeTab?: BankTab;
  readonly onTabChange?: (tab: BankTab) => void;
  readonly onRefresh: () => void;
  readonly onStartBackfill: (from: string, to: string) => Promise<void>;
}

function KpiCard({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <Card className='py-4 gap-2'>
      <CardContent className='px-4'>
        <p className='text-xs text-muted-foreground mb-1'>{label}</p>
        <p className='text-xl font-bold tracking-tight tabular-nums'>{value}</p>
      </CardContent>
    </Card>
  );
}

export function BankTransactionsPage({
  teamId,
  config,
  summary,
  transactions,
  activeTab: controlledActiveTab,
  onTabChange,
  onRefresh,
  onStartBackfill,
}: BankTransactionsPageProps) {
  const [internalActiveTab, setInternalActiveTab] = React.useState<BankTab>('queue');
  const isControlled = controlledActiveTab !== undefined && onTabChange !== undefined;
  const activeTab = isControlled ? controlledActiveTab : internalActiveTab;
  const [backfillOpen, setBackfillOpen] = React.useState(false);
  const [backfillRange, setBackfillRange] = React.useState<{ from: string; to: string } | null>(
    null,
  );

  const handleTabChange = (tab: BankTab) => {
    if (isControlled) onTabChange(tab);
    else setInternalActiveTab(tab);
  };

  const queueTransactions = transactions.filter(
    (t) => t.matchState === 'unmatched' || t.matchState === 'partially_matched',
  );
  const unmatchedAmountMinor = queueTransactions.reduce(
    (sum, t) => sum + Math.abs(Number(t.amountMinor)),
    0,
  );
  const unmatchedCurrency = queueTransactions[0]?.currency ?? 'CZK';
  const matchedTransactions = transactions.filter(
    (t) => t.matchState !== 'unmatched' && t.matchState !== 'partially_matched',
  );

  const notConnected = config === null || config.status === 'not_connected';
  const expiringSoon = config?.expiringSoon === true;
  const tokenInvalid = config?.status === 'invalid' || config?.status === 'sync_failing';
  const missingVsCount = summary?.membersWithoutVsCount ?? 0;
  const oldestPendingDays =
    summary && Option.isSome(summary.oldestPendingBookedOn)
      ? Math.floor(
          (Date.now() - new Date(summary.oldestPendingBookedOn.value).getTime()) /
            (24 * 60 * 60 * 1000),
        )
      : 0;

  return (
    <div className='flex flex-col gap-4'>
      <div>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <div className='flex items-center gap-2'>
          <Landmark className='size-5 text-muted-foreground' />
          <h1 className='text-2xl font-bold'>{tr('bank_pageTitle')}</h1>
        </div>
      </div>

      {(expiringSoon || tokenInvalid) && (
        <Alert variant={tokenInvalid ? 'destructive' : 'warning'}>
          <AlertTriangle aria-hidden='true' />
          <AlertTitle>
            {tokenInvalid
              ? tr('fio_status_invalidTitle')
              : tr('fio_status_expiringTitle', { days: 0 })}
          </AlertTitle>
          <AlertDescription>
            <Link to='/teams/$teamId/settings' params={{ teamId }} className='underline'>
              {tr('bank_export_openSettings')}
            </Link>
          </AlertDescription>
        </Alert>
      )}

      {missingVsCount > 0 && (
        <Alert variant='warning'>
          <AlertTriangle aria-hidden='true' />
          <AlertTitle>{tr('members_vs_bannerTitle', { count: missingVsCount })}</AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            <p>{tr('members_vs_bannerBody')}</p>
            <Button asChild variant='outline' size='sm' className='self-start'>
              <Link to='/teams/$teamId/members' params={{ teamId }}>
                {tr('members_vs_bannerAssign')}
              </Link>
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {oldestPendingDays > 85 && (
        <Alert variant='default'>
          <AlertDescription>{tr('bank_oldMovementsHint')}</AlertDescription>
        </Alert>
      )}

      {notConnected ? (
        <div className='flex flex-col items-center gap-3 py-16 text-center'>
          <p className='text-muted-foreground'>{tr('bank_notConnectedTitle')}</p>
          <Button asChild>
            <Link to='/teams/$teamId/settings' params={{ teamId }}>
              {tr('bank_notConnectedCta')}
            </Link>
          </Button>
        </div>
      ) : (
        <>
          {summary && (
            <div className='grid grid-cols-2 gap-3 sm:grid-cols-4'>
              <KpiCard label={tr('bank_kpi_waiting')} value={String(summary.pendingCount)} />
              <KpiCard
                label={tr('bank_kpi_unmatchedAmount')}
                value={formatMoney(unmatchedAmountMinor, unmatchedCurrency, 'en')}
              />
              <KpiCard
                label={tr('bank_kpi_matchedRatio')}
                value={`${String(summary.matchedCount)} / ${String(summary.importedCount)}`}
              />
              <KpiCard
                label={tr('bank_kpi_membersWithoutVs')}
                value={String(summary.membersWithoutVsCount)}
              />
            </div>
          )}

          <div className='flex border-b' role='tablist'>
            <Button
              type='button'
              role='tab'
              variant={activeTab === 'queue' ? 'secondary' : 'ghost'}
              aria-selected={activeTab === 'queue'}
              onClick={() => handleTabChange('queue')}
              className={`rounded-none border-b-2 -mb-px transition-colors ${
                activeTab === 'queue' ? 'border-primary' : 'border-transparent'
              }`}
            >
              {tr('bank_tab_queue')} ({queueTransactions.length})
            </Button>
            <Button
              type='button'
              role='tab'
              variant={activeTab === 'matched' ? 'secondary' : 'ghost'}
              aria-selected={activeTab === 'matched'}
              onClick={() => handleTabChange('matched')}
              className={`rounded-none border-b-2 -mb-px transition-colors ${
                activeTab === 'matched' ? 'border-primary' : 'border-transparent'
              }`}
            >
              {tr('bank_tab_matched')}
            </Button>
            <Button
              type='button'
              role='tab'
              variant={activeTab === 'export' ? 'secondary' : 'ghost'}
              aria-selected={activeTab === 'export'}
              onClick={() => handleTabChange('export')}
              className={`rounded-none border-b-2 -mb-px transition-colors ${
                activeTab === 'export' ? 'border-primary' : 'border-transparent'
              }`}
            >
              {tr('bank_tab_export')}
            </Button>
          </div>

          {activeTab === 'queue' &&
            (queueTransactions.length === 0 ? (
              <div className='flex flex-col items-center gap-2 py-16 text-center'>
                <CheckCircle2 className='size-10 text-green-600' aria-hidden='true' />
                <p className='text-lg font-medium'>{tr('bank_empty_title')}</p>
                {summary && (
                  <p className='text-sm text-muted-foreground'>
                    {tr('bank_empty_stats', {
                      auto: summary.autoMatchedLast30d,
                      total: summary.autoMatchedLast30d + summary.manuallyMatchedLast30d,
                    })}
                  </p>
                )}
                <Button variant='outline' size='sm' onClick={() => handleTabChange('matched')}>
                  {tr('bank_empty_showMatched')}
                </Button>
              </div>
            ) : (
              <UnmatchedQueue
                teamId={teamId}
                transactions={queueTransactions}
                onResolved={onRefresh}
              />
            ))}

          {activeTab === 'matched' && (
            <MatchedList teamId={teamId} transactions={matchedTransactions} onChanged={onRefresh} />
          )}

          {activeTab === 'export' && (
            <BankExportPanel
              teamId={teamId}
              summary={summary}
              onOpenBackfill={(from, to) => {
                setBackfillRange({ from, to });
                setBackfillOpen(true);
              }}
            />
          )}
        </>
      )}

      <BackfillDialog
        open={backfillOpen}
        onOpenChange={setBackfillOpen}
        onStart={(from, to) => {
          setBackfillOpen(false);
          void onStartBackfill(from, to);
        }}
        starting={false}
        backfillStatus={config ? Option.getOrNull(config.backfillStatus) : null}
        initialFrom={backfillRange?.from}
        initialTo={backfillRange?.to}
      />
    </div>
  );
}
