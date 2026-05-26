import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Array, Effect, Equal, flow, Option, Struct } from 'effect';
import React from 'react';
import { AuthenticatedLayout } from '~/components/layouts/AuthenticatedLayout';
import { clearLastTeamId, getLastTeamId, logout, setLastTeamId } from '~/lib/auth';
import { resolveNoTeamRedirect } from '~/lib/auth/resolveNoTeamRedirect.js';
import { Redirect } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId')({
  component: AuthenticatedLayoutRoute,
  ssr: false,
  loader: ({ context, params }) =>
    Effect.Do.pipe(
      Effect.let('teams', () => context.teams),
      Effect.bind('team', ({ teams }) =>
        Array.findFirst(teams, flow(Struct.get('teamId'), Equal.equals(params.teamId))).pipe(
          Effect.fromOption,
        ),
      ),
      Effect.tap(() => setLastTeamId(params.teamId)),
      Effect.catchTag('NoSuchElementError', () =>
        getLastTeamId.pipe(
          Effect.map(
            (lastTeamId) => Option.isSome(lastTeamId) && lastTeamId.value === params.teamId,
          ),
          Effect.tap(() => clearLastTeamId),
          // Route global admins with no teams to the onboarding-tokens page,
          // other users with remaining teams back to `/`, and users with no
          // remaining teams to `/no-team` (with `removed=1` if they were
          // actively viewing this team).
          // The redirect target is resolved to a single `Redirect` value before
          // `Effect.fail` so TanStack's generic `Redirect.make` overloads don't
          // collapse the loader's inferred error channel to `unknown`.
          Effect.flatMap((wasViewing) => {
            const target: Redirect = Redirect.make(
              resolveNoTeamRedirect({
                isGlobalAdmin: context.user.isGlobalAdmin,
                hasOtherTeams: context.teams.length > 0,
                wasViewing,
              }),
            );
            return Effect.fail(target);
          }),
        ),
      ),
      context.run,
    ),
});

function AuthenticatedLayoutRoute() {
  const { user } = Route.useRouteContext();
  const { teams, team } = Route.useLoaderData();
  const navigate = useNavigate();

  const handleLogout = React.useCallback(() => {
    Effect.runSync(logout);
    navigate({ to: '/' });
  }, [navigate]);

  return (
    <AuthenticatedLayout user={user} teams={teams} activeTeam={team} onLogout={handleLogout} />
  );
}
