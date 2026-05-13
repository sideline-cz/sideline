import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, pipe, Schema } from 'effect';
import { AchievementsAdminPage } from '~/components/pages/AchievementsAdminPage';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/achievements')({
  component: AchievementsRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    const achievements = await Effect.flatMap(ApiClient.asEffect(), (api) =>
      api.achievement.listAchievements({ params: { teamId } }),
    ).pipe(warnAndCatchAll, context.run);
    return { achievements };
  },
});

function AchievementsRoute() {
  const { teamId } = Route.useParams();
  const { achievements } = Route.useLoaderData();

  return <AchievementsAdminPage teamId={teamId} initialData={achievements} />;
}
