import { type BankSyncApi, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { MyPaymentsPage } from '~/components/pages/MyPaymentsPage';
import { ApiClient } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/my-payments')({
  ssr: false,
  component: MyPaymentsRoute,
  beforeLoad: async ({ context }) => {
    if (context.user && !context.user.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
  },
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        // Independent: the standing top-up code must not disappear because the fee list failed,
        // and vice versa. Each side degrades on its own.
        Effect.all(
          {
            myStatus: api.finance.myStatus({ params: { teamId } }).pipe(
              Effect.tapError((e) => Effect.logWarning('Failed to load my finance status', e)),
              Effect.catch(() => Effect.succeed<ReadonlyArray<FinanceApi.MyFinanceStatus>>([])),
            ),
            topup: api.bankSync.getMyTopup({ params: { teamId } }).pipe(
              Effect.tapError((e) => Effect.logWarning('Failed to load top-up details', e)),
              Effect.catch(() => Effect.succeed<BankSyncApi.MyTopupView | null>(null)),
            ),
          },
          { concurrency: 2 },
        ),
      ),
      context.run,
    );
  },
});

function MyPaymentsRoute() {
  const { teamId } = Route.useParams();
  const data = Route.useLoaderData();

  const topup = data?.topup ?? null;

  return (
    <MyPaymentsPage
      teamId={teamId}
      myStatus={data?.myStatus ?? []}
      topup={
        topup === null
          ? null
          : {
              iban: Option.getOrNull(topup.iban),
              variableSymbol: Option.getOrNull(topup.variableSymbol),
              recipientName: Option.getOrNull(topup.recipientName),
              qrPngDataUrl: Option.getOrNull(topup.qrPngDataUrl),
            }
      }
    />
  );
}
