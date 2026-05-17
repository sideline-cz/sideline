import { type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
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
      Effect.flatMap((api) => api.finance.myStatus({ params: { teamId } })),
      Effect.tapError((e) => Effect.logWarning('Failed to load my finance status', e)),
      Effect.catch(() => Effect.succeed([] as ReadonlyArray<FinanceApi.MyFinanceStatus>)),
      context.run,
    );
  },
});

function MyPaymentsRoute() {
  const { teamId } = Route.useParams();
  const myStatus = Route.useLoaderData();

  return <MyPaymentsPage teamId={teamId} myStatus={myStatus ?? []} />;
}
