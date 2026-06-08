import type { EmailForwardingApi, GroupApi, TeamApi, TeamSettingsApi } from '@sideline/domain';
import { ChannelSyncEvent, Discord, Team } from '@sideline/domain';
import { applyTemplate, sanitizeRendered } from '@sideline/template-renderer';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import {
  AlertTriangle,
  Copy,
  Mail,
  MessageSquare,
  Settings,
  ShieldCheck,
  Users,
} from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Alert, AlertDescription } from '~/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '~/components/ui/alert-dialog';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { Textarea } from '~/components/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { useFormatDate } from '~/hooks/useFormatDate';
import { DISCORD_CHANNEL_TYPE_CATEGORY, DISCORD_CHANNEL_TYPE_TEXT } from '~/lib/discord';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { useServerUrl } from '~/lib/translation-overrides-context.js';
import { tr } from '~/lib/translations.js';

interface TeamSettingsPageProps {
  teamId: string;
  settings: TeamSettingsApi.TeamSettingsInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  discordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  teamInfo: TeamApi.TeamInfo;
  emailForwardingConfig: EmailForwardingApi.EmailForwardingConfigView | null;
}

const NONE_VALUE = '__none__';
const DEFAULT_ROLE_FORMAT = '{emoji} {name}';
const DEFAULT_CHANNEL_FORMAT = '{emoji}\u2502{name}';

const isFormatValid = (format: string) => format.includes('{name}');

const renderFormatPreview = (format: string, isChannel: boolean) => {
  const emoji = '\u{1F3C0}';
  const name = isChannel ? 'seniors' : 'Seniors';
  return format.replaceAll('{emoji}', emoji).replaceAll('{name}', name).trim();
};

