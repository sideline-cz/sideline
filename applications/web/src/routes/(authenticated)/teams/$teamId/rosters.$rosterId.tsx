import { type EventRosterApi, RosterModel, Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { RosterDetailPage } from '~/components/pages/RosterDetailPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/rosters/$rosterId')({
  ssr: false,
  component: RosterDetailRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const rosterId = Schema.decodeSync(RosterModel.RosterId)(params.rosterId);
    const [rosterDetail, allMembers, discordChannels, guildId, pendingRequests] = await Promise.all(
      [
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.roster.getRoster({ params: { teamId, rosterId } })),
          warnAndCatchAll,
          context.run,
        ),
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.roster.listMembers({ params: { teamId } })),
          warnAndCatchAll,
          context.run,
        ),
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.group.listDiscordChannels({ params: { teamId } })),
          Effect.tapError((e) => Effect.logWarning('Failed to load Discord channels', e)),
          Effect.catch(() => Effect.succeed([])),
          context.run,
        ),
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.team.getTeamInfo({ params: { teamId } })),
          Effect.map((info) => Option.some(info.guildId)),
          Effect.tapError((e) => Effect.logWarning('Failed to load team info', e)),
          Effect.catch(() => Effect.succeed(Option.none<string>())),
          context.run,
        ),
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) =>
            api.eventRoster.listRosterRequests({ params: { teamId, rosterId } }),
          ),
          Effect.tapError((e) => Effect.logWarning('Failed to load roster pending requests', e)),
          Effect.catch(() =>
            Effect.succeed([] as ReadonlyArray<EventRosterApi.PendingRequestView>),
          ),
          context.run,
        ),
      ],
    );
    return { rosterDetail, allMembers, discordChannels, guildId, pendingRequests };
  },
});

function RosterDetailRoute() {
  const { user } = Route.useRouteContext();
  const { teamId: teamIdRaw, rosterId: rosterIdRaw } = Route.useParams();
  const { rosterDetail, allMembers, discordChannels, guildId, pendingRequests } =
    Route.useLoaderData();

  return (
    <RosterDetailPage
      teamId={teamIdRaw}
      rosterId={rosterIdRaw}
      rosterDetail={rosterDetail}
      allMembers={allMembers}
      canManage={rosterDetail.canManage}
      userId={user.id}
      discordChannels={discordChannels}
      guildId={guildId}
      pendingRequests={pendingRequests}
    />
  );
}
