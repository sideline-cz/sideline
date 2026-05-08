import { Team } from '@sideline/domain';
import { createFileRoute, useRouter } from '@tanstack/react-router';
import { Effect, Schema } from 'effect';
import { TeamInvitesPage } from '~/components/pages/TeamInvitesPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/invites')({
  ssr: false,
  component: InvitesRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          invites: api.invite.listInvitesForTeam({ params: { teamId } }),
          groups: api.group.listGroups({ params: { teamId } }),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function InvitesRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const teamId = Schema.decodeSync(Team.TeamId)(teamIdRaw);
  const { invites, groups } = Route.useLoaderData();
  const router = useRouter();

  const handleRefresh = () => {
    router.invalidate();
  };

  return (
    <TeamInvitesPage
      teamId={teamId}
      teamIdRaw={teamIdRaw}
      invites={invites}
      groups={groups}
      onRefresh={handleRefresh}
    />
  );
}
