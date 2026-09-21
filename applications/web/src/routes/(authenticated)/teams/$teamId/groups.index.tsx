import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import { GroupsListPage } from '~/components/pages/GroupsListPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/groups/')({
  ssr: false,
  component: GroupsRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const canManage = team.pipe(
      Option.map((t) => t.permissions.includes('group:manage')),
      Option.getOrElse(() => false),
    );
    const groups = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.group.listGroups({ params: { teamId } })),
      warnAndCatchAll,
      context.run,
    );
    return { groups, canManage };
  },
});

function GroupsRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const { groups, canManage } = Route.useLoaderData();

  return <GroupsListPage teamId={teamIdRaw} groups={groups} canManage={canManage} />;
}
