import { ActivityLogApi, Team, TeamMember } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { WorkoutMemberPage } from '~/components/pages/WorkoutMemberPage.js';
import { isUnknownSeason, toSeasonSearch, validateSeasonSearch } from '~/lib/activitySeason.js';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

const emptyLogs = new ActivityLogApi.ActivityLogListResponse({ logs: [], seasons: [] });

// `workout_` escapes nesting: workout.tsx renders no <Outlet />
export const Route = createFileRoute('/(authenticated)/teams/$teamId/workout_/members/$memberId')({
  ssr: false,
  validateSearch: validateSeasonSearch,
  component: WorkoutMemberRoute,
  loaderDeps: ({ search }) => ({ season: search.season }),
  loader: async ({ params, context, deps }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const memberId = Schema.decodeSync(TeamMember.TeamMemberId)(params.memberId);
    const season = Option.fromUndefinedOr(deps.season);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          player: api.roster.getMember({ params: { teamId, memberId } }),
          stats: api.activityStats.getMemberStats({
            params: { teamId, memberId },
            query: { season },
          }),
          list: api.activityLog.listLogs({ params: { teamId, memberId }, query: { season } }).pipe(
            Effect.map((list) => ({ list, failed: false })),
            Effect.tapError((e) => Effect.logWarning('Failed to load activity logs', e)),
            Effect.catch(() => Effect.succeed({ list: emptyLogs, failed: true })),
          ),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function WorkoutMemberRoute() {
  const { teamId } = Route.useParams();
  const data = Route.useLoaderData();
  const { season } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });

  const handleSeasonChange = React.useCallback(
    (v: string | undefined) => {
      navigate({ search: (prev) => ({ ...prev, season: toSeasonSearch(v) }) });
    },
    [navigate],
  );
  // A well-formed id outside the loaded seasons has no picker option; fall back to the default.
  const loadedSeasons = data.list.list.seasons;
  React.useEffect(() => {
    if (isUnknownSeason(loadedSeasons, season)) {
      navigate({ search: (prev) => ({ ...prev, season: undefined }), replace: true });
    }
  }, [loadedSeasons, season, navigate]);

  return (
    <WorkoutMemberPage
      teamId={teamId}
      displayName={data.player.displayName}
      stats={data.stats}
      logs={data.list.list.logs}
      seasons={data.list.list.seasons}
      logsError={data.list.failed}
      onRetry={() => {
        router.invalidate();
      }}
      season={season}
      onSeasonChange={handleSeasonChange}
      isPending={isPending}
    />
  );
}
