import { Team } from '@sideline/domain';
import { createFileRoute } from '@tanstack/react-router';
import { Array, Effect, Option, pipe, Schema } from 'effect';
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

    const team = Array.findFirst(context.teams, (t) => t.teamId === params.teamId);
    const permissions = Option.isSome(team) ? team.value.permissions : [];
    const canManageBankSync = permissions.includes('finance:manage_fees');

    return ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        Effect.all({
          settings: api.teamSettings.getTeamSettings({ params: { teamId } }),
          discordChannels: api.group.listDiscordChannels({ params: { teamId } }),
          discordRoles: api.group.listDiscordRoles({ params: { teamId } }),
          groups: api.group.listGroups({ params: { teamId } }),
          teamInfo: api.team.getTeamInfo({ params: { teamId } }),
          emailForwardingConfig: api.emailForwarding
            .getEmailForwardingConfig({ params: { teamId } })
            .pipe(Effect.option),
          generationConfig: api.teamGeneration.getGenerationConfig({ params: { teamId } }).pipe(
            Effect.tapError((e) => Effect.logWarning('Failed to load generation config', e)),
            Effect.catch(() => Effect.succeed(null)),
          ),
          bankSyncConfig: canManageBankSync
            ? api.bankSync.getBankSyncConfig({ params: { teamId } }).pipe(
                Effect.tapError((e) => Effect.logWarning('Failed to load bank sync config', e)),
                Effect.catch(() => Effect.succeed(null)),
              )
            : Effect.succeed(null),
        }),
      ),
      Effect.map((data) => ({ ...data, canManageBankSync })),
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
    groups,
    teamInfo,
    emailForwardingConfig,
    generationConfig,
    bankSyncConfig,
    canManageBankSync,
  } = Route.useLoaderData();

  return (
    <TeamSettingsPage
      teamId={teamIdRaw}
      settings={settings}
      discordChannels={discordChannels}
      discordRoles={discordRoles}
      groups={groups}
      teamInfo={teamInfo}
      emailForwardingConfig={Option.getOrNull(emailForwardingConfig)}
      initialGenerationConfig={generationConfig}
      bankSyncConfig={bankSyncConfig}
      canManageBankSync={canManageBankSync}
    />
  );
}
