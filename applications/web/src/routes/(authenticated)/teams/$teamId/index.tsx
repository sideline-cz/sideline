import type { Auth } from '@sideline/domain';
import { type DashboardLayoutApi, type FinanceApi, Team } from '@sideline/domain';
import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { Array, Effect, Equal, flow, Option, Schema, Struct } from 'effect';
import React from 'react';
import { TeamDetailPage } from '~/components/pages/TeamDetailPage';
import { isDiscordConnectSnoozed } from '~/lib/auth/discordConnectSnooze.js';
import { DEFAULT_LAYOUT } from '~/lib/dashboardLayout.js';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/')({
  ssr: false,
  component: TeamDetailRoute,
  beforeLoad: async ({ context, params }) => {
    if (context.user && !context.user.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
    // PR-9 / CC-15 & designer §3.1 — the redirect is dashboard-index only (this route), placed
    // AFTER the profile-completion redirect so profile completion still wins. 'unknown' renders
    // nothing (never redirects) and the snooze fails open (a `localStorage` throw is treated as
    // snoozed, never as un-snoozed) — see `discordConnectSnooze.ts`.
    if (context.user) {
      const team = Array.findFirst(
        context.teams,
        flow(Struct.get('teamId'), Equal.equals(params.teamId)),
      );
      const notConnected = Option.match(team, {
        onNone: () => false,
        onSome: (t) => t.discordJoined === 'not_connected',
      });
      if (notConnected && !isDiscordConnectSnoozed(context.user.id, params.teamId)) {
        throw redirect({ to: '/teams/$teamId/connect-discord', params: { teamId: params.teamId } });
      }
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
            Effect.catch(() => Effect.succeed<ReadonlyArray<FinanceApi.MyFinanceStatus>>([])),
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
  const { user, teams } = Route.useRouteContext();
  const { dashboard, myStatus, layout } = Route.useLoaderData();
  const run = useRun();
  const router = useRouter();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  // Explicit annotation (not a cast — `teams` already has this shape; see connect-discord.tsx
  // for why `Array.prototype.find`'s inference needs the help here).
  const typedTeams: ReadonlyArray<Auth.UserTeam> = teams;
  const team = typedTeams.find((t) => t.teamId === teamIdBranded);

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
      team={team}
      dashboard={dashboard}
      myStatus={myStatus}
      layout={layout}
      onSaveLayout={handleSaveLayout}
    />
  );
}
