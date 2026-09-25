import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, pipe, Schema } from 'effect';
import { MembershipPlansPage } from '~/components/pages/MembershipPlansPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/membership-plans')({
  component: MembershipPlansRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    const response = await Effect.flatMap(ApiClient.asEffect(), (api) =>
      api.membershipPlan.listMembershipPlans({ params: { teamId } }),
    ).pipe(warnAndCatchAll, context.run);
    return { response };
  },
});

function MembershipPlansRoute() {
  const { teamId } = Route.useParams();
  const { response } = Route.useLoaderData();

  return (
    <MembershipPlansPage
      teamId={teamId}
      canManage={response?.canManage ?? false}
      plans={response?.plans ?? []}
      selectedPlanId={response?.selectedPlanId ?? Option.none()}
      selectionDeadline={response?.selectionDeadline ?? Option.none()}
    />
  );
}
