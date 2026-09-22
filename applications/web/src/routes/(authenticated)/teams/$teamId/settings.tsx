import { Team } from '@sideline/domain';
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router';
import { Array, Effect, Option, pipe, Schema } from 'effect';
import { TeamSettingsPage } from '~/components/pages/TeamSettingsPage';
import { ApiClient, NotFound, warnAndCatchAll } from '~/lib/runtime';

type SettingsTab = 'general' | 'discord' | 'onboarding' | 'email' | 'finance' | 'automation';

const isSettingsTab = (value: unknown): value is SettingsTab =>
  value === 'general' ||
  value === 'discord' ||
  value === 'onboarding' ||
  value === 'email' ||
  value === 'finance' ||
  value === 'automation';

export const Route = createFileRoute('/(authenticated)/teams/$teamId/settings')({
  component: TeamSettingsRoute,
  ssr: false,
  validateSearch: (search: Record<string, unknown>): { tab?: SettingsTab } =>
    isSettingsTab(search.tab) ? { tab: search.tab } : {},
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
  const { tab: searchTab } = useSearch({ from: Route.id });
  const navigate = useNavigate({ from: Route.fullPath });

  // `?tab=finance` for a caller without bank-sync access, or `?tab=automation`
  // for a team without a manageable generation config, both fall back to
  // `general` — this depends on loader-fetched permissions, so it can't live
  // in `validateSearch`.
  const defaultTab: SettingsTab = 'general';
  const activeTab: SettingsTab =
    (searchTab === 'finance' && !canManageBankSync) ||
    (searchTab === 'automation' && !generationConfig?.canManage)
      ? defaultTab
      : (searchTab ?? defaultTab);

  const handleTabChange = (tab: SettingsTab) => {
    // `replace: true` matters: Radix's TabsList defaults to
    // `activationMode='automatic'`, so arrow-key navigation across the tab
    // strip changes tabs immediately — without `replace` that pushes one
    // history entry per arrow press and the back button stops working.
    navigate({ search: { tab }, replace: true });
  };

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
      activeTab={activeTab}
      onTabChange={handleTabChange}
    />
  );
}
