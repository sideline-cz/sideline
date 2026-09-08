import type {
  EmailForwardingApi,
  GroupApi,
  TeamApi,
  TeamGenerationApi,
  TeamSettingsApi,
} from '@sideline/domain';
import { Link, useRouter } from '@tanstack/react-router';
import React from 'react';
import { EmailForwardingCard } from '~/components/organisms/team-settings/EmailForwardingCard';
import { GenerationWeightsCard } from '~/components/organisms/team-settings/GenerationWeightsCard';
import { OnboardingCard } from '~/components/organisms/team-settings/OnboardingCard';
import { TeamProfileCard } from '~/components/organisms/team-settings/TeamProfileCard';
import { TeamSettingsSection } from '~/components/organisms/team-settings/TeamSettingsSection';
import { WelcomeMessageCard } from '~/components/organisms/team-settings/WelcomeMessageCard';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

interface TeamSettingsPageProps {
  teamId: string;
  settings: TeamSettingsApi.TeamSettingsInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  discordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
  teamInfo: TeamApi.TeamInfo;
  emailForwardingConfig: EmailForwardingApi.EmailForwardingConfigView | null;
  initialGenerationConfig: TeamGenerationApi.GenerationConfigResponse | null;
}

/**
 * Composition only. Every card below owns its own form state, dirty flag and
 * save handler — see `organisms/team-settings/useCardForm.ts` for why they are
 * not allowed to be spread across this file.
 *
 * Reloading loader data is the page's job (organisms hold no router hooks), so
 * each card asks for it through `onRefresh`.
 */
export function TeamSettingsPage({
  teamId,
  settings,
  discordChannels,
  discordRoles,
  groups,
  teamInfo,
  emailForwardingConfig,
  initialGenerationConfig,
}: TeamSettingsPageProps) {
  const router = useRouter();
  const onRefresh = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return (
    <div>
      <header className='mb-6'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('team_settings')}</h1>
      </header>

      <div className='flex flex-col gap-6 max-w-2xl'>
        <TeamProfileCard teamInfo={teamInfo} onRefresh={onRefresh} />

        <TeamSettingsSection
          settings={settings}
          discordChannels={discordChannels}
          groups={groups}
          onRefresh={onRefresh}
        />

        <WelcomeMessageCard
          teamInfo={teamInfo}
          discordChannels={discordChannels}
          onRefresh={onRefresh}
        />

        <EmailForwardingCard
          teamId={teamId}
          discordChannels={discordChannels}
          initialConfig={emailForwardingConfig}
          onRefresh={onRefresh}
        />

        <OnboardingCard
          teamInfo={teamInfo}
          discordChannels={discordChannels}
          discordRoles={discordRoles}
          onRefresh={onRefresh}
        />

        {initialGenerationConfig?.canManage && (
          <GenerationWeightsCard
            teamId={teamId}
            initialConfig={initialGenerationConfig}
            onRefresh={onRefresh}
          />
        )}
      </div>
    </div>
  );
}
