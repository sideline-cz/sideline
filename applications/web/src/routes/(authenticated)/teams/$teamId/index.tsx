import { type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, redirect } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import { TeamDetailPage } from '~/components/pages/TeamDetailPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/')({
  ssr: false,
  component: TeamDetailRoute,
  beforeLoad: async ({ context }) => {
    if (context.user && !context.user.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
  },
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const [dashboard, myStatus] = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all([
          api.dashboard.getDashboard({ params: { teamId } }),
          api.finance.myStatus({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load my finance status', e)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<FinanceApi.MyFinanceStatus>)),
          ),
        ]),
      ),
      warnAndCatchAll,
      context.run,
    );
    return { dashboard, myStatus };
  },
});

function TeamDetailRoute() {
  const { teamId } = Route.useParams();
  const { dashboard, myStatus } = Route.useLoaderData();

  return <TeamDetailPage teamId={teamId} dashboard={dashboard} myStatus={myStatus} />;
}
