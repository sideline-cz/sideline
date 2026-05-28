import { type DashboardLayoutApi, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { TeamDetailPage } from '~/components/pages/TeamDetailPage';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

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
    const [dashboard, myStatus, layout] = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all([
          api.dashboard.getDashboard({ params: { teamId } }),
          api.finance.myStatus({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load my finance status', e)),
            Effect.catch(() => Effect.succeed([] as ReadonlyArray<FinanceApi.MyFinanceStatus>)),
          ),
          api.dashboardLayout.getDashboardLayout({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load dashboard layout', e)),
            Effect.catch(() => Effect.succeed(DEFAULT_LAYOUT)),
          ),
        ]),
      ),
      warnAndCatchAll,
      context.run,
    );
    return { dashboard, myStatus, layout };
  },
});

function TeamDetailRoute() {
  const { teamId } = Route.useParams();
  const { user } = Route.useRouteContext();
  const { dashboard, myStatus, layout } = Route.useLoaderData();
  const run = useRun();
  const router = useRouter();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);

  const handleSaveLayout = React.useCallback(
    async (widgets: DashboardLayoutApi.DashboardWidget[]) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.dashboardLayout.updateDashboardLayout({
            params: { teamId: teamIdBranded },
            payload: { widgets },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('dashboard_layoutSaveFailed'))),
        run({ success: tr('dashboard_layoutSaved') }),
      );
      if (Option.isNone(result)) {
        throw new Error(tr('dashboard_layoutSaveFailed'));
      }
      router.invalidate();
    },
    [teamIdBranded, run, router],
  );

  return (
    <TeamDetailPage
      teamId={teamId}
      userId={user?.id}
      dashboard={dashboard}
      myStatus={myStatus}
      layout={layout}
      onSaveLayout={handleSaveLayout}
    />
  );
}
