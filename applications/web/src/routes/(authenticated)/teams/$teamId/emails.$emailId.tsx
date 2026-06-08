import { EmailForwarding, Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Array, Effect, Option, Schema } from 'effect';
import { EmailDetailNotFound, EmailDetailPage } from '~/components/pages/EmailDetailPage.js';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/emails/$emailId')({
  ssr: false,
  component: EmailDetailRoute,
  notFoundComponent: () => {
    const { teamId } = Route.useParams();
    return <EmailDetailNotFound teamId={teamId} />;
  },
  loader: async ({ params, context }) => {
    const teamId = await Schema.decodeEffect(Team.TeamId)(params.teamId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );
    const emailId = await Schema.decodeEffect(EmailForwarding.EmailMessageId)(params.emailId).pipe(
      Effect.mapError(NotFound.make),
      context.run,
    );

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const hasCoachAuthority = permissions.includes('team:manage');

    const email = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.emailForwarding.getEmail({ params: { teamId, emailId } })),
      warnAndCatchAll,
      context.run,
    );

    return { email, hasCoachAuthority };
  },
});

function EmailDetailRoute() {
  const { teamId } = Route.useParams();
  const { email, hasCoachAuthority } = Route.useLoaderData();

  return <EmailDetailPage email={email} teamId={teamId} hasCoachAuthority={hasCoachAuthority} />;
}
