import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, pipe, Schema } from 'effect';
import { ActivityTypesPage } from '~/components/pages/ActivityTypesPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/activity-types')({
  component: ActivityTypesRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    const response = await Effect.flatMap(ApiClient.asEffect(), (api) =>
      api.activityType.listActivityTypes({ params: { teamId } }),
    ).pipe(warnAndCatchAll, context.run);
    return { response };
  },
});

function ActivityTypesRoute() {
  const { teamId } = Route.useParams();
  const { response } = Route.useLoaderData();

  return (
    <ActivityTypesPage
      teamId={teamId}
      canAdmin={response?.canAdmin ?? false}
      activityTypes={response?.activityTypes ?? []}
    />
  );
}
