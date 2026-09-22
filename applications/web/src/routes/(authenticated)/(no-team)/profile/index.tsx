import { createFileRoute, redirect, useRouter } from '@tanstack/react-router';
import { Effect } from 'effect';
import React from 'react';
import { MyProfilePage } from '~/components/pages/MyProfilePage';
import { ApiClient, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/(no-team)/profile/')({
  component: ProfileRoute,
  ssr: false,
  beforeLoad: async ({ context }) => {
    if (!context.user) {
      throw redirect({ to: '/' });
    }
    if (!context.user.isProfileComplete) {
      throw redirect({ to: '/profile/complete' });
    }
  },
  // Nastavitelná docházka (design.md §A.2) — per-team preferences, one fetch per team the
  // member is connected to on Discord. Each fetch is tolerant of its own failure (the way
  // `settings.tsx` treats `emailForwardingConfig`): a `null` entry renders that one card's
  // `eventPrefs_loadFailed` alert without taking the rest of the page down.
  loader: async ({ context }) => {
    const connectedTeams = context.teams.filter((team) => team.discordJoined === 'connected');

    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all(
          connectedTeams.map((team) =>
            api.team.getMyEventPreferences({ params: { teamId: team.teamId } }).pipe(
              Effect.map((prefs) => [team.teamId, prefs] as const),
              Effect.tapError((e) => Effect.logWarning('Failed to load event preferences', e)),
              Effect.catch(() => Effect.succeed([team.teamId, null] as const)),
            ),
          ),
        ),
      ),
      Effect.map((entries) => Object.fromEntries(entries)),
      warnAndCatchAll,
      context.run,
    );
  },
});

function ProfileRoute() {
  const { user, teams } = Route.useRouteContext();
  const prefs = Route.useLoaderData();
  const router = useRouter();

  const handleUpdated = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return (
    <MyProfilePage
      user={user}
      teams={teams}
      onUpdated={handleUpdated}
      prefs={prefs}
      onRefresh={handleUpdated}
    />
  );
}
