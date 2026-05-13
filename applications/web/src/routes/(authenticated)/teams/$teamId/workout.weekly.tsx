import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { WeeklySummaryPage } from '~/components/pages/WeeklySummaryPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

const WeeklySearchSchema = Schema.Struct({
  week: Schema.optional(Schema.String),
  includeTeam: Schema.optional(Schema.Boolean),
});

export const Route = createFileRoute('/(authenticated)/teams/$teamId/workout/weekly')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(WeeklySearchSchema),
  component: WeeklySummaryRoute,
  loaderDeps: ({ search }) => ({ week: search.week, includeTeam: search.includeTeam }),
  loader: async ({ params, context, deps }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const weekParam = deps.week;
    const includeTeamParam = deps.includeTeam ?? true;

    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.weeklySummary.getWeeklySummary({
          params: { teamId },
          query: {
            week: Option.fromNullishOr(weekParam),
            includeTeam: Option.some(includeTeamParam),
          },
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function WeeklySummaryRoute() {
  const { teamId } = Route.useParams();
  const search = Route.useSearch();
  const summary = Route.useLoaderData();

  if (!summary) return null;

  const currentWeek =
    search.week ?? `${summary.week.isoYear}-W${String(summary.week.isoWeek).padStart(2, '0')}`;

  return (
    <WeeklySummaryPage
      summary={summary}
      teamId={teamId}
      canViewTeam={summary.team !== null}
      currentWeek={currentWeek}
    />
  );
}
