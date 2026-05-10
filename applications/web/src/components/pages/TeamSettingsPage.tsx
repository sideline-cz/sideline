import type { GroupApi, TeamApi, TeamSettingsApi } from '@sideline/domain';
import { ChannelSyncEvent, Discord } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { applyTemplate, sanitizeRendered } from '@sideline/template-renderer';
import { Link, useRouter } from '@tanstack/react-router';
import { DateTime, Effect, Option, Schema } from 'effect';
import { AlertTriangle, MessageSquare, Settings, ShieldCheck, Users } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Alert, AlertDescription } from '~/components/ui/alert';
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

interface TeamSettingsPageProps {
  teamId: string;
  settings: TeamSettingsApi.TeamSettingsInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  discordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  teamInfo: TeamApi.TeamInfo;
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
  const [rsvpReminderDaysBefore, setRsvpReminderDaysBefore] = React.useState(
    String(settings.rsvpReminderDaysBefore),
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
    rsvpReminderDaysBefore !== String(settings.rsvpReminderDaysBefore) ||
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
            welcomeMessageTemplate: Option.none(),
            rulesChannelId: Option.none(),
            onboardingRulesRoleId: Option.none(),
            onboardingLocale: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(m.teamSettings_profileSaveFailed())),
      run({ success: m.teamSettings_profileSaved() }),
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
    if (!isFormatValid(roleFormat) || !isFormatValid(channelFormat)) return;
    setSavingSettings(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.teamSettings.updateTeamSettings({
          params: { teamId: settings.teamId },
          payload: {
            eventHorizonDays: Option.some(parsed),
            minPlayersThreshold: Option.some(parsedThreshold),
            rsvpReminderDaysBefore: Option.some(parsedReminderDaysBefore),
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
      Effect.mapError(() => ClientError.make(m.teamSettings_saveFailed())),
      run({ success: m.teamSettings_saved() }),
    );
    setSavingSettings(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    settings.teamId,
    horizonDays,
    minPlayersThreshold,
    rsvpReminderDaysBefore,
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
            welcomeMessageTemplate: Option.some(
              welcomeTemplate.trim() ? Option.some(welcomeTemplate.trim()) : Option.none(),
            ),
            rulesChannelId: Option.none(),
            onboardingRulesRoleId: Option.none(),
            onboardingLocale: Option.none(),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(m.teamSettings_welcomeSaveFailed())),
      run({ success: m.teamSettings_welcomeSaved() }),
    );
    setSavingWelcome(false);
    if (Option.isSome(result)) {
      router.invalidate();
    }
  }, [
    teamInfo.teamId,
    welcomeChannel,
    systemLogChannel,
    welcomeTemplate,
    channelToOption,
    run,
    router,
  ]);

