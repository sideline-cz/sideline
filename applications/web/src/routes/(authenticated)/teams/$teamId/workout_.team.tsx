import { GroupModel, Team } from '@sideline/domain';
import { createFileRoute, useNavigate, useRouter, useRouterState } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import React from 'react';
import { WorkoutTeamPage } from '~/components/pages/WorkoutTeamPage.js';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

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
        api.activityLog.getActivityMatrix({ params: { teamId }, query: { group } }).pipe(
          // The page shows its own error state with a retry button
          Effect.tapError((e) => Effect.logWarning('Failed to load activity matrix', e)),
          Effect.catch(() => Effect.succeed(null)),
        ),
      ),
      Effect.map((matrix) => ({ matrix })),
      warnAndCatchAll,
      context.run,
    );
  },
});

function WorkoutTeamRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const { matrix } = Route.useLoaderData();
  const { group } = Route.useSearch();
  const router = useRouter();
  const navigate = useNavigate({ from: Route.fullPath });
  const isPending = useRouterState({ select: (s) => s.status === 'pending' });

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
      onRetry={() => {
        router.invalidate();
      }}
      isPending={isPending}
    />
  );
}
