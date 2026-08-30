import type { Invite } from '@sideline/domain';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import React from 'react';
import { InvitePage } from '~/components/pages/InvitePage';
import { getLogin, setPendingInvite } from '~/lib/auth';
import { persistJoinResult } from '~/lib/auth/persistJoinResult.js';
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

  // BLOCKER 4 (review of PR-4): a single callback — see `InvitePage`'s `onJoinResult` prop doc
  // for why this replaced the previous `onJoinPersisted` / `onJoinComplete` pair. Persistence
  // always runs; navigation only runs when `meta.navigated` is true (i.e. `requiresReauth` was
  // false), which used to be a second, separately-wired callback that could be swapped with this
  // one at this exact call site without a type error.
  const handleJoinResult = React.useCallback(
    (result: Invite.JoinResult, meta: { readonly navigated: boolean }) => {
      Effect.runSync(persistJoinResult(result));
      if (!meta.navigated) return;
      if (result.isProfileComplete) {
        navigate({ to: '/teams/$teamId', params: { teamId: result.teamId } });
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
      onJoinResult={handleJoinResult}
      onSignIn={handleSignIn}
      onReauth={handleSignIn}
    />
  );
}
