import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import { RolesListPage } from '~/components/pages/RolesListPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/roles/')({
  component: RolesRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.role.listRoles({ params: { teamId } })),
      warnAndCatchAll,
      context.run,
    );
  },
});

function RolesRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const data = Route.useLoaderData();

  return (
    <RolesListPage
      teamId={teamIdRaw}
      roles={data.roles}
      canManage={data.canManage}
      defaultRoleId={data.defaultRoleId}
      defaultRoleGrantsManage={data.defaultRoleGrantsManage}
    />
  );
}
