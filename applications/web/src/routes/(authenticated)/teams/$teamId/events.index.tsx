import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, Schema } from 'effect';
import { EventsListPage } from '~/components/pages/EventsListPage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

const EventsSearchSchema = Schema.Struct({
  all: Schema.optional(Schema.Boolean),
});

export const Route = createFileRoute('/(authenticated)/teams/$teamId/events/')({
  ssr: false,
  validateSearch: Schema.toStandardSchemaV1(EventsSearchSchema),
  loaderDeps: ({ search }) => ({ all: search.all }),
  component: EventsRoute,
  loader: async ({ params, context, deps }) => {
    const teamId = Schema.decodeSync(Team.TeamId)(params.teamId);
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          eventList: api.event.listEvents({
            params: { teamId },
            query: { all: deps.all ? Option.some(true) : Option.none() },
          }),
          trainingTypes: api.trainingType.listTrainingTypes({ params: { teamId } }),
          discordChannels: api.group
            .listDiscordChannels({ params: { teamId } })
            .pipe(Effect.catch(() => Effect.succeed([] as const))),
          groups: api.group
            .listGroups({ params: { teamId } })
            .pipe(Effect.catch(() => Effect.succeed([] as const))),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function EventsRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const data = Route.useLoaderData();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();

  return (
    <EventsListPage
      teamId={teamIdRaw}
      events={data.eventList.events}
      canCreate={data.eventList.canCreate}
      canViewAll={data.eventList.canViewAll}
      showAllGroups={search.all ?? false}
      onShowAllGroupsChange={(v) =>
        navigate({
          search: (prev: Schema.Schema.Type<typeof EventsSearchSchema>) => ({
            ...prev,
            all: v ? true : undefined,
          }),
        })
      }
      trainingTypes={data.trainingTypes.trainingTypes}
      groups={data.groups}
    />
  );
}
