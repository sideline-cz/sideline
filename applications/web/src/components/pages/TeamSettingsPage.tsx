import type {
  BankSyncApi,
  EmailForwardingApi,
  GroupApi,
  TeamApi,
  TeamGenerationApi,
  TeamSettingsApi,
} from '@sideline/domain';
import type { ShouldBlockFn } from '@tanstack/react-router';
import { Link, useBlocker, useRouter } from '@tanstack/react-router';
import React from 'react';
import { CoachAssignmentCard } from '~/components/organisms/team-settings/CoachAssignmentCard';
import { DiscordDefaultsCard } from '~/components/organisms/team-settings/DiscordDefaultsCard';
import { EmailForwardingCard } from '~/components/organisms/team-settings/EmailForwardingCard';
import { FioBankCard } from '~/components/organisms/team-settings/FioBankCard';
import { GeneralLimitsCard } from '~/components/organisms/team-settings/GeneralLimitsCard';
import { GenerationWeightsCard } from '~/components/organisms/team-settings/GenerationWeightsCard';
import { OnboardingCard } from '~/components/organisms/team-settings/OnboardingCard';
import { RemindersCard } from '~/components/organisms/team-settings/RemindersCard';
import {
  SaveBar,
  SaveBarProvider,
  useSaveBarEntries,
  useSaveBarEntry,
} from '~/components/organisms/team-settings/SaveBar';
import { TeamProfileCard } from '~/components/organisms/team-settings/TeamProfileCard';
import { UnsavedChangesGuard } from '~/components/organisms/team-settings/UnsavedChangesGuard';
import { useTeamSettingsForm } from '~/components/organisms/team-settings/useTeamSettingsForm';
import { WelcomeMessageCard } from '~/components/organisms/team-settings/WelcomeMessageCard';
import { Button } from '~/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '~/components/ui/tabs';
import { tr } from '~/lib/translations.js';

export type TeamSettingsTab =
  | 'general'
  | 'discord'
  | 'onboarding'
  | 'email'
  | 'finance'
  | 'automation';

const isTeamSettingsTab = (value: string): value is TeamSettingsTab =>
  value === 'general' ||
  value === 'discord' ||
  value === 'onboarding' ||
  value === 'email' ||
  value === 'finance' ||
  value === 'automation';

interface TeamSettingsPageProps {
  teamId: string;
  settings: TeamSettingsApi.TeamSettingsInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  discordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
  teamInfo: TeamApi.TeamInfo;
  emailForwardingConfig: EmailForwardingApi.EmailForwardingConfigView | null;
  initialGenerationConfig: TeamGenerationApi.GenerationConfigResponse | null;
  bankSyncConfig: BankSyncApi.BankSyncConfigView | null;
  canManageBankSync: boolean;
  /** Controlled active tab (URL-driven). Requires `onTabChange` too, else the page falls back to internal state. */
  activeTab?: TeamSettingsTab;
  onTabChange?: (tab: TeamSettingsTab) => void;
}