  const handleSaveOnboarding = React.useCallback(async () => {
    setSavingOnboarding(true);
    toast(m.teamSettings_onboardingSavedSyncing(), { duration: 3000 });
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
            welcomeMessageTemplate: Option.none(),
            rulesChannelId: Option.some(channelToOption(onboardingRulesChannel)),
            onboardingRulesRoleId: Option.some(channelToOption(onboardingRole)),
            onboardingLocale: Option.some(onboardingLocale),
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(m.teamSettings_welcomeSaveFailed())),
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
      Effect.mapError(() => ClientError.make(m.teamSettings_welcomeSaveFailed())),
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
      label: m.teamSettings_channelTraining(),
    },
    {
      key: 'match',
      value: channelMatch,
      setter: setChannelMatch,
      label: m.teamSettings_channelMatch(),
    },
    {
      key: 'tournament',
      value: channelTournament,
      setter: setChannelTournament,
      label: m.teamSettings_channelTournament(),
    },
    {
      key: 'meeting',
      value: channelMeeting,
      setter: setChannelMeeting,
      label: m.teamSettings_channelMeeting(),
    },
    {
      key: 'social',
      value: channelSocial,
      setter: setChannelSocial,
      label: m.teamSettings_channelSocial(),
    },
    {
      key: 'other',
      value: channelOther,
      setter: setChannelOther,
      label: m.teamSettings_channelOther(),
    },
    {
      key: 'lateRsvp',
      value: channelLateRsvp,
      setter: setChannelLateRsvp,
      label: m.teamSettings_channelLateRsvp(),
    },
  ] as const;

  return (
    <div>
      <header className='mb-6'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {m.team_backToTeams()}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{m.team_settings()}</h1>
      </header>

      <div className='flex flex-col gap-6 max-w-2xl'>
        {/* Team Profile */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <Users className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{m.teamSettings_teamProfile()}</CardTitle>
            </div>
            <CardDescription>{m.teamSettings_teamProfileDescription()}</CardDescription>
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
                  {m.teamSettings_teamName()}
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
                  {m.teamSettings_description()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_descriptionHelp()}
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
                  {m.teamSettings_sport()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>{m.teamSettings_sportHelp()}</p>
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
                  {m.teamSettings_logoUrl()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>{m.teamSettings_logoUrlHelp()}</p>
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
                  {savingProfile ? m.profile_saving() : m.profile_saveChanges()}
                </Button>
                {hasProfileChanges && (
                  <p className='text-sm text-muted-foreground'>{m.teamSettings_unsavedChanges()}</p>
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
              <CardTitle className='text-base'>{m.teamSettings_generalTitle()}</CardTitle>
            </div>
            <CardDescription>{m.teamSettings_generalDescription()}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='horizon-days' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_horizonDays()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_horizonDaysHelp()}
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
                  {m.teamSettings_minPlayersThreshold()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_minPlayersThresholdHelp()}
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
            <CardTitle className='text-base'>{m.teamSettings_remindersChannel()}</CardTitle>
            <CardDescription>{m.teamSettings_rsvpReminderHelp()}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='reminders-channel' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_remindersChannel()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_remindersChannelHelp()}
                </p>
                <SearchableSelect
                  id='reminders-channel'
                  value={remindersChannelId}
                  onValueChange={setRemindersChannelId}
                  placeholder={m.teamSettings_channelNone()}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: m.teamSettings_channelNone() },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <Separator />
              <div>
                <label
                  htmlFor='rsvp-reminder-days-before'
                  className='text-sm font-medium mb-1 block'
                >
                  {m.teamSettings_rsvpReminderDaysBefore()}
                </label>
                <Input
                  id='rsvp-reminder-days-before'
                  type='number'
                  min={0}
                  max={14}
                  value={rsvpReminderDaysBefore}
                  onChange={(e) => setRsvpReminderDaysBefore(e.target.value)}
                  className='max-w-32'
                />
              </div>
              <div>
                <label htmlFor='rsvp-reminder-time' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_rsvpReminderTime()}
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
                  {m.teamSettings_timezone()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_timezoneHelp()}
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

        {/* Discord Channel Defaults */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <MessageSquare className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{m.teamSettings_discordChannels()}</CardTitle>
            </div>
            <CardDescription>{m.teamSettings_discordChannelsHelp()}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-6'>
              {/* Naming formats */}
              <div className='space-y-4'>
                <h4 className='font-medium'>{m.teamSettings_namingFormats()}</h4>
                <div className='grid gap-4'>
                  {/* Role format */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label>{m.teamSettings_roleFormat()}</Label>
                      {roleFormat !== DEFAULT_ROLE_FORMAT && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto p-0 text-xs'
                          onClick={() => setRoleFormat(DEFAULT_ROLE_FORMAT)}
                        >
                          {m.teamSettings_formatResetDefault()}
                        </Button>
                      )}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {m.teamSettings_roleFormatHelp({ emoji: '{emoji}', name: '{name}' })}
                    </p>
                    <Input value={roleFormat} onChange={(e) => setRoleFormat(e.target.value)} />
                    <div className='text-xs text-muted-foreground'>
                      <span>{m.teamSettings_formatPreview()} </span>
                      <span className='font-mono'>{renderFormatPreview(roleFormat, false)}</span>
                    </div>
                    {!isFormatValid(roleFormat) && (
                      <p className='text-xs text-destructive'>
                        {m.teamSettings_formatMustIncludeName({ name: '{name}' })}
                      </p>
                    )}
                  </div>
                  {/* Channel format */}
                  <div className='space-y-2'>
                    <div className='flex items-center justify-between'>
                      <Label>{m.teamSettings_channelFormat()}</Label>
                      {channelFormat !== DEFAULT_CHANNEL_FORMAT && (
                        <Button
                          variant='link'
                          size='sm'
                          className='h-auto p-0 text-xs'
                          onClick={() => setChannelFormat(DEFAULT_CHANNEL_FORMAT)}
                        >
                          {m.teamSettings_formatResetDefault()}
                        </Button>
                      )}
                    </div>
                    <p className='text-xs text-muted-foreground'>
                      {m.teamSettings_channelFormatHelp({ emoji: '{emoji}', name: '{name}' })}
                    </p>
                    <Input
                      value={channelFormat}
                      onChange={(e) => setChannelFormat(e.target.value)}
                    />
                    <div className='text-xs text-muted-foreground'>
                      <span>{m.teamSettings_formatPreview()} </span>
                      <span className='font-mono'>{renderFormatPreview(channelFormat, true)}</span>
                    </div>
                    {!isFormatValid(channelFormat) && (
                      <p className='text-xs text-destructive'>
                        {m.teamSettings_formatMustIncludeName({ name: '{name}' })}
                      </p>
                    )}
                  </div>
                </div>
              </div>
              <Separator />

              {/* Event notification channels */}
              <div>
                <h4 className='text-sm font-semibold mb-3'>
                  {m.teamSettings_discordEventChannels()}
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
                        placeholder={m.teamSettings_channelNone()}
                        pinnedValues={[NONE_VALUE]}
                        options={[
                          { value: NONE_VALUE, label: m.teamSettings_channelNone() },
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
                <h4 className='text-sm font-semibold'>{m.teamSettings_groupChannelSettings()}</h4>
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <label htmlFor='create-discord-channel' className='text-sm font-medium block'>
                      {m.teamSettings_createDiscordChannelOnGroup()}
                    </label>
                    <p className='text-xs text-muted-foreground mt-1'>
                      {m.teamSettings_createDiscordChannelOnGroupHelp()}
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
                    {m.teamSettings_channelCleanupOnGroupDelete()}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {m.teamSettings_channelCleanupOnGroupDeleteHelp()}
                  </p>
                  <Select
                    value={cleanupOnGroupDelete}
                    onValueChange={(v) => setCleanupOnGroupDelete(decodeCleanupMode(v))}
                  >
                    <SelectTrigger id='cleanup-on-group-delete'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='nothing'>{m.teamSettings_cleanupNothing()}</SelectItem>
                      <SelectItem value='delete'>{m.teamSettings_cleanupDelete()}</SelectItem>
                      <SelectItem value='archive'>{m.teamSettings_cleanupArchive()}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <Separator />

              {/* Roster channels sub-section */}
              <div className='flex flex-col gap-4'>
                <h4 className='text-sm font-semibold'>{m.teamSettings_rosterChannelSettings()}</h4>
                <div className='flex items-start justify-between gap-4'>
                  <div>
                    <label
                      htmlFor='create-discord-channel-roster'
                      className='text-sm font-medium block'
                    >
                      {m.teamSettings_createDiscordChannelOnRoster()}
                    </label>
                    <p className='text-xs text-muted-foreground mt-1'>
                      {m.teamSettings_createDiscordChannelOnRosterHelp()}
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
                    {m.teamSettings_channelCleanupOnRosterDeactivate()}
                  </label>
                  <p className='text-xs text-muted-foreground mb-2'>
                    {m.teamSettings_channelCleanupOnRosterDeactivateHelp()}
                  </p>
                  <Select
                    value={cleanupOnRosterDeactivate}
                    onValueChange={(v) => setCleanupOnRosterDeactivate(decodeCleanupMode(v))}
                  >
                    <SelectTrigger id='cleanup-on-roster-deactivate'>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value='nothing'>{m.teamSettings_cleanupNothing()}</SelectItem>
                      <SelectItem value='delete'>{m.teamSettings_cleanupDelete()}</SelectItem>
                      <SelectItem value='archive'>{m.teamSettings_cleanupArchive()}</SelectItem>
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
                      {m.teamSettings_archiveCategory()}
                    </label>
                    <p className='text-xs text-muted-foreground mb-2'>
                      {m.teamSettings_archiveCategoryHelp()}
                    </p>
                    <SearchableSelect
                      id='archive-category'
                      value={archiveCategory}
                      onValueChange={setArchiveCategory}
                      placeholder={m.teamSettings_channelNone()}
                      pinnedValues={[NONE_VALUE]}
                      options={[
                        { value: NONE_VALUE, label: m.teamSettings_channelNone() },
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
            {savingSettings ? m.profile_saving() : m.profile_saveChanges()}
          </Button>
          {hasSettingsChanges && (
            <p className='text-sm text-muted-foreground'>{m.teamSettings_unsavedChanges()}</p>
          )}
        </div>

        {/* Welcome Message */}
        <Card>
          <CardHeader>
            <div className='flex items-center gap-2'>
              <MessageSquare className='size-4 text-muted-foreground' />
              <CardTitle className='text-base'>{m.teamSettings_welcomeTitle()}</CardTitle>
            </div>
            <CardDescription>{m.teamSettings_welcomeDescription()}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className='flex flex-col gap-5'>
              <div>
                <label htmlFor='welcome-channel' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_welcomeChannel()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_welcomeChannelHelp()}
                </p>
                <SearchableSelect
                  id='welcome-channel'
                  value={welcomeChannel}
                  onValueChange={setWelcomeChannel}
                  placeholder={m.teamSettings_channelNone()}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: m.teamSettings_channelNone() },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <div>
                <label htmlFor='system-log-channel' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_systemLogChannel()}
                </label>
                <p className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_systemLogChannelHelp()}
                </p>
                <SearchableSelect
                  id='system-log-channel'
                  value={systemLogChannel}
                  onValueChange={setSystemLogChannel}
                  placeholder={m.teamSettings_channelNone()}
                  pinnedValues={[NONE_VALUE]}
                  options={[
                    { value: NONE_VALUE, label: m.teamSettings_channelNone() },
                    ...discordChannels
                      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
                      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
                  ]}
                />
              </div>
              <div>
                <Label htmlFor='welcome-template'>{m.teamSettings_welcomeTemplate()}</Label>
                <p className='text-xs text-muted-foreground mt-1 mb-2'>
                  {m.teamSettings_welcomeTemplateHelp()}
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
                    {m.teamSettings_welcomePreview()}
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
                  {savingWelcome ? m.profile_saving() : m.profile_saveChanges()}
                </Button>
                {hasWelcomeChanges && (
                  <p className='text-sm text-muted-foreground'>{m.teamSettings_unsavedChanges()}</p>
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

function getOnboardingErrorMessage(syncError: string | null): string {
  if (!syncError) return '';
  try {
    const parsed = JSON.parse(syncError) as { code?: string; detail?: string };
    if (parsed.code === 'role_deleted') return m.teamSettings_onboardingErrorRoleDeleted();
    if (parsed.code === 'channel_deleted') return m.teamSettings_onboardingErrorChannelDeleted();
    if (parsed.code === 'community_not_enabled' || parsed.code === 'community_disabled')
      return m.teamSettings_onboardingErrorCommunityDisabled();
    const detail = parsed.detail ?? syncError;
    const firstLine = detail.split('\n').find((l: string) => l.trim()) ?? detail;
    return m.teamSettings_onboardingErrorGeneric({ message: firstLine });
  } catch {
    const firstLine = syncError.split('\n').find((l) => l.trim()) ?? syncError;
    return m.teamSettings_onboardingErrorGeneric({ message: firstLine });
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
  const syncStatus = teamInfo.onboardingSyncStatus;
  const syncedAt = teamInfo.onboardingSyncedAt;
  const syncError = Option.getOrNull(teamInfo.onboardingSyncError);

  const statusBadge = (() => {
    if (syncStatus === 'done') {
      const relTime = Option.isSome(syncedAt)
        ? formatRelative(new Date(Number(DateTime.toEpochMillis(syncedAt.value))))
        : '';
      return (
        <Badge variant='success'>
          {m.teamSettings_onboardingStatusSynced()}
          {relTime ? ` ${relTime}` : ''}
        </Badge>
      );
    }
    if (syncStatus === 'failed') {
      return <Badge variant='destructive'>{m.teamSettings_onboardingStatusFailed()}</Badge>;
    }
    return <Badge variant='secondary'>{m.teamSettings_onboardingStatusPending()}</Badge>;
  })();

  const errorMessage = syncStatus === 'failed' ? getOnboardingErrorMessage(syncError) : '';

  const textChannelOptions = [
    { value: NONE_VALUE, label: m.teamSettings_channelNone() },
    ...discordChannels
      .filter((ch) => ch.type === DISCORD_CHANNEL_TYPE_TEXT)
      .map((ch) => ({ value: ch.id, label: `# ${ch.name}` })),
  ];

  const roleOptions = [
    { value: NONE_VALUE, label: m.teamSettings_channelNone() },
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
          <CardTitle className='text-base'>{m.teamSettings_onboardingTitle()}</CardTitle>
        </div>
        <CardDescription>{m.teamSettings_onboardingDescription()}</CardDescription>
      </CardHeader>
      <CardContent>
        <div className='flex flex-col gap-5'>
          {/* Community warning — outside fieldset */}
          {!isCommunityEnabled && (
            <Alert variant='warning'>
              <AlertTriangle className='size-4' />
              <AlertDescription>
                {m.teamSettings_onboardingCommunityWarning({
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
                  {m.teamSettings_onboardingRetry()}
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
                  {m.teamSettings_onboardingRulesChannel()}
                </label>
                <p
                  id='onboarding-rules-channel-help'
                  className='text-xs text-muted-foreground mb-2'
                >
                  {m.teamSettings_onboardingRulesChannelHelp()}
                </p>
                <SearchableSelect
                  id='onboarding-rules-channel'
                  value={onboardingRulesChannel}
                  onValueChange={setOnboardingRulesChannel}
                  placeholder={m.teamSettings_channelNone()}
                  pinnedValues={[NONE_VALUE]}
                  options={textChannelOptions}
                  aria-describedby='onboarding-rules-channel-help'
                />
              </div>

              <div>
                <label htmlFor='onboarding-role' className='text-sm font-medium mb-1 block'>
                  {m.teamSettings_onboardingRulesRole()}
                </label>
                <p id='onboarding-role-help' className='text-xs text-muted-foreground mb-2'>
                  {m.teamSettings_onboardingRulesRoleHelp()}
                </p>
                <SearchableSelect
                  id='onboarding-role'
                  value={onboardingRole}
                  onValueChange={setOnboardingRole}
                  placeholder={m.teamSettings_channelNone()}
                  pinnedValues={[NONE_VALUE]}
                  options={roleOptions}
                  aria-describedby='onboarding-role-help'
                />
              </div>

              <div>
                <fieldset>
                  <legend className='sr-only'>{m.teamSettings_onboardingLocale()}</legend>
                  <p className='text-sm font-medium mb-1'>{m.teamSettings_onboardingLocale()}</p>
                  <ToggleGroup
                    type='single'
                    value={onboardingLocale}
                    onValueChange={(val) => {
                      if (val) setOnboardingLocale(val);
                    }}
                    variant='outline'
                  >
                    <ToggleGroupItem value='en' aria-label={m.teamSettings_onboardingLocaleEn()}>
                      {m.teamSettings_onboardingLocaleEn()}
                    </ToggleGroupItem>
                    <ToggleGroupItem value='cs' aria-label={m.teamSettings_onboardingLocaleCs()}>
                      {m.teamSettings_onboardingLocaleCs()}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </fieldset>
              </div>

              <div className='flex items-center gap-3'>
                <Button
                  onClick={handleSaveOnboarding}
                  disabled={savingOnboarding || !hasOnboardingChanges || !isCommunityEnabled}
                >
                  {savingOnboarding ? m.profile_saving() : m.profile_saveChanges()}
                </Button>
                {hasOnboardingChanges && (
                  <p className='text-sm text-muted-foreground'>{m.teamSettings_unsavedChanges()}</p>
                )}
              </div>
            </div>
          </fieldset>
        </div>
      </CardContent>
    </Card>
  );
}
