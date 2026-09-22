import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, pipe, Schema } from 'effect';
import { EventTypesPage } from '~/components/pages/EventTypesPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/event-types')({
  component: EventTypesRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    const response = await Effect.flatMap(ApiClient.asEffect(), (api) =>
      api.eventType.listEventTypes({ params: { teamId } }),
    ).pipe(warnAndCatchAll, context.run);
    return { response };
  },
});

function EventTypesRoute() {
  const { teamId } = Route.useParams();
  const { response } = Route.useLoaderData();

  return (
    <EventTypesPage
      teamId={teamId}
      canAdmin={response?.canAdmin ?? false}
      eventTypes={response?.eventTypes ?? []}
    />
  );
}