/**
 * Six tabs behind one shared save bar. The four cards saved by
 * `updateTeamSettings` (`GeneralLimitsCard`, `RemindersCard`,
 * `CoachAssignmentCard`, `DiscordDefaultsCard`) share one `useTeamSettingsForm`
 * that lives above the tabs — never inside a tab panel — precisely so
 * switching between the General and Discord tabs cannot unmount it; the
 * remaining cards each own their own `useCardForm` and register one
 * `useSaveBarEntry` apiece. `SaveBar` collects whichever of the seven forms
 * are currently dirty and renders one row per form; there is deliberately no
 * "Save all" button — several of these cards PATCH the same endpoint, and a
 * combined save would fire concurrent, redundant requests.
 *
 * Reloading loader data is the page's job (organisms hold no router hooks),
 * so each card asks for it through `onRefresh`.
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
  bankSyncConfig,
  canManageBankSync,
  activeTab: controlledActiveTab,
  onTabChange,
}: TeamSettingsPageProps) {
  const router = useRouter();
  const onRefresh = React.useCallback(() => {
    router.invalidate();
  }, [router]);

  return (
    <SaveBarProvider>
      <TeamSettingsPageBody
        teamId={teamId}
        settings={settings}
        discordChannels={discordChannels}
        discordRoles={discordRoles}
        groups={groups}
        teamInfo={teamInfo}
        emailForwardingConfig={emailForwardingConfig}
        initialGenerationConfig={initialGenerationConfig}
        bankSyncConfig={bankSyncConfig}
        canManageBankSync={canManageBankSync}
        activeTab={controlledActiveTab}
        onTabChange={onTabChange}
        onRefresh={onRefresh}
      />
    </SaveBarProvider>
  );
}

interface TeamSettingsPageBodyProps extends TeamSettingsPageProps {
  onRefresh: () => void;
}

function TeamSettingsPageBody({
  teamId,
  settings,
  discordChannels,
  discordRoles,
  groups,
  teamInfo,
  emailForwardingConfig,
  initialGenerationConfig,
  bankSyncConfig,
  canManageBankSync,
  activeTab: controlledActiveTab,
  onTabChange,
  onRefresh,
}: TeamSettingsPageBodyProps) {
  const { form, saving, handleSave, handleDiscard } = useTeamSettingsForm(settings, onRefresh);

  useSaveBarEntry({
    id: 'settings',
    label: tr('teamSettings_saveBar_settingsGroup'),
    tab: 'general',
    dirty: form.isDirty,
    saving,
    onSave: handleSave,
    onDiscard: handleDiscard,
  });

  const [internalActiveTab, setInternalActiveTab] = React.useState<TeamSettingsTab>('general');
  const isControlled = controlledActiveTab !== undefined && onTabChange !== undefined;
  const activeTab = isControlled ? controlledActiveTab : internalActiveTab;

  const handleTabChange = (tab: TeamSettingsTab) => {
    if (isControlled) {
      onTabChange(tab);
    } else {
      setInternalActiveTab(tab);
    }
  };

  const entries = useSaveBarEntries();

  const blockedRef = React.useRef(false);
  blockedRef.current = entries.some((e) => !e.saving);

  const shouldBlockFn = React.useCallback<ShouldBlockFn>(
    ({ current, next }) => blockedRef.current && next.pathname !== current.pathname,
    [],
  );
  const enableBeforeUnload = React.useCallback(() => blockedRef.current, []);

  const blocker = useBlocker({ shouldBlockFn, enableBeforeUnload, withResolver: true });

  return (
    <div className='flex flex-1 flex-col'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('team_settings')}</h1>
      </header>

      <Tabs
        value={activeTab}
        onValueChange={(value) => {
          if (isTeamSettingsTab(value)) handleTabChange(value);
        }}
        className='mt-4'
      >
        <TabsList
          aria-label={tr('teamSettings_tabsLabel')}
          variant='line'
          className='w-full flex-wrap justify-start gap-x-1 gap-y-2 group-data-[orientation=horizontal]/tabs:h-auto'
        >
          <TabsTrigger value='general' className='h-9 flex-none'>
            {tr('teamSettings_tab_general')}
          </TabsTrigger>
          <TabsTrigger value='discord' className='h-9 flex-none'>
            {tr('teamSettings_tab_discord')}
          </TabsTrigger>
          <TabsTrigger value='onboarding' className='h-9 flex-none'>
            {tr('teamSettings_tab_onboarding')}
          </TabsTrigger>
          <TabsTrigger value='email' className='h-9 flex-none'>
            {tr('teamSettings_tab_email')}
          </TabsTrigger>
          {canManageBankSync && (
            <TabsTrigger value='finance' className='h-9 flex-none'>
              {tr('teamSettings_tab_finance')}
            </TabsTrigger>
          )}
          {initialGenerationConfig?.canManage && (
            <TabsTrigger value='automation' className='h-9 flex-none'>
              {tr('teamSettings_tab_automation')}
            </TabsTrigger>
          )}
        </TabsList>

        <TabsContent
          value='general'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          <TeamProfileCard teamInfo={teamInfo} onRefresh={onRefresh} />
          <GeneralLimitsCard form={form} />
          <CoachAssignmentCard form={form} />
        </TabsContent>

        <TabsContent
          value='discord'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          <DiscordDefaultsCard form={form} discordChannels={discordChannels} groups={groups} />
          <RemindersCard form={form} discordChannels={discordChannels} />
        </TabsContent>

        <TabsContent
          value='onboarding'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          <WelcomeMessageCard
            teamInfo={teamInfo}
            discordChannels={discordChannels}
            onRefresh={onRefresh}
          />
          <OnboardingCard
            teamInfo={teamInfo}
            discordChannels={discordChannels}
            discordRoles={discordRoles}
            onRefresh={onRefresh}
          />
        </TabsContent>

        <TabsContent
          value='email'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          <EmailForwardingCard
            teamId={teamId}
            discordChannels={discordChannels}
            initialConfig={emailForwardingConfig}
            onRefresh={onRefresh}
          />
        </TabsContent>

        <TabsContent
          value='finance'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          {canManageBankSync && (
            <FioBankCard teamId={teamId} initialConfig={bankSyncConfig} onRefresh={onRefresh} />
          )}
        </TabsContent>

        <TabsContent
          value='automation'
          forceMount
          className='data-[state=inactive]:hidden flex flex-col gap-6 max-w-2xl'
        >
          {initialGenerationConfig?.canManage && (
            <GenerationWeightsCard
              teamId={teamId}
              initialConfig={initialGenerationConfig}
              onRefresh={onRefresh}
            />
          )}
        </TabsContent>
      </Tabs>

      <SaveBar
        onInvalid={(tab) => {
          if (isTeamSettingsTab(tab)) handleTabChange(tab);
        }}
      />

      <UnsavedChangesGuard
        open={blocker.status === 'blocked'}
        onStay={() => {
          if (blocker.status === 'blocked') blocker.reset();
        }}
        onLeave={() => {
          if (blocker.status === 'blocked') blocker.proceed();
        }}
      />
    </div>
  );
}
