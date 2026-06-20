import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Effect, Option, pipe, Schema } from 'effect';
import { TeamSettingsPage } from '~/components/pages/TeamSettingsPage';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/settings')({
  component: TeamSettingsRoute,
  ssr: false,
  loader: async ({ params, context }) => {
    const teamId = await pipe(
      params.teamId,
      Schema.decodeEffect(Team.TeamId),
      Effect.mapError(NotFound.make),
      context.run,
    );
    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          settings: api.teamSettings.getTeamSettings({ params: { teamId } }),
          discordChannels: api.group.listDiscordChannels({ params: { teamId } }),
          discordRoles: api.group.listDiscordRoles({ params: { teamId } }),
          teamInfo: api.team.getTeamInfo({ params: { teamId } }),
          emailForwardingConfig: api.emailForwarding
            .getEmailForwardingConfig({ params: { teamId } })
            .pipe(Effect.option),
          generationConfig: api.teamGeneration.getGenerationConfig({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load generation config', e)),
            Effect.catch(() => Effect.succeed(null)),
          ),
        }),
      ),
      warnAndCatchAll,
      context.run,
    );
  },
});

function TeamSettingsRoute() {
  const { teamId: teamIdRaw } = Route.useParams();
  const {
    settings,
    discordChannels,
    discordRoles,
    teamInfo,
    emailForwardingConfig,
    generationConfig,
  } = Route.useLoaderData();

  return (
    <TeamSettingsPage
      teamId={teamIdRaw}
      settings={settings}
      discordChannels={discordChannels}
      discordRoles={discordRoles}
      teamInfo={teamInfo}
      emailForwardingConfig={Option.getOrNull(emailForwardingConfig)}
      initialGenerationConfig={generationConfig}
    />
  );
}
