import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, pipe, Schema } from 'effect';
import { TeamRulesPage } from '~/components/pages/TeamRulesPage';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

// Phase 3 step 14 of `docs/plans/rules-trainer.md` — the first (and, as of
// this route, only) caller of `getRulesLeaderboard` (merged in #574).
// `warnAndCatchAll` degrades a failed fetch to a 404 rather than a blank
// page, mirroring `achievements.tsx`'s exact loader shape.
export const Route = createFileRoute('/(authenticated)/teams/$teamId/rules')({
  component: TeamRulesRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    const leaderboard = await Effect.flatMap(ApiClient.asEffect(), (api) =>
      api.rulesTrainer.getRulesLeaderboard({ params: { teamId } }),
    ).pipe(warnAndCatchAll, context.run);
    return { leaderboard };
  },
});

function TeamRulesRoute() {
  const { leaderboard } = Route.useLoaderData();

  return <TeamRulesPage leaderboard={leaderboard} />;
}
