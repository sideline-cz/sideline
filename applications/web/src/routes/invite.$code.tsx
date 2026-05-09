import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import React from 'react';
import { InvitePage } from '~/components/pages/InvitePage';
import { getLogin, setLastTeamId, setPendingInvite } from '~/lib/auth';
import { ApiClient, ClientError, useRun, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/invite/$code')({
  component: InviteRoute,
  loader: async ({ params, context }) =>
    ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.invite.getInvite({ params: { code: params.code } })),
      warnAndCatchAll,
      context.run,
    ),
});

function InviteRoute() {
  const { userOption } = Route.useRouteContext();
  const { code } = Route.useParams();
  const invite = Route.useLoaderData();
  const navigate = useNavigate();
  const run = useRun();

  const handleJoined = React.useCallback(
    (teamId: string, isProfileComplete: boolean) => {
      Effect.runSync(setLastTeamId(teamId));
      if (isProfileComplete) {
        navigate({ to: '/teams/$teamId', params: { teamId } });
      } else {
        navigate({ to: '/profile/complete' });
      }
    },
    [navigate],
  );

  const handleSignIn = React.useCallback(() => {
    Effect.runSync(setPendingInvite(code));
    getLogin()
      .pipe(
        Effect.tapError((e) => Effect.logWarning('Failed to generate login URL', e)),
        Effect.mapError(() => ClientError.make('Failed to generate login URL')),
        run(),
      )
      .then((url) => {
        if (Option.isSome(url)) {
          window.location.href = url.value.toString();
        }
      });
  }, [code, run]);

  return (
    <InvitePage
      isAuthenticated={Option.isSome(userOption)}
      invite={invite}
      code={code}
      onJoined={handleJoined}
      onSignIn={handleSignIn}
      onReauth={handleSignIn}
    />
  );
}
