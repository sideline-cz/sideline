import { GroupModel, Team } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
import type { LogActivityInput } from '~/components/organisms/LogActivityForm.js';
import { WorkoutTeamPage } from '~/components/pages/WorkoutTeamPage.js';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const WorkoutTeamSearchSchema = Schema.Struct({
  group: Schema.optional(Schema.String),
});

// Same check as the endpoint: a bad id means "all members", not a 400 page
const GroupFilter = GroupModel.GroupId.pipe(Schema.check(Schema.isUUID()));

// `workout_` escapes nesting: workout.tsx renders no <Outlet />
export const Route = createFileRoute('/(authenticated)/teams/$teamId/workout_/team')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(WorkoutTeamSearchSchema),
  component: WorkoutTeamRoute,
  loaderDeps: ({ search }) => ({ group: search.group }),
  loader: async ({ params, context, deps }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const group = Schema.decodeUnknownOption(GroupFilter)(deps.group);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          matrix: api.activityLog.getActivityMatrix({ params: { teamId }, query: { group } }).pipe(
            // The page shows its own error state with a retry button
            Effect.tapError((e) => Effect.logWarning('Failed to load activity matrix', e)),
            Effect.catch(() => Effect.succeed(null)),
          ),
          // Only colours depend on it: without it the dots fall back to one colour
          activityTypes: api.activityType.listActivityTypes({ params: { teamId } }).pipe(
            Effect.map((r) => r.activityTypes),
            Effect.catch(() => Effect.succeed([])),
          ),
          // Only pins/highlights the viewer's row: without it the matrix is still usable
          currentMemberId: api.roster.listMembers({ params: { teamId } }).pipe(
            Effect.map((ms) => ms.find((m) => m.userId === context.user?.id)?.memberId ?? null),
            Effect.catch(() => Effect.succeed(null)),
          ),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function WorkoutTeamRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const { matrix, activityTypes, currentMemberId } = Route.useLoaderData();
  const { group } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });
  const run = useRun();

  // Same filter as the personal workout page: training logs come from attendance, not by hand
  const logActivityTypes = React.useMemo(
    () => activityTypes.filter((t) => Option.isNone(t.slug) || t.slug.value !== 'training'),
    [activityTypes],
  );

  const handleLogActivity = React.useCallback(
    async (input: LogActivityInput) => {
      if (currentMemberId === null) return false;
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.activityLog.createLog({
            params: { teamId, memberId: currentMemberId },
            payload: input,
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
      if (Option.isNone(result)) return false;
      router.invalidate();
      return true;
    },
    [teamId, currentMemberId, run, router],
  );

  const handleGroupChange = React.useCallback(
    (v: string | undefined) => {
      navigate({ search: (prev) => ({ ...prev, group: v }) });
    },
    [navigate],
  );

  return (
    <WorkoutTeamPage
      teamId={teamId}
      matrix={matrix}
      groupId={group}
      onGroupChange={handleGroupChange}
      activityTypes={activityTypes}
      currentMemberId={currentMemberId}
      logActivityTypes={logActivityTypes}
      onLogActivity={handleLogActivity}
      onRetry={() => {
        router.invalidate();
      }}
      isPending={isPending}
    />
  );
}
