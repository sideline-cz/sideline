import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { Array, Effect, Option } from 'effect';
import React from 'react';
import { toast } from 'sonner';
import { ProfileCompletePage } from '~/components/pages/ProfileCompletePage';
import { getLastTeamId, setLastTeamId } from '~/lib/auth';
import { ApiClient, Redirect, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/(no-team)/profile/complete')({
  component: ProfileCompleteRoute,
  beforeLoad: ({ context }) =>
    context.user?.isProfileComplete
      ? Effect.Do.pipe(
          Effect.flatMap(() => getLastTeamId),
          Effect.flatMap(Effect.fromOption),
          Effect.flatMap((teamId) =>
            Effect.fail(
              Option.isSome(Array.findFirst(context.teams, (t) => t.teamId === teamId))
                ? Redirect.make({ to: '/teams/$teamId', params: { teamId } })
                : Redirect.make({ to: '/' }),
            ),
          ),
          Effect.catchTag('NoSuchElementError', () => Effect.void),
          context.run,
        )
      : {},
});

function ProfileCompleteRoute() {
  const { user, teams } = Route.useRouteContext();
  const navigate = useNavigate();
  const run = useRun();

  const handleSuccess = React.useCallback(async () => {
    const lastTeamId = Effect.runSync(getLastTeamId);
    if (Option.isSome(lastTeamId)) {
      if (
        Option.isSome(
          Array.findFirst(teams, (t: { teamId: string }) => t.teamId === lastTeamId.value),
        )
      ) {
        await navigate({ to: '/teams/$teamId', params: { teamId: lastTeamId.value } });
      } else {
        await navigate({ to: '/' });
      }
      return;
    }
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.auth.autoJoinTeams()),
      Effect.mapError(() => new SilentClientError({ message: '' })),
      run(),
    );
    const firstTeam = Option.isSome(result) ? Array.head(result.value) : Option.none();
    if (Option.isSome(firstTeam)) {
      const team = firstTeam.value;
      Effect.runSync(setLastTeamId(team.teamId));
      toast.success(tr('team_autoJoined', { teamName: team.teamName }));
      await navigate({ to: '/teams/$teamId', params: { teamId: team.teamId } });
    } else {
      await navigate({ to: '/' });
    }
  }, [navigate, run, teams]);

  return <ProfileCompletePage user={user} onSuccess={handleSuccess} />;
}
