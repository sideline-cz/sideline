import type { ActivityLogApi, ActivityStatsApi, ActivityType } from '@sideline/domain';
import { ActivityLog, Team, TeamMember } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { MakanickoPage } from '~/components/pages/MakanickoPage.js';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const WorkoutSearchSchema = Schema.Struct({
  season: Schema.optional(Schema.String),
});

export const Route = createFileRoute('/(authenticated)/teams/$teamId/workout')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(WorkoutSearchSchema),
  component: MakanickoRoute,
  loaderDeps: ({ search }) => ({ season: search.season }),
  loader: async ({ params, context, deps }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const userId = context.user?.id;
    // Invalid value = None = default view, never an error page
    const season = Schema.decodeUnknownOption(ActivityLog.ActivitySeasonFilter)(deps.season);
    const canViewTeamActivity =
      context.teams.find((t) => t.teamId === params.teamId)?.permissions.includes('member:view') ??
      false;
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          leaderboard: api.leaderboard.getLeaderboard({
            params: { teamId },
            query: { timeframe: Option.none(), season, activityTypeId: Option.none() },
          }),
          members: api.roster.listMembers({ params: { teamId } }),
          activityTypes: api.activityType.listActivityTypes({ params: { teamId } }),
        }).pipe(
          Effect.flatMap(({ leaderboard, members, activityTypes }) => {
            type WorkoutData = {
              leaderboard: typeof leaderboard;
              activityTypes: typeof activityTypes;
              activityStats: ActivityStatsApi.ActivityStatsResponse | null;
              activityLogs: ReadonlyArray<ActivityLogApi.ActivityLogEntry>;
              seasons: ReadonlyArray<ActivityLogApi.ActivitySeason>;
              memberId: TeamMember.TeamMemberId | null;
              canViewTeamActivity: boolean;
            };
            const currentMember = members.find((member) => member.userId === userId);
            if (!currentMember) {
              return Effect.succeed<WorkoutData>({
                leaderboard,
                activityTypes,
                activityStats: null,
                activityLogs: [],
                seasons: [],
                memberId: null,
                canViewTeamActivity,
              });
            }
            const memberId = currentMember.memberId;
            return Effect.all({
              activityStats: api.activityStats.getMemberStats({
                params: { teamId, memberId },
                query: { season },
              }),
              list: api.activityLog
                .listLogs({ params: { teamId, memberId }, query: { season } })
                .pipe(
                  Effect.tapError((e) => Effect.logWarning('Failed to load activity logs', e)),
                  Effect.catch(() =>
                    Effect.succeed<
                      Pick<ActivityLogApi.ActivityLogListResponse, 'logs' | 'seasons'>
                    >({ logs: [], seasons: [] }),
                  ),
                ),
            }).pipe(
              Effect.map(
                ({ activityStats, list }): WorkoutData => ({
                  leaderboard,
                  activityTypes,
                  activityStats,
                  activityLogs: list.logs,
                  seasons: list.seasons,
                  memberId,
                  canViewTeamActivity,
                }),
              ),
            );
          }),
        ),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function MakanickoRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const { user } = Route.useRouteContext();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const router = useRouter();
  const run = useRun();
  const data = Route.useLoaderData();
  const { season } = Route.useSearch();
  const navigate = useNavigate({ from: Route.fullPath });
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const handleSeasonChange = React.useCallback(
    (v: string | undefined) => {
      navigate({ search: (prev) => ({ ...prev, season: v }) });
    },
    [navigate],
  );

  const memberId = React.useMemo(
    () => (data?.memberId ? Schema.decodeSync(TeamMember.TeamMemberId)(data.memberId) : null),
    [data],
  );

  const activityTypes = React.useMemo(
    () =>
      (data?.activityTypes.activityTypes ?? []).filter(
        (t: { slug: Option.Option<string> }) =>
          Option.isNone(t.slug) || t.slug.value !== 'training',
      ),
    [data],
  );

  const handleCreateLog = React.useCallback(
    async (input: {
      activityTypeId: ActivityType.ActivityTypeId;
      durationMinutes: Option.Option<number>;
      note: Option.Option<string>;
      loggedAtDate: Option.Option<string>;
    }) => {
      if (!memberId) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.createLog({
            params: { teamId, memberId },
            payload: {
              activityTypeId: input.activityTypeId,
              durationMinutes: input.durationMinutes,
              note: input.note,
              loggedAtDate: input.loggedAtDate,
            },
          }),
        ),
        Effect.catchTag('ActivityLogInvalidLoggedAtDate', () =>
          Effect.fail(ClientError.make(tr('activityLog_invalidDate'))),
        ),
        Effect.mapError((err) =>
          err._tag === 'ClientError' ? err : ClientError.make(tr('activityLog_logFailed')),
        ),
        run({ success: tr('activityLog_logged') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleUpdateLog = React.useCallback(
    async (
      logId: ActivityLog.ActivityLogId,
      input: {
        activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
        durationMinutes: Option.Option<Option.Option<number>>;
        note: Option.Option<Option.Option<string>>;
        loggedAtDate: Option.Option<string>;
      },
    ) => {
      if (!memberId) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.updateLog({
            params: { teamId, memberId, logId },
            payload: {
              activityTypeId: input.activityTypeId,
              durationMinutes: input.durationMinutes,
              note: input.note,
              loggedAtDate: input.loggedAtDate,
            },
          }),
        ),
        Effect.catchTag('ActivityLogInvalidLoggedAtDate', () =>
          Effect.fail(ClientError.make(tr('activityLog_invalidDate'))),
        ),
        Effect.mapError((err) =>
          err._tag === 'ClientError' ? err : ClientError.make(tr('activityLog_updateFailed')),
        ),
        run({ success: tr('activityLog_updated') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const handleDeleteLog = React.useCallback(
    async (logId: ActivityLog.ActivityLogId) => {
      if (!memberId) return;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.deleteLog({
            params: { teamId, memberId, logId },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('activityLog_deleteFailed'))),
        run({ success: tr('activityLog_deleted') }),
      );
      if (Option.isSome(result)) {
        router.invalidate();
      }
    },
    [teamId, memberId, run, router],
  );

  const defaultStats: ActivityStatsApi.ActivityStatsResponse = {
    totalActivities: 0,
    totalDurationMinutes: 0,
    currentStreak: 0,
    longestStreak: 0,
    counts: [],
    achievements: [],
  };

  return (
    <MakanickoPage
      teamId={teamIdRaw}
      leaderboardEntries={data?.leaderboard.entries ?? []}
      currentUserId={user.id}
      activityStats={data?.activityStats ?? defaultStats}
      activityLogs={data?.activityLogs ?? []}
      seasons={data?.seasons ?? []}
      season={season}
      onSeasonChange={handleSeasonChange}
      canViewTeamActivity={data?.canViewTeamActivity ?? false}
      isPending={isPending}
      activityTypes={activityTypes}
      onCreateLog={handleCreateLog}
      onUpdateLog={handleUpdateLog}
      onDeleteLog={handleDeleteLog}
    />
  );
}
