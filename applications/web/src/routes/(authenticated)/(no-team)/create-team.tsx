import type { Auth } from '@sideline/domain';
import { createFileRoute, redirect, useNavigate, useRouter } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import React from 'react';
import { CreateTeamPage } from '~/components/pages/CreateTeamPage';
import { setLastTeamId } from '~/lib/auth';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export const Route = createFileRoute('/(authenticated)/(no-team)/create-team')({
  component: CreateTeamRoute,
  beforeLoad: ({ context }) => {
    if (!context.user?.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
  },
});

function CreateTeamRoute() {
  const navigate = useNavigate();
  const router = useRouter();
  const run = useRun();
  const { environment } = Route.useRouteContext();
  const [guilds, setGuilds] = React.useState<readonly Auth.DiscordGuild[]>([]);
  const [loadingGuilds, setLoadingGuilds] = React.useState(true);

  const fetchGuilds = React.useCallback(async () => {
    setLoadingGuilds(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) => api.auth.myGuilds()),
      Effect.catch(() => Effect.succeed([] as readonly Auth.DiscordGuild[])),
      run(),
    );
    if (Option.isSome(result)) {
      setGuilds(result.value);
    }
    setLoadingGuilds(false);
  }, [run]);

  React.useEffect(() => {
    fetchGuilds();
  }, [fetchGuilds]);

  const handleCreateTeam = React.useCallback(
    async (name: string, guildId: string) => {
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.auth.createTeam({
            payload: { name, guildId: guildId as Auth.CreateTeamRequest['guildId'] },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('dashboard_createFailed'))),
        run({ success: tr('team_teamCreated') }),
      );
      if (Option.isSome(result)) {
        const teamId = result.value.teamId;
        Effect.runSync(setLastTeamId(teamId));
        await router.invalidate();
        await navigate({ to: '/teams/$teamId', params: { teamId } });
        return true;
      }
      return false;
    },
    [run, router, navigate],
  );

  return (
    <CreateTeamPage
      guilds={guilds}
      loadingGuilds={loadingGuilds}
      discordClientId={environment.DISCORD_CLIENT_ID}
      onCreateTeam={handleCreateTeam}
      onRefreshGuilds={fetchGuilds}
    />
  );
}
