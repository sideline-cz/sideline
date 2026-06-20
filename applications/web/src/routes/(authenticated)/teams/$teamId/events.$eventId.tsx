import {
  Event,
  type EventRosterApi,
  type PlayerRatingApi,
  type Roster,
  Team,
} from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { EventDetailPage } from '~/components/pages/EventDetailPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/events/$eventId')({
  ssr: false,
  component: EventDetailRoute,
  loader: async ({ params, context }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    const eventId = Schema.decodeSync(Event.EventId)(params.eventId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          event: api.event.getEvent({ params: { teamId, eventId } }),
          trainingTypes: api.trainingType.listTrainingTypes({ params: { teamId } }),
          rsvpDetail: api.eventRsvp.getRsvps({ params: { teamId, eventId } }),
          discordChannels: api.group
            .listDiscordChannels({ params: { teamId } })
            .pipe(Effect.catch(() => Effect.succeed([] as const))),
          nonResponders: api.eventRsvp
            .getNonResponders({ params: { teamId, eventId } })
            .pipe(Effect.catch(() => Effect.succeed({ nonResponders: [] }))),
          groups: api.group
            .listGroups({ params: { teamId } })
            .pipe(Effect.catch(() => Effect.succeed([] as const))),
          rosters: api.roster.listRosters({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load rosters for event', e)),
            Effect.catch(() =>
              Effect.succeed({
                canManage: false,
                rosters: [] as ReadonlyArray<Roster.RosterInfo>,
              }),
            ),
          ),
          eventRosterLink: api.eventRoster.getEventRosterLink({ params: { teamId, eventId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load event roster link', e)),
            Effect.catch(() => Effect.succeed(Option.none<EventRosterApi.EventRosterLink>())),
          ),
          trainingGames: api.playerRating.getTrainingGames({ params: { teamId, eventId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load training games for event', e)),
            Effect.catch(() =>
              Effect.succeed({ games: [] as ReadonlyArray<PlayerRatingApi.LoggedGameEntry> }),
            ),
          ),
          teamRatings: api.playerRating.getTeamRatings({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load team ratings for event', e)),
            Effect.catch(() => Effect.succeed({ canManage: false })),
          ),
          generationConfig: api.teamGeneration.getGenerationConfig({ params: { teamId } }).pipe(
            Effect.tapError((e) =>
              Effect.logWarning('Failed to load generation config for event', e),
            ),
            Effect.catch(() => Effect.succeed({ canManage: false as const })),
          ),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function EventDetailRoute() {
  const { teamId: teamIdRaw, eventId: eventIdRaw } = Route.useParams();
  const data = Route.useLoaderData();

  const rsvpYesAttendees = data.rsvpDetail.rsvps.filter(
    (r: (typeof data.rsvpDetail.rsvps)[number]) => r.response === 'yes',
  );

  return (
    <EventDetailPage
      teamId={teamIdRaw}
      eventId={eventIdRaw}
      eventDetail={data.event}
      trainingTypes={data.trainingTypes.trainingTypes}
      rsvpDetail={data.rsvpDetail}
      discordChannels={data.discordChannels}
      nonResponders={data.nonResponders.nonResponders}
      groups={data.groups}
      rosters={data.rosters.rosters}
      canManageRosters={data.rosters.canManage}
      canManageRatings={data.teamRatings.canManage}
      canGenerate={data.generationConfig.canManage}
      initialEventRosterLink={data.eventRosterLink}
      rsvpYesAttendees={rsvpYesAttendees}
      initialTrainingGames={data.trainingGames.games}
    />
  );
}
