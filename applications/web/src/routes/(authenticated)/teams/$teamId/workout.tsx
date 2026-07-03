import type { ActivityLog, ActivityLogApi, ActivityStatsApi, ActivityType } from '@sideline/domain';
import { Team, TeamMember } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import { MakanickoPage } from '~/components/pages/MakanickoPage.js';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/workout')({
  ssr: false,
  component: MakanickoRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const userId = context.user?.id;
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          leaderboard: api.leaderboard.getLeaderboard({
            params: { teamId },
            query: { timeframe: Option.none(), activityTypeId: Option.none() },
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
              memberId: TeamMember.TeamMemberId | null;
            };
            const currentMember = members.find((member) => member.userId === userId);
            if (!currentMember) {
              return Effect.succeed<WorkoutData>({
                leaderboard,
                activityTypes,
                activityStats: null,
                activityLogs: [],
                memberId: null,
              });
            }
            const memberId = currentMember.memberId;
            return Effect.all({
              activityStats: api.activityStats.getMemberStats({ params: { teamId, memberId } }),
              activityLogs: api.activityLog.listLogs({ params: { teamId, memberId } }).pipe(
                Effect.map((r) => r.logs),
                Effect.catch(() =>
                  Effect.succeed<ReadonlyArray<ActivityLogApi.ActivityLogEntry>>([]),
                ),
              ),
            }).pipe(
              Effect.map(
                ({ activityStats, activityLogs }): WorkoutData => ({
                  leaderboard,
                  activityTypes,
                  activityStats,
                  activityLogs,
                  memberId,
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
      activityTypes={activityTypes}
      onCreateLog={handleCreateLog}
      onUpdateLog={handleUpdateLog}
      onDeleteLog={handleDeleteLog}
    />
  );
}
