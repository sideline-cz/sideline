import type { BankSyncApi } from '@sideline/domain';
import { Team } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useSearch } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import type { BankTab } from '~/components/pages/BankTransactionsPage';
import { BankTransactionsPage } from '~/components/pages/BankTransactionsPage';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const isBankTab = (value: unknown): value is BankTab =>
  value === 'queue' || value === 'matched' || value === 'export';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/finances_/bank')({
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { tab?: BankTab } =>
    isBankTab(search.tab) ? { tab: search.tab } : {},
  component: BankTransactionsRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canRecordPayments = permissions.includes('finance:record_payments');
    // Creating an expense is gated on manage_fees, NOT on the record_payments that opens this
    // page — a custom role can hold one without the other.
    const canManageExpenses = permissions.includes('finance:manage_fees');

    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          config: canRecordPayments
            ? api.bankSync.getBankSyncConfig({ params: { teamId } }).pipe(
                Effect.tapError((e) => Effect.logWarning('Failed to load bank sync config', e)),
                Effect.catch(() => Effect.succeed(null)),
              )
            : Effect.succeed(null),
          summary: canRecordPayments
            ? api.bankSync
                .getBankSyncSummary({
                  params: { teamId },
                  query: { from: Option.none(), to: Option.none() },
                })
                .pipe(
                  Effect.tapError((e) => Effect.logWarning('Failed to load bank sync summary', e)),
                  Effect.catch(() => Effect.succeed(null)),
                )
            : Effect.succeed(null),
          transactions: canRecordPayments
            ? api.bankSync
                .listBankTransactions({
                  params: { teamId },
                  query: {
                    from: Option.none(),
                    to: Option.none(),
                    state: Option.none(),
                    direction: Option.none(),
                    reason: Option.none(),
                    q: Option.none(),
                  },
                })
                .pipe(
                  Effect.tapError((e) => Effect.logWarning('Failed to load bank transactions', e)),
                  Effect.catch(() =>
                    Effect.succeed<ReadonlyArray<BankSyncApi.BankTransactionView>>([]),
                  ),
                )
            : Effect.succeed<ReadonlyArray<BankSyncApi.BankTransactionView>>([]),
        }),
      ),
      Effect.map((data) => ({ ...data, canRecordPayments, canManageExpenses })),
      warnAndCatchAll,
      context.run,
    );
  },
});

function BankTransactionsRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const { tab: searchTab } = useSearch({ from: Route.id });
  const navigate = useNavigate({ from: Route.fullPath });
  const router = useRouter();
  const run = useRun();
  const { config, summary, transactions, canManageExpenses } = Route.useLoaderData();

  const activeTab = searchTab ?? 'queue';
  const handleTabChange = (tab: BankTab) => navigate({ search: { tab } });

  const handleRefresh = () => router.invalidate();

  const handleStartBackfill = async (from: string, to: string) => {
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.bankSync.startBankSyncBackfill({ params: { teamId }, payload: { from, to } }),
      ),
      Effect.mapError(() => ClientError.make(tr('fio_save_error'))),
      run({}),
    );
    if (Option.isSome(result)) {
      router.invalidate();
    }
  };

  return (
    <BankTransactionsPage
      teamId={teamIdRaw}
      config={config}
      summary={summary}
      transactions={transactions}
      canManageExpenses={canManageExpenses}
      activeTab={activeTab}
      onTabChange={handleTabChange}
      onRefresh={handleRefresh}
      onStartBackfill={handleStartBackfill}
    />
  );
}
