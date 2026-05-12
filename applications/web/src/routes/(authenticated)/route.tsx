import type { Auth } from '@sideline/domain';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)')({
  component: AuthenticatedLayoutRoute,
  wrapInSuspense: true,
  beforeLoad: ({ context }) => {
    const user = Option.getOrNull(context.userOption);
    if (!user) {
      throw redirect({ to: '/' });
    }
    return Effect.Do.pipe(
      Effect.let('user', () => user),
      Effect.bind('teams', () =>
        ApiClient.asEffect().pipe(
          Effect.flatMap((api) => api.auth.myTeams()),
          Effect.tapError((e) => Effect.logWarning('Could not fetch my teams', e)),
          Effect.catch(() => Effect.succeed([] as readonly Auth.UserTeam[])),
        ),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function AuthenticatedLayoutRoute() {
  return <Outlet />;
}