export function TeamSettingsPage({
  teamId,
  settings,
  discordChannels,
  discordRoles,
  teamInfo,
  emailForwardingConfig,
}: TeamSettingsPageProps) {
  const run = useRun();
  const router = useRouter();
  const { formatRelative } = useFormatDate();

  // Team profile state
  const [teamName, setTeamName] = React.useState(teamInfo.name);
  const [description, setDescription] = React.useState(
    Option.getOrElse(teamInfo.description, () => ''),
  );
  const [sport, setSport] = React.useState(Option.getOrElse(teamInfo.sport, () => ''));
  const [logoUrl, setLogoUrl] = React.useState(Option.getOrElse(teamInfo.logoUrl, () => ''));
  const [savingProfile, setSavingProfile] = React.useState(false);

  // General settings state
  const [horizonDays, setHorizonDays] = React.useState(String(settings.eventHorizonDays));
  const [minPlayersThreshold, setMinPlayersThreshold] = React.useState(
    String(settings.minPlayersThreshold),
  );
  const [rsvpRemindersEnabled, setRsvpRemindersEnabled] = React.useState(
    settings.rsvpRemindersEnabled,
  );
  const [rsvpReminderDaysBefore, setRsvpReminderDaysBefore] = React.useState(
    String(settings.rsvpReminderDaysBefore),
  );
  const [claimRequestDaysBefore, setClaimRequestDaysBefore] = React.useState(
    String(settings.claimRequestDaysBefore),
  );
  const [rsvpReminderTime, setRsvpReminderTime] = React.useState(
    settings.rsvpReminderTime || '18:00',
  );
  const [timezone, setTimezone] = React.useState(settings.timezone || 'Europe/Prague');
  const [remindersChannelId, setRemindersChannelId] = React.useState(
    Option.getOrElse(settings.remindersChannelId, () => NONE_VALUE),
  );

  // Discord channels state
  const [channelTraining, setChannelTraining] = React.useState(
    Option.getOrElse(settings.discordChannelTraining, () => NONE_VALUE),
  );
  const [channelMatch, setChannelMatch] = React.useState(
    Option.getOrElse(settings.discordChannelMatch, () => NONE_VALUE),
  );
  const [channelTournament, setChannelTournament] = React.useState(
    Option.getOrElse(settings.discordChannelTournament, () => NONE_VALUE),
  );
  const [channelMeeting, setChannelMeeting] = React.useState(
    Option.getOrElse(settings.discordChannelMeeting, () => NONE_VALUE),
  );
  const [channelSocial, setChannelSocial] = React.useState(
    Option.getOrElse(settings.discordChannelSocial, () => NONE_VALUE),
  );
  const [channelOther, setChannelOther] = React.useState(
    Option.getOrElse(settings.discordChannelOther, () => NONE_VALUE),
  );
  const [channelLateRsvp, setChannelLateRsvp] = React.useState(
    Option.getOrElse(settings.discordChannelLateRsvp, () => NONE_VALUE),
  );
  const [archiveCategory, setArchiveCategory] = React.useState(
    Option.getOrElse(settings.discordArchiveCategoryId, () => NONE_VALUE),
  );
  const [cleanupOnGroupDelete, setCleanupOnGroupDelete] = React.useState(
    settings.discordChannelCleanupOnGroupDelete,
  );
  const [cleanupOnRosterDeactivate, setCleanupOnRosterDeactivate] = React.useState(
    settings.discordChannelCleanupOnRosterDeactivate,
  );
  const [createDiscordChannelOnGroup, setCreateDiscordChannelOnGroup] = React.useState(
    settings.createDiscordChannelOnGroup,
  );
  const [createDiscordChannelOnRoster, setCreateDiscordChannelOnRoster] = React.useState(
    settings.createDiscordChannelOnRoster,
  );
  const [roleFormat, setRoleFormat] = React.useState(settings.discordRoleFormat);
  const [channelFormat, setChannelFormat] = React.useState(settings.discordChannelFormat);
  const [savingSettings, setSavingSettings] = React.useState(false);

  // Welcome settings state
  const [welcomeChannel, setWelcomeChannel] = React.useState(
    Option.getOrElse(teamInfo.welcomeChannelId, () => NONE_VALUE),
  );
  const [systemLogChannel, setSystemLogChannel] = React.useState(
    Option.getOrElse(teamInfo.systemLogChannelId, () => NONE_VALUE),
  );
  const [achievementChannel, setAchievementChannel] = React.useState(
    Option.getOrElse(teamInfo.achievementChannelId, () => NONE_VALUE),
  );
  const [welcomeTemplate, setWelcomeTemplate] = React.useState(
    Option.getOrElse(teamInfo.welcomeMessageTemplate, () => ''),
  );
  const [savingWelcome, setSavingWelcome] = React.useState(false);

  // Onboarding settings state
  const [onboardingRulesChannel, setOnboardingRulesChannel] = React.useState(
    Option.getOrElse(teamInfo.rulesChannelId, () => NONE_VALUE),
  );
  const [onboardingRole, setOnboardingRole] = React.useState(
    Option.getOrElse(teamInfo.onboardingRulesRoleId, () => NONE_VALUE),
  );
  const [onboardingLocale, setOnboardingLocale] = React.useState(teamInfo.onboardingLocale);
  const [savingOnboarding, setSavingOnboarding] = React.useState(false);
  const [retryingOnboarding, setRetryingOnboarding] = React.useState(false);

  const hasOnboardingChanges =
    onboardingRulesChannel !== Option.getOrElse(teamInfo.rulesChannelId, () => NONE_VALUE) ||
    onboardingRole !== Option.getOrElse(teamInfo.onboardingRulesRoleId, () => NONE_VALUE) ||
    onboardingLocale !== teamInfo.onboardingLocale;

  const isCommunityEnabled = teamInfo.isCommunityEnabled;

  const filteredDiscordRoles = React.useMemo(
    () => discordRoles.filter((role) => role.id !== teamInfo.guildId && !role.managed),
    [discordRoles, teamInfo.guildId],
  );

  const hasWelcomeChanges =
    welcomeChannel !== Option.getOrElse(teamInfo.welcomeChannelId, () => NONE_VALUE) ||
    systemLogChannel !== Option.getOrElse(teamInfo.systemLogChannelId, () => NONE_VALUE) ||
    achievementChannel !== Option.getOrElse(teamInfo.achievementChannelId, () => NONE_VALUE) ||
    welcomeTemplate !== Option.getOrElse(teamInfo.welcomeMessageTemplate, () => '');

  const welcomePreview = React.useMemo(() => {
    if (!welcomeTemplate.trim()) return '';
    return sanitizeRendered(
      applyTemplate(welcomeTemplate, {
        memberMention: '<@123456789>',
        memberName: 'Alex',
        inviterMention: '<@987654321>',
        inviterName: 'Captain',
        groupName: 'Goalkeepers',
        teamName: teamInfo.name,
      }),
    );
  }, [welcomeTemplate, teamInfo.name]);

  const hasProfileChanges =
    teamName !== teamInfo.name ||
    description !== Option.getOrElse(teamInfo.description, () => '') ||
    sport !== Option.getOrElse(teamInfo.sport, () => '') ||
    logoUrl !== Option.getOrElse(teamInfo.logoUrl, () => '');

  const hasSettingsChanges =
    horizonDays !== String(settings.eventHorizonDays) ||
    minPlayersThreshold !== String(settings.minPlayersThreshold) ||
    rsvpRemindersEnabled !== settings.rsvpRemindersEnabled ||
    rsvpReminderDaysBefore !== String(settings.rsvpReminderDaysBefore) ||
    claimRequestDaysBefore !== String(settings.claimRequestDaysBefore) ||
    rsvpReminderTime !== (settings.rsvpReminderTime || '18:00') ||
    timezone !== (settings.timezone || 'Europe/Prague') ||
    remindersChannelId !== Option.getOrElse(settings.remindersChannelId, () => NONE_VALUE) ||
    channelTraining !== Option.getOrElse(settings.discordChannelTraining, () => NONE_VALUE) ||
    channelMatch !== Option.getOrElse(settings.discordChannelMatch, () => NONE_VALUE) ||
    channelTournament !== Option.getOrElse(settings.discordChannelTournament, () => NONE_VALUE) ||
    channelMeeting !== Option.getOrElse(settings.discordChannelMeeting, () => NONE_VALUE) ||
    channelSocial !== Option.getOrElse(settings.discordChannelSocial, () => NONE_VALUE) ||
    channelOther !== Option.getOrElse(settings.discordChannelOther, () => NONE_VALUE) ||
    channelLateRsvp !== Option.getOrElse(settings.discordChannelLateRsvp, () => NONE_VALUE) ||
    archiveCategory !== Option.getOrElse(settings.discordArchiveCategoryId, () => NONE_VALUE) ||
    cleanupOnGroupDelete !== settings.discordChannelCleanupOnGroupDelete ||
    cleanupOnRosterDeactivate !== settings.discordChannelCleanupOnRosterDeactivate ||
    createDiscordChannelOnGroup !== settings.createDiscordChannelOnGroup ||
    createDiscordChannelOnRoster !== settings.createDiscordChannelOnRoster ||
    roleFormat !== settings.discordRoleFormat ||
    channelFormat !== settings.discordChannelFormat;

  const channelToOption = React.useCallback(
    (value: string) =>
      value !== NONE_VALUE ? Option.some(Discord.Snowflake.makeUnsafe(value)) : Option.none(),
    [],
  );

  const decodeCleanupMode = Schema.decodeUnknownSync(ChannelSyncEvent.ChannelCleanupMode);

  const handleSaveProfile = React.useCallback(async () => {
    if (!teamName.trim()) return;
    setSavingProfile(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: {
            name: Option.some(teamName.trim()),
            description: Option.some(
              description.trim() ? Option.some(description.trim()) : Option.none(),
            ),
            sport: Option.some(sport.trim() ? Option.some(sport.trim()) : Option.none()),
            logoUrl: Option.some(logoUrl.trim() ? Option.some(logoUrl.trim()) : Option.none()),
            welcomeChannelId: Option.none(),
            systemLogChannelId: Option.none(),
            achievementChannelId: Option.none(),
            welcomeMessageTemplate: Option.none(),
            rulesChannelId: Option.none(),
            onboardingRulesRoleId: Option.none(),
            onboardingLocale: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_profileSaveFailed'))),
      run({ success: tr('teamSettings_profileSaved') }),
    );
    setSavingProfile(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamInfo.teamId, teamName, description, sport, logoUrl, run, router]);

  const handleSaveSettings = React.useCallback(async () => {
    const parsed = Number.parseInt(horizonDays, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 365) return;
    const parsedThreshold = Number.parseInt(minPlayersThreshold, 10);
    if (Number.isNaN(parsedThreshold) || parsedThreshold < 0 || parsedThreshold > 100) return;
    const parsedReminderDaysBefore = Number.parseInt(rsvpReminderDaysBefore, 10);
    if (
      Number.isNaN(parsedReminderDaysBefore) ||
      parsedReminderDaysBefore < 0 ||
      parsedReminderDaysBefore > 14
    )
      return;
    const parsedClaimDaysBefore = Number(claimRequestDaysBefore);
    if (
      !Number.isInteger(parsedClaimDaysBefore) ||
      parsedClaimDaysBefore < 0 ||
      parsedClaimDaysBefore > 30
    )
      return;
    if (!isFormatValid(roleFormat) || !isFormatValid(channelFormat)) return;
    setSavingSettings(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamSettings.updateTeamSettings({
          params: { teamId: settings.teamId },
          payload: {
            eventHorizonDays: Option.some(parsed),
            minPlayersThreshold: Option.some(parsedThreshold),
            rsvpRemindersEnabled: Option.some(rsvpRemindersEnabled),
            rsvpReminderDaysBefore: Option.some(parsedReminderDaysBefore),
            claimRequestDaysBefore: Option.some(parsedClaimDaysBefore),
            rsvpReminderTime: Option.some(rsvpReminderTime),
            timezone: Option.some(timezone),
            remindersChannelId: Option.some(channelToOption(remindersChannelId)),
            discordChannelTraining: Option.some(channelToOption(channelTraining)),
            discordChannelMatch: Option.some(channelToOption(channelMatch)),
            discordChannelTournament: Option.some(channelToOption(channelTournament)),
            discordChannelMeeting: Option.some(channelToOption(channelMeeting)),
            discordChannelSocial: Option.some(channelToOption(channelSocial)),
            discordChannelOther: Option.some(channelToOption(channelOther)),
            discordChannelLateRsvp: Option.some(channelToOption(channelLateRsvp)),
            discordArchiveCategoryId: Option.some(channelToOption(archiveCategory)),
            discordChannelCleanupOnGroupDelete: Option.some(cleanupOnGroupDelete),
            discordChannelCleanupOnRosterDeactivate: Option.some(cleanupOnRosterDeactivate),
            createDiscordChannelOnGroup: Option.some(createDiscordChannelOnGroup),
            createDiscordChannelOnRoster: Option.some(createDiscordChannelOnRoster),
            discordRoleFormat: Option.some(roleFormat),
            discordChannelFormat: Option.some(channelFormat),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_saveFailed'))),
      run({ success: tr('teamSettings_saved') }),
    );
    setSavingSettings(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    settings.teamId,
    horizonDays,
    minPlayersThreshold,
    rsvpRemindersEnabled,
    rsvpReminderDaysBefore,
    claimRequestDaysBefore,
    rsvpReminderTime,
    timezone,
    remindersChannelId,
    channelTraining,
    channelMatch,
    channelTournament,
    channelMeeting,
    channelSocial,
    channelOther,
    channelLateRsvp,
    archiveCategory,
    cleanupOnGroupDelete,
    cleanupOnRosterDeactivate,
    createDiscordChannelOnGroup,
    createDiscordChannelOnRoster,
    roleFormat,
    channelFormat,
    run,
    router,
    channelToOption,
  ]);

  const handleSaveWelcome = React.useCallback(async () => {
    setSavingWelcome(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: {
            name: Option.none(),
            description: Option.none(),
            sport: Option.none(),
            logoUrl: Option.none(),
            welcomeChannelId: Option.some(channelToOption(welcomeChannel)),
            systemLogChannelId: Option.some(channelToOption(systemLogChannel)),
            achievementChannelId: Option.some(channelToOption(achievementChannel)),
            welcomeMessageTemplate: Option.some(
              welcomeTemplate.trim() ? Option.some(welcomeTemplate.trim()) : Option.none(),
            ),
            rulesChannelId: Option.none(),
            onboardingRulesRoleId: Option.none(),
            onboardingLocale: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({ success: tr('teamSettings_welcomeSaved') }),
    );
    setSavingWelcome(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    teamInfo.teamId,
    welcomeChannel,
    systemLogChannel,
    achievementChannel,
    welcomeTemplate,
    channelToOption,
    run,
    router,
  ]);

  const handleSaveOnboarding = React.useCallback(async () => {
    setSavingOnboarding(true);
    toast(tr('teamSettings_onboardingSavedSyncing'), { duration: 3000 });
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: {
            name: Option.none(),
            description: Option.none(),
            sport: Option.none(),
            logoUrl: Option.none(),
            welcomeChannelId: Option.none(),
            systemLogChannelId: Option.none(),
            achievementChannelId: Option.none(),
            welcomeMessageTemplate: Option.none(),
            rulesChannelId: Option.some(channelToOption(onboardingRulesChannel)),
            onboardingRulesRoleId: Option.some(channelToOption(onboardingRole)),
            onboardingLocale: Option.some(onboardingLocale),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({}),
    );
    setSavingOnboarding(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    teamInfo.teamId,
    onboardingRulesChannel,
    onboardingRole,
    onboardingLocale,
    channelToOption,
    run,
    router,
  ]);

  const handleRetryOnboarding = React.useCallback(async () => {
    setRetryingOnboarding(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.retryOnboardingSync({
          params: { teamId: teamInfo.teamId },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({}),
    );
    setRetryingOnboarding(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [teamInfo.teamId, run, router]);

  const channelConfigs = [
    {
      key: 'training',
      value: channelTraining,
      setter: setChannelTraining,
      label: tr('teamSettings_channelTraining'),
    },
    {
      key: 'match',
      value: channelMatch,
      setter: setChannelMatch,
      label: tr('teamSettings_channelMatch'),
    },
    {
      key: 'tournament',
      value: channelTournament,
      setter: setChannelTournament,
      label: tr('teamSettings_channelTournament'),
    },
    {
      key: 'meeting',
      value: channelMeeting,
      setter: setChannelMeeting,
      label: tr('teamSettings_channelMeeting'),
    },
    {
      key: 'social',
      value: channelSocial,
      setter: setChannelSocial,
      label: tr('teamSettings_channelSocial'),
    },
    {
      key: 'other',
      value: channelOther,
      setter: setChannelOther,
      label: tr('teamSettings_channelOther'),
    },
    {
      key: 'lateRsvp',
      value: channelLateRsvp,
      setter: setChannelLateRsvp,
      label: tr('teamSettings_channelLateRsvp'),
    },
  ] as const;

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
        {/* Team Profile */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <Users className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{tr('teamSettings_teamProfile')}</CardTitle>
            </div>
            <CardDescription>{tr('teamSettings_teamProfileDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              {logoUrl.trim() && (
                <div className='flex justify-center'>
                  <Avatar className='size-20'>
                    <AvatarImage src={logoUrl.trim()} alt={teamName} />
                    <AvatarFallback>{teamName.slice(0, 2).toUpperCase()}</AvatarFallback>
                  </Avatar>
                </div>
              )}
              <div>
                <label htmlFor='team-name' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_teamName')}
                </label>
                <Input
                  id='team-name'
                  type='text'
                  maxLength={100}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor='team-description' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_description')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_descriptionHelp')}
                </p>
                <Textarea
                  id='team-description'
                  maxLength={500}
                  rows={3}
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor='team-sport' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_sport')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>{tr('teamSettings_sportHelp')}</p>
                <Input
                  id='team-sport'
                  type='text'
                  maxLength={50}
                  value={sport}
                  onChange={(e) => setSport(e.target.value)}
                />
              </div>
              <div>
                <label htmlFor='team-logo-url' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_logoUrl')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_logoUrlHelp')}
                </p>
                <Input
                  id='team-logo-url'
                  type='url'
                  maxLength={2048}
                  value={logoUrl}
                  onChange={(e) => setLogoUrl(e.target.value)}
                  placeholder='https://...'
                />
              </div>
              <div className='flex items-center gap-3'>
                <Button onClick={handleSaveProfile} disabled={savingProfile || !hasProfileChanges}>
                  {savingProfile ? tr('profile_saving') : tr('profile_saveChanges')}
                </Button>
                {hasProfileChanges && (
                  <p className='text-sm text-muted-foreground'>
                    {tr('teamSettings_unsavedChanges')}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* General Settings */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <Settings className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{tr('teamSettings_generalTitle')}</CardTitle>
            </div>
            <CardDescription>{tr('teamSettings_generalDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='horizon-days' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_horizonDays')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_horizonDaysHelp')}
                </p>
                <Input
                  id='horizon-days'
                  type='number'
                  min={1}
                  max={365}
                  value={horizonDays}
                  onChange={(e) => setHorizonDays(e.target.value)}
                  className='max-w-32'
                />
              </div>
              <Separator />
              <div>
                <label htmlFor='min-players' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_minPlayersThreshold')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_minPlayersThresholdHelp')}
                </p>
                <Input
                  id='min-players'
                  type='number'
                  min={0}
                  max={100}
                  value={minPlayersThreshold}
                  onChange={(e) => setMinPlayersThreshold(e.target.value)}
                  className='max-w-32'
                />
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Reminders */}
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>{tr('teamSettings_remindersChannel')}</CardTitle>
            <CardDescription>{tr('teamSettings_rsvpReminderHelp')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='reminders-channel' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_remindersChannel')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_remindersChannelHelp')}
                </p>
                <SearchableSelect
                  id='reminders-channel'
                  value={remindersChannelId}
                  onValueChange={setRemindersChannelId}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <Separator />
              <div className='flex items-center gap-2'>
                <input
                  id='rsvp-reminders-enabled'
                  type='checkbox'
                  checked={rsvpRemindersEnabled}
                  onChange={(e) => setRsvpRemindersEnabled(e.target.checked)}
                  className='h-4 w-4'
                />
                <label htmlFor='rsvp-reminders-enabled' className='text-sm font-medium'>
                  {tr('teamSettings_rsvpRemindersEnabled')}
                </label>
              </div>
              <div>
                <label
                  htmlFor='rsvp-reminder-days-before'
                  className='text-sm font-medium mb-1 block'
                >
                  {tr('teamSettings_rsvpReminderDaysBefore')}
                </label>
                <Input
                  id='rsvp-reminder-days-before'
                  type='number'
                  min={0}
                  max={14}
                  value={rsvpReminderDaysBefore}
                  onChange={(e) => setRsvpReminderDaysBefore(e.target.value)}
                  disabled={!rsvpRemindersEnabled}
                  className='max-w-32'
                />
              </div>
              <div>
                <label htmlFor='rsvp-reminder-time' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_rsvpReminderTime')}
                </label>
                <input
                  id='rsvp-reminder-time'
                  type='time'
                  value={rsvpReminderTime}
                  onChange={(e) => setRsvpReminderTime(e.target.value)}
                  className='flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors max-w-32'
                />
              </div>
              <div>
                <label htmlFor='timezone' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_timezone')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_timezoneHelp')}
                </p>
                <select
                  id='timezone'
                  value={timezone}
                  onChange={(e) => setTimezone(e.target.value)}
                  className='flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors max-w-xs'
                >
                  {Intl.supportedValuesOf('timeZone').map((tz) => (
                    <option key={tz} value={tz}>
                      {tz}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Coach assignment */}
        <Card>
          <CardHeader>
            <CardTitle className='text-base'>{tr('teamSettings_coachAssignment')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div>
              <label htmlFor='claim-request-days-before' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_claimRequestDaysBefore')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('teamSettings_claimRequestHelp')}
              </p>
              <Input
                id='claim-request-days-before'
                type='number'
                min={0}
                max={30}
                value={claimRequestDaysBefore}
                onChange={(e) => setClaimRequestDaysBefore(e.target.value)}
                className='max-w-32'
              />
            </div>
          </CardContent>
        </Card>

        {/* Discord Channel Defaults */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <MessageSquare className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{tr('teamSettings_discordChannels')}</CardTitle>
            </div>
            <CardDescription>{tr('teamSettings_discordChannelsHelp')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-6'>
              {/* Naming formats */}
              <div className='space-y-4'>
                <h4 className='font-medium'>{tr('teamSettings_namingFormats')}</h4>
                <div className='grid gap-4'>
                  {/* Role format */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label>{tr('teamSettings_roleFormat')}</Label>
                      {roleFormat !== DEFAULT_ROLE_FORMAT && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto p-0 text-xs'
                          onClick={() => setRoleFormat(DEFAULT_ROLE_FORMAT)}
                        >
                          {tr('teamSettings_formatResetDefault')}
                        </Button>
                      )}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {tr('teamSettings_roleFormatHelp', { emoji: '{emoji}', name: '{name}' })}
                    </p>
                    <Input value={roleFormat} onChange={(e) => setRoleFormat(e.target.value)} />
                    <div className='text-xs text-muted-foreground'>
                      <span>{tr('teamSettings_formatPreview')} </span>
                      <span className='font-mono'>{renderFormatPreview(roleFormat, false)}</span>
                    </div>
                    {!isFormatValid(roleFormat) && (
                      <p className='text-xs text-destructive'>
                        {tr('teamSettings_formatMustIncludeName', { name: '{name}' })}
                      </p>
                    )}
                  </div>
                  {/* Channel format */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label>{tr('teamSettings_channelFormat')}</Label>
                      {channelFormat !== DEFAULT_CHANNEL_FORMAT && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto p-0 text-xs'
                          onClick={() => setChannelFormat(DEFAULT_CHANNEL_FORMAT)}
                        >
                          {tr('teamSettings_formatResetDefault')}
                        </Button>
                      )}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {tr('teamSettings_channelFormatHelp', { emoji: '{emoji}', name: '{name}' })}
                    </p>
                    <Input
                      value={channelFormat}
                      onChange={(e) => setChannelFormat(e.target.value)}
                    />
                    <div className='text-xs text-muted-foreground'>
                      <span>{tr('teamSettings_formatPreview')} </span>
                      <span className='font-mono'>{renderFormatPreview(channelFormat, true)}</span>
                    </div>
                    {!isFormatValid(channelFormat) && (
                      <p className='text-xs text-destructive'>
                        {tr('teamSettings_formatMustIncludeName', { name: '{name}' })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <Separator />

              {/* Event notification channels */}
              <div>
                <h4 className='text-sm font-semibold mb-3'>
                  {tr('teamSettings_discordEventChannels')}
                </h4>
                <div className='grid grid-cols-1 gap-4 sm:grid-cols-2'>
                  {channelConfigs.map(({ key, value, setter, label }) => (
                    <div key={key}>
                      <label htmlFor={`channel-${key}`} className='text-sm font-medium mb-1 block'>
                        {label}
                      </label>
                      <SearchableSelect
                        id={`channel-${key}`}
                        value={value}
                        onValueChange={setter}
                        placeholder={tr('teamSettings_channelNone')}
                        pinnedValues={[NONE_VALUE]}
                        options={[
                          { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
                          ...discordChannels
                            .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                            .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                        ]}
                      />
                    </div>
                  ))}
                </div>
              </div>

              <Separator />

              {/* Group channels sub-section */}
              <div className='flex flex-col gap-4'>
                <h4 className='text-sm font-semibold'>{tr('teamSettings_groupChannelSettings')}</h4>
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <label htmlFor='create-discord-channel' className='text-sm font-medium block'>
                      {tr('teamSettings_createDiscordChannelOnGroup')}
                    </label>
                    <p className='text-xs text-muted-foreground mt-1'>
                      {tr('teamSettings_createDiscordChannelOnGroupHelp')}
                    </p>
                  </div>
                  <Switch
                    id='create-discord-channel'
                    checked={createDiscordChannelOnGroup}
                    onCheckedChange={setCreateDiscordChannelOnGroup}
                  />
                </div>
                <div>
                  <label
                    htmlFor='cleanup-on-group-delete'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('teamSettings_channelCleanupOnGroupDelete')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('teamSettings_channelCleanupOnGroupDeleteHelp')}
                  </p>
                  <Select
                    value={cleanupOnGroupDelete}
                    onValueChange={(v) => setCleanupOnGroupDelete(decodeCleanupMode(v))}
                  >
                    <SelectTrigger id='cleanup-on-group-delete'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='nothing'>{tr('teamSettings_cleanupNothing')}</SelectItem>
                      <SelectItem value='delete'>{tr('teamSettings_cleanupDelete')}</SelectItem>
                      <SelectItem value='archive'>{tr('teamSettings_cleanupArchive')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* Roster channels sub-section */}
              <div className='flex flex-col gap-4'>
                <h4 className='text-sm font-semibold'>
                  {tr('teamSettings_rosterChannelSettings')}
                </h4>
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <label
                      htmlFor='create-discord-channel-roster'
                      className='text-sm font-medium block'
                    >
                      {tr('teamSettings_createDiscordChannelOnRoster')}
                    </label>
                    <p className='text-xs text-muted-foreground mt-1'>
                      {tr('teamSettings_createDiscordChannelOnRosterHelp')}
                    </p>
                  </div>
                  <Switch
                    id='create-discord-channel-roster'
                    checked={createDiscordChannelOnRoster}
                    onCheckedChange={setCreateDiscordChannelOnRoster}
                  />
                </div>
                <div>
                  <label
                    htmlFor='cleanup-on-roster-deactivate'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('teamSettings_channelCleanupOnRosterDeactivate')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('teamSettings_channelCleanupOnRosterDeactivateHelp')}
                  </p>
                  <Select
                    value={cleanupOnRosterDeactivate}
                    onValueChange={(v) => setCleanupOnRosterDeactivate(decodeCleanupMode(v))}
                  >
                    <SelectTrigger id='cleanup-on-roster-deactivate'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='nothing'>{tr('teamSettings_cleanupNothing')}</SelectItem>
                      <SelectItem value='delete'>{tr('teamSettings_cleanupDelete')}</SelectItem>
                      <SelectItem value='archive'>{tr('teamSettings_cleanupArchive')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {/* Archive category (shared, shown when either mode is archive) */}
              {(cleanupOnGroupDelete === 'archive' || cleanupOnRosterDeactivate === 'archive') && (
                <>
                  <Separator />
                  <div>
                    <label htmlFor='archive-category' className='text-sm font-medium mb-1 block'>
                      {tr('teamSettings_archiveCategory')}
                    </label>
                    <p className='text-xs text-muted-foreground mb-2'>
                      {tr('teamSettings_archiveCategoryHelp')}
                    </p>
                    <SearchableSelect
                      id='archive-category'
                      value={archiveCategory}
                      onValueChange={setArchiveCategory}
                      placeholder={tr('teamSettings_channelNone')}
                      pinnedValues={[NONE_VALUE]}
                      options={[
                        { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
                        ...discordChannels
                          .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_CATEGORY)
                          .map((ch) => ({ value: ch.id, label: ch.name })),
                      ]}
                    />
                  </div>
                </>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Settings save button */}
        <div className='flex items-center gap-3'>
          <Button onClick={handleSaveSettings} disabled={savingSettings || !hasSettingsChanges}>
            {savingSettings ? tr('profile_saving') : tr('profile_saveChanges')}
          </Button>
          {hasSettingsChanges && (
            <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
          )}
        </div>

        {/* Welcome Message */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <MessageSquare className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{tr('teamSettings_welcomeTitle')}</CardTitle>
            </div>
            <CardDescription>{tr('teamSettings_welcomeDescription')}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='welcome-channel' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_welcomeChannel')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_welcomeChannelHelp')}
                </p>
                <SearchableSelect
                  id='welcome-channel'
                  value={welcomeChannel}
                  onValueChange={setWelcomeChannel}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <div>
                <label htmlFor='system-log-channel' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_systemLogChannel')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_systemLogChannelHelp')}
                </p>
                <SearchableSelect
                  id='system-log-channel'
                  value={systemLogChannel}
                  onValueChange={setSystemLogChannel}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <div>
                <label htmlFor='achievement-channel' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_achievementChannel')}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_achievementChannelHelp')}
                </p>
                <SearchableSelect
                  id='achievement-channel'
                  value={achievementChannel}
                  onValueChange={setAchievementChannel}
                  placeholder={tr('teamSettings_achievementChannelDisabled')}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: tr('teamSettings_achievementChannelDisabled') },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <div>
                <Label htmlFor='welcome-template'>{tr('teamSettings_welcomeTemplate')}</Label>
                <p className='text-xs text-muted-foreground mt-1 mb-2'>
                  {tr('teamSettings_welcomeTemplateHelp')}
                </p>
                <Textarea
                  id='welcome-template'
                  rows={4}
                  maxLength={500}
                  value={welcomeTemplate}
                  onChange={(e) => setWelcomeTemplate(e.target.value)}
                  placeholder='Welcome {memberMention} to {teamName}!'
                />
              </div>
              {welcomePreview && (
                <div>
                  <p className='text-xs font-medium text-muted-foreground mb-2'>
                    {tr('teamSettings_welcomePreview')}
                  </p>
                  <div className='rounded-md border border-border bg-muted/40 px-4 py-3 flex gap-3'>
                    <div className='w-1 rounded-full bg-[#5865F2] shrink-0' />
                    <p className='text-sm font-mono whitespace-pre-wrap break-words'>
                      {welcomePreview}
                    </p>
                  </div>
                </div>
              )}
              <div className='flex items-center gap-3'>
                <Button onClick={handleSaveWelcome} disabled={savingWelcome || !hasWelcomeChanges}>
                  {savingWelcome ? tr('profile_saving') : tr('profile_saveChanges')}
                </Button>
                {hasWelcomeChanges && (
                  <p className='text-sm text-muted-foreground'>
                    {tr('teamSettings_unsavedChanges')}
                  </p>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Onboarding */}
        <OnboardingCard
          teamInfo={teamInfo}
          discordChannels={discordChannels}
          filteredDiscordRoles={filteredDiscordRoles}
          isCommunityEnabled={isCommunityEnabled}
          onboardingRulesChannel={onboardingRulesChannel}
          setOnboardingRulesChannel={setOnboardingRulesChannel}
          onboardingRole={onboardingRole}
          setOnboardingRole={setOnboardingRole}
          onboardingLocale={onboardingLocale}
          setOnboardingLocale={(v) => setOnboardingLocale(v as 'en' | 'cs')}
          hasOnboardingChanges={hasOnboardingChanges}
          savingOnboarding={savingOnboarding}
          retryingOnboarding={retryingOnboarding}
          handleSaveOnboarding={handleSaveOnboarding}
          handleRetryOnboarding={handleRetryOnboarding}
          formatRelative={formatRelative}
        />

        {/* Email Forwarding */}
        <EmailForwardingCard
          teamId={teamId}
          discordChannels={discordChannels}
          initialConfig={emailForwardingConfig}
        />
      </div>
    </div>
  );
}

interface OnboardingCardProps {
  teamInfo: TeamApi.TeamInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  filteredDiscordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  isCommunityEnabled: boolean;
  onboardingRulesChannel: string;
  setOnboardingRulesChannel: (v: string) => void;
  onboardingRole: string;
  setOnboardingRole: (v: string) => void;
  onboardingLocale: string;
  setOnboardingLocale: (v: string) => void;
  hasOnboardingChanges: boolean;
  savingOnboarding: boolean;
  retryingOnboarding: boolean;
  handleSaveOnboarding: () => void;
  handleRetryOnboarding: () => void;
  formatRelative: (date: Date) => string;
}

// Walk a Discord error tree looking for the deepest human-readable message.
// Discord wraps validation errors as { errors: { <field>: { _errors: [{ code, message }] } } }
// and we want the innermost `message`, not the top-level "Invalid Form Body".
function extractDiscordMessage(node: unknown): string | undefined {
  if (node === null || typeof node !== 'object') return undefined;
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj._errors)) {
    for (const entry of obj._errors) {
      if (entry && typeof entry === 'object') {
        const msg = (entry as { message?: unknown }).message;
        if (typeof msg === 'string' && msg.length > 0) return msg;
      }
    }
  }
  for (const value of Object.values(obj)) {
    const found = extractDiscordMessage(value);
    if (found !== undefined) return found;
  }
  return undefined;
}

function extractGenericDetail(detail: string): string {
  // detail looks like: "Discord error 0: {"message":"Invalid Form Body",...}"
  const jsonStart = detail.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const body = JSON.parse(detail.slice(jsonStart)) as Record<string, unknown>;
      const inner = extractDiscordMessage(body.errors);
      if (inner !== undefined) return inner;
      const topMessage = (body as { message?: unknown }).message;
      if (typeof topMessage === 'string' && topMessage.length > 0) return topMessage;
    } catch {
      /* fall through */
    }
  }
  return detail.split('\n').find((l) => l.trim()) ?? detail;
}

function getOnboardingErrorMessage(syncError: string | null): string {
  if (!syncError) return '';
  try {
    const parsed = JSON.parse(syncError) as { code?: string; detail?: string };
    if (parsed.code === 'role_deleted') return tr('teamSettings_onboardingErrorRoleDeleted');
    if (parsed.code === 'channel_deleted') return tr('teamSettings_onboardingErrorChannelDeleted');
    if (parsed.code === 'community_not_enabled' || parsed.code === 'community_disabled')
      return tr('teamSettings_onboardingErrorCommunityDisabled');
    if (parsed.code === 'requirements_not_met')
      return tr('teamSettings_onboardingErrorRequirementsNotMet');
    if (parsed.code === 'default_channel_private')
      return tr('teamSettings_onboardingErrorDefaultChannelPrivate');
    if (parsed.code === 'too_many_prompts') return tr('teamSettings_onboardingErrorTooManyPrompts');
    return tr('teamSettings_onboardingErrorGeneric', {
      message: extractGenericDetail(parsed.detail ?? syncError),
    });
  } catch {
    return tr('teamSettings_onboardingErrorGeneric', { message: extractGenericDetail(syncError) });
  }
}

function OnboardingCard({
  teamInfo,
  discordChannels,
  filteredDiscordRoles,
  isCommunityEnabled,
  onboardingRulesChannel,
  setOnboardingRulesChannel,
  onboardingRole,
  setOnboardingRole,
  onboardingLocale,
  setOnboardingLocale,
  hasOnboardingChanges,
  savingOnboarding,
  retryingOnboarding,
  handleSaveOnboarding,
  handleRetryOnboarding,
  formatRelative,
}: OnboardingCardProps) {
  const router = useRouter();
  const syncStatus = teamInfo.onboardingSyncStatus;
  const syncedAt = teamInfo.onboardingSyncedAt;
  const syncError = Option.getOrNull(teamInfo.onboardingSyncError);

  // Auto-poll the loader while the sync is in flight so the badge updates without a manual refresh.
  React.useEffect(() => {
    if (syncStatus !== 'pending' && syncStatus !== 'syncing') return;
    const interval = setInterval(() => {
      router.invalidate();
    }, 3000);
    return () => clearInterval(interval);
  }, [syncStatus, router]);

  const statusBadge = (() => {
    if (syncStatus === 'done') {
      const relTime = Option.isSome(syncedAt)
        ? formatRelative(new Date(Number(DateTime.toEpochMillis(syncedAt.value))))
        : '';
      return (
        <Badge variant='success'>
          {tr('teamSettings_onboardingStatusSynced')}
          {relTime ? ` ${relTime}` : ''}
        </Badge>
      );
    }
    if (syncStatus === 'failed') {
      return <Badge variant='destructive'>{tr('teamSettings_onboardingStatusFailed')}</Badge>;
    }
    return <Badge variant='secondary'>{tr('teamSettings_onboardingStatusPending')}</Badge>;
  })();

  const errorMessage = syncStatus === 'failed' ? getOnboardingErrorMessage(syncError) : '';

  const textChannelOptions = [
    { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
    ...discordChannels
      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
  ];

  const roleOptions = [
    { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
    ...filteredDiscordRoles.map((role) => ({
      value: role.id,
      label: `@${role.name}`,
    })),
  ];

  return (
    <Card>
      <CardHeader>
        <div className='flex items-center gap-2'>
          <ShieldCheck className='size-4 text-muted-foreground' />
          <CardTitle className='text-base'>
            <h3 className='m-0 text-inherit font-inherit'>{tr('teamSettings_onboardingTitle')}</h3>
          </CardTitle>
        </div>
        <CardDescription>{tr('teamSettings_onboardingDescription')}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          {/* Community warning — outside fieldset */}
          {!isCommunityEnabled && (
            <Alert variant='warning'>
              <AlertTriangle className='size-4' />
              <AlertDescription>
                {tr('teamSettings_onboardingCommunityWarning', {
                  learnHow: '',
                })}{' '}
                <a
                  href='https://support.discord.com/hc/en-us/articles/360047132851'
                  target='_blank'
                  rel='noopener noreferrer'
                  className='underline font-medium'
                >
                  Learn how
                </a>
              </AlertDescription>
            </Alert>
          )}

          {/* Status section — outside fieldset */}
          <output aria-live='polite' aria-atomic='true' className='flex flex-col gap-2'>
            <div className='flex items-center gap-3'>
              {statusBadge}
              {syncStatus === 'failed' && (
                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleRetryOnboarding}
                  disabled={retryingOnboarding}
                  aria-describedby={errorMessage ? 'onboarding-error-message' : undefined}
                >
                  {tr('teamSettings_onboardingRetry')}
                </Button>
              )}
            </div>
            {syncStatus === 'failed' && errorMessage && (
              <div>
                <p id='onboarding-error-message' className='text-sm text-destructive'>
                  {errorMessage}
                </p>
                {syncError && (
                  <details className='mt-1'>
                    <summary className='text-xs text-muted-foreground cursor-pointer'>
                      Details
                    </summary>
                    <pre className='text-xs text-muted-foreground mt-1 whitespace-pre-wrap break-words'>
                      {syncError}
                    </pre>
                  </details>
                )}
              </div>
            )}
          </output>

          {/* Form fields — inside fieldset */}
          <fieldset
            disabled={!isCommunityEnabled}
            className={!isCommunityEnabled ? 'opacity-60' : ''}
          >
            <div className='flex flex-col gap-5'>
              <div>
                <label
                  htmlFor='onboarding-rules-channel'
                  className='text-sm font-medium mb-1 block'
                >
                  {tr('teamSettings_onboardingRulesChannel')}
                </label>
                <p
                  id='onboarding-rules-channel-help'
                  className='text-xs text-muted-foreground mb-2'
                >
                  {tr('teamSettings_onboardingRulesChannelHelp')}
                </p>
                <SearchableSelect
                  id='onboarding-rules-channel'
                  value={onboardingRulesChannel}
                  onValueChange={setOnboardingRulesChannel}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={textChannelOptions}
                  aria-describedby='onboarding-rules-channel-help'
                />
              </div>

              <div>
                <label htmlFor='onboarding-role' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_onboardingRulesRole')}
                </label>
                <p id='onboarding-role-help' className='text-xs text-muted-foreground mb-2'>
                  {tr('teamSettings_onboardingRulesRoleHelp')}
                </p>
                <SearchableSelect
                  id='onboarding-role'
                  value={onboardingRole}
                  onValueChange={setOnboardingRole}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={roleOptions}
                  aria-describedby='onboarding-role-help'
                />
              </div>

              <div>
                <fieldset>
                  <legend className='sr-only'>{tr('teamSettings_onboardingLocale')}</legend>
                  <p className='text-sm font-medium mb-1'>{tr('teamSettings_onboardingLocale')}</p>
                  <ToggleGroup
                    type='single'
                    value={onboardingLocale}
                    onValueChange={(val) => {
                      if (val) setOnboardingLocale(val);
                    }}
                    variant='outline'
                  >
                    <ToggleGroupItem value='en' aria-label={tr('teamSettings_onboardingLocaleEn')}>
                      {tr('teamSettings_onboardingLocaleEn')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value='cs' aria-label={tr('teamSettings_onboardingLocaleCs')}>
                      {tr('teamSettings_onboardingLocaleCs')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </fieldset>
              </div>

              <div className='flex items-center gap-3'>
                <Button
                  onClick={handleSaveOnboarding}
                  disabled={savingOnboarding || !hasOnboardingChanges || !isCommunityEnabled}
                >
                  {savingOnboarding ? tr('profile_saving') : tr('profile_saveChanges')}
                </Button>
                {hasOnboardingChanges && (
                  <p className='text-sm text-muted-foreground'>
                    {tr('teamSettings_unsavedChanges')}
                  </p>
                )}
              </div>
            </div>
          </fieldset>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// EmailForwardingCard
// ---------------------------------------------------------------------------

interface EmailForwardingCardProps {
  teamId: string;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  initialConfig: EmailForwardingApi.EmailForwardingConfigView | null;
}

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function EmailForwardingCard({ teamId, discordChannels, initialConfig }: EmailForwardingCardProps) {
  const run = useRun();
  const router = useRouter();
  const serverUrl = useServerUrl();

  const [config, setConfig] = React.useState<EmailForwardingApi.EmailForwardingConfigView | null>(
    initialConfig,
  );
  // The inbound token is only revealed after regeneration
  const [lastToken, setLastToken] = React.useState<string | null>(null);

  // Form state — initialise from loader data
  const [enabled, setEnabled] = React.useState(initialConfig?.enabled ?? false);
  const [coachChannelId, setCoachChannelId] = React.useState(
    initialConfig?.coachChannelId || NONE_VALUE,
  );
  const [targetChannelId, setTargetChannelId] = React.useState(
    initialConfig?.targetChannelId || NONE_VALUE,
  );
  const [monitoredAddresses, setMonitoredAddresses] = React.useState<string[]>(
    initialConfig ? [...initialConfig.monitoredAddresses] : [],
  );
  const [newSender, setNewSender] = React.useState('');
  const [newSenderError, setNewSenderError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [showRegenerateConfirm, setShowRegenerateConfirm] = React.useState(false);
  const [copiedAddress, setCopiedAddress] = React.useState(false);

  const initialEnabled = config?.enabled ?? false;
  const initialCoach = config?.coachChannelId || NONE_VALUE;
  const initialTarget = config?.targetChannelId || NONE_VALUE;
  const initialAddresses = React.useMemo(() => [...(config?.monitoredAddresses ?? [])], [config]);

  const hasChanges =
    enabled !== initialEnabled ||
    coachChannelId !== initialCoach ||
    targetChannelId !== initialTarget ||
    JSON.stringify(monitoredAddresses) !== JSON.stringify(initialAddresses);

  const hasInvalidSender = newSender.trim().length > 0 && !EMAIL_REGEX.test(newSender.trim());

  // Build the inbound webhook URL — only available after regeneration (token is secret)
  const inboundUrl = React.useMemo(() => {
    if (!lastToken) return null;
    const base = serverUrl.replace(/\/$/, '');
    return `${base}/email/inbound/${lastToken}`;
  }, [lastToken, serverUrl]);

  const handleAddSender = () => {
    const trimmed = newSender.trim();
    if (!trimmed) return;
    if (!EMAIL_REGEX.test(trimmed)) {
      setNewSenderError(tr('team_email_forwarding_allowed_senders_invalid'));
      return;
    }
    if (monitoredAddresses.includes(trimmed)) {
      setNewSenderError(tr('team_email_forwarding_allowed_senders_duplicate'));
      return;
    }
    setMonitoredAddresses((prev) => [...prev, trimmed]);
    setNewSender('');
    setNewSenderError(null);
  };

  const handleRemoveSender = (addr: string) => {
    setMonitoredAddresses((prev) => prev.filter((a) => a !== addr));
  };

  const handleCopyAddress = async () => {
    if (!inboundUrl) return;
    await navigator.clipboard.writeText(inboundUrl);
    setCopiedAddress(true);
    setTimeout(() => setCopiedAddress(false), 2000);
  };

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.upsertEmailForwardingConfig({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
          payload: {
            enabled,
            coach_channel_id:
              coachChannelId !== NONE_VALUE
                ? Discord.Snowflake.makeUnsafe(coachChannelId)
                : Discord.Snowflake.makeUnsafe(''),
            target_channel_id:
              targetChannelId !== NONE_VALUE
                ? Discord.Snowflake.makeUnsafe(targetChannelId)
                : Discord.Snowflake.makeUnsafe(''),
            monitored_addresses: monitoredAddresses,
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('team_email_forwarding_save_error'))),
      run({ success: tr('team_email_forwarding_save_success') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      const cfg = result.value;
      setConfig(cfg);
      setEnabled(cfg.enabled);
      setCoachChannelId(cfg.coachChannelId || NONE_VALUE);
      setTargetChannelId(cfg.targetChannelId || NONE_VALUE);
      setMonitoredAddresses([...cfg.monitoredAddresses]);
      router.invalidate();
    }
  }, [teamId, enabled, coachChannelId, targetChannelId, monitoredAddresses, run, router]);

  const handleRegenerate = React.useCallback(async () => {
    setRegenerating(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.emailForwarding.regenerateEmailForwardingToken({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('team_email_forwarding_save_error'))),
      run({}),
    );
    setRegenerating(false);
    setShowRegenerateConfirm(false);
    if (Option.isSome(result)) {
      setLastToken(result.value.inbound_token);
      router.invalidate();
    }
  }, [teamId, run, router]);

  const textChannelOptions = React.useMemo(
    () => [
      { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
      ...discordChannels
        .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
        .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
    ],
    [discordChannels],
  );

  const showChannelsWarning =
    enabled && (coachChannelId === NONE_VALUE || targetChannelId === NONE_VALUE);

  return (
    <>
      <Card>
        <CardHeader>
          <div className='flex items-center gap-2'>
            <Mail className='size-4 text-muted-foreground' />
            <CardTitle className='text-base'>{tr('team_email_forwarding_title')}</CardTitle>
          </div>
          <CardDescription>{tr('team_email_forwarding_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-5'>
            {/* Enable switch */}
            <div className='flex items-start justify-between gap-4'>
              <div>
                <label htmlFor='email-forwarding-enabled' className='text-sm font-medium block'>
                  {tr('team_email_forwarding_enabled_label')}
                </label>
                <p className='text-xs text-muted-foreground mt-1'>
                  {tr('team_email_forwarding_enabled_help')}
                </p>
              </div>
              <Switch
                id='email-forwarding-enabled'
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            <Separator />

            {/* Inbound address */}
            <div>
              <span className='text-sm font-medium mb-1 block'>
                {tr('team_email_forwarding_inbound_address_label')}
              </span>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('team_email_forwarding_inbound_address_help')}
              </p>
              <div className='flex gap-2 flex-wrap sm:flex-nowrap'>
                <Input
                  readOnly
                  value={inboundUrl ?? (config ? '(regenerate token to reveal URL)' : '—')}
                  className='font-mono text-xs'
                />
                <Button
                  variant='outline'
                  size='sm'
                  onClick={handleCopyAddress}
                  disabled={!inboundUrl}
                >
                  <Copy className='size-3 mr-1' />
                  {copiedAddress
                    ? tr('team_email_forwarding_copied')
                    : tr('team_email_forwarding_copy')}
                </Button>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setShowRegenerateConfirm(true)}
                  disabled={!config}
                >
                  {tr('team_email_forwarding_regenerate')}
                </Button>
              </div>
            </div>

            <Separator />

            {/* Channels warning */}
            {showChannelsWarning && (
              <Alert variant='warning'>
                <AlertTriangle className='size-4' />
                <AlertDescription>{tr('team_email_forwarding_channels_warning')}</AlertDescription>
              </Alert>
            )}

            {/* Fields disabled when not enabled */}
            <fieldset disabled={!enabled} className={!enabled ? 'opacity-60' : ''}>
              <div className='flex flex-col gap-5'>
                {/* Allowed senders */}
                <div>
                  <span className='text-sm font-medium mb-1 block'>
                    {tr('team_email_forwarding_allowed_senders_label')}
                  </span>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_allowed_senders_help')}
                  </p>
                  <div className='flex flex-col gap-2'>
                    {monitoredAddresses.map((addr) => (
                      <div key={addr} className='flex items-center gap-2'>
                        <Input readOnly value={addr} className='text-sm' />
                        <Button
                          variant='outline'
                          size='sm'
                          onClick={() => handleRemoveSender(addr)}
                          type='button'
                        >
                          {tr('team_email_forwarding_allowed_senders_remove')}
                        </Button>
                      </div>
                    ))}
                    <div className='flex items-start gap-2'>
                      <div className='flex-1'>
                        <Input
                          type='email'
                          placeholder='coach@example.com'
                          value={newSender}
                          onChange={(e) => {
                            setNewSender(e.target.value);
                            setNewSenderError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              handleAddSender();
                            }
                          }}
                          aria-invalid={newSenderError !== null}
                        />
                        {newSenderError && (
                          <p className='text-xs text-destructive mt-1'>{newSenderError}</p>
                        )}
                      </div>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={handleAddSender}
                        disabled={!newSender.trim() || hasInvalidSender}
                        type='button'
                      >
                        {tr('team_email_forwarding_allowed_senders_add')}
                      </Button>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Coach channel */}
                <div>
                  <label
                    htmlFor='email-forwarding-coach-channel'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('team_email_forwarding_coach_channel_label')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_coach_channel_help')}
                  </p>
                  <SearchableSelect
                    id='email-forwarding-coach-channel'
                    value={coachChannelId}
                    onValueChange={setCoachChannelId}
                    placeholder={tr('teamSettings_channelNone')}
                    pinnedValues={[NONE_VALUE]}
                    options={textChannelOptions}
                  />
                </div>

                {/* Target channel */}
                <div>
                  <label
                    htmlFor='email-forwarding-target-channel'
                    className='text-sm font-medium mb-1 block'
                  >
                    {tr('team_email_forwarding_target_channel_label')}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {tr('team_email_forwarding_target_channel_help')}
                  </p>
                  <SearchableSelect
                    id='email-forwarding-target-channel'
                    value={targetChannelId}
                    onValueChange={setTargetChannelId}
                    placeholder={tr('teamSettings_channelNone')}
                    pinnedValues={[NONE_VALUE]}
                    options={textChannelOptions}
                  />
                </div>
              </div>
            </fieldset>

            <div className='flex items-center gap-3'>
              <Button onClick={handleSave} disabled={saving || !hasChanges || hasInvalidSender}>
                {saving ? tr('profile_saving') : tr('profile_saveChanges')}
              </Button>
              {hasChanges && (
                <p className='text-sm text-muted-foreground'>{tr('teamSettings_unsavedChanges')}</p>
              )}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Regenerate token confirm dialog */}
      <AlertDialog open={showRegenerateConfirm} onOpenChange={setShowRegenerateConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {tr('team_email_forwarding_regenerate_confirm_title')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {tr('team_email_forwarding_regenerate_confirm_body')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>
              {tr('team_email_forwarding_regenerate_confirm_cancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleRegenerate} disabled={regenerating}>
              {tr('team_email_forwarding_regenerate_confirm_action')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
