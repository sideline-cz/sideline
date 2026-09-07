import type { GroupApi, TeamApi } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { AlertTriangle, ShieldCheck } from 'lucide-react';
import React from 'react';
import { toast } from 'sonner';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Badge } from '~/components/ui/badge';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { useFormatDate } from '~/hooks/useFormatDate';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { getOnboardingErrorMessage } from './onboardingError';
import { SaveRow } from './SaveRow';
import { NONE_VALUE, textChannelOptions } from './shared';
import { onboardingFormFrom, onboardingRequestFrom } from './teamInfoForm';
import { useCardForm } from './useCardForm';

interface OnboardingCardProps {
  teamInfo: TeamApi.TeamInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  discordRoles: ReadonlyArray<GroupApi.DiscordRoleInfo>;
  onRefresh: () => void;
}

export function OnboardingCard({
  teamInfo,
  discordChannels,
  discordRoles,
  onRefresh,
}: OnboardingCardProps) {
  const run = useRun();
  const { formatRelative } = useFormatDate();
  const form = useCardForm(onboardingFormFrom(teamInfo));
  const { values, setField } = form;
  const [saving, setSaving] = React.useState(false);
  const [retrying, setRetrying] = React.useState(false);

  const isCommunityEnabled = teamInfo.isCommunityEnabled;
  const syncStatus = teamInfo.onboardingSyncStatus;
  const syncedAt = teamInfo.onboardingSyncedAt;
  const syncError = Option.getOrNull(teamInfo.onboardingSyncError);

  // Poll the loader while the sync is in flight so the badge updates without a
  // manual refresh.
  React.useEffect(() => {
    if (syncStatus !== 'pending' && syncStatus !== 'syncing') return;
    const interval = setInterval(onRefresh, 3000);
    return () => clearInterval(interval);
  }, [syncStatus, onRefresh]);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    toast(tr('teamSettings_onboardingSavedSyncing'), { duration: 3000 });
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: onboardingRequestFrom(values),
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({}),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  }, [teamInfo.teamId, values, run, onRefresh]);

  const handleRetry = React.useCallback(async () => {
    setRetrying(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.retryOnboardingSync({ params: { teamId: teamInfo.teamId } }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({}),
    );
    setRetrying(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  }, [teamInfo.teamId, run, onRefresh]);

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

  const channelOptions = React.useMemo(
    () => textChannelOptions(discordChannels, tr('teamSettings_channelNone')),
    [discordChannels],
  );

  // The @everyone role (id === guildId) and bot-managed roles cannot be assigned.
  const roleOptions = React.useMemo(
    () => [
      { value: NONE_VALUE, label: tr('teamSettings_channelNone') },
      ...discordRoles
        .filter((role) => role.id !== teamInfo.guildId && !role.managed)
        .map((role) => ({ value: role.id, label: `@${role.name}` })),
    ],
    [discordRoles, teamInfo.guildId],
  );

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
                {tr('teamSettings_onboardingCommunityWarning', { learnHow: '' })}{' '}
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
                  onClick={handleRetry}
                  disabled={retrying}
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
                  value={values.rulesChannel}
                  onValueChange={(v) => setField('rulesChannel', v)}
                  placeholder={tr('teamSettings_channelNone')}
                  pinnedValues={[NONE_VALUE]}
                  options={channelOptions}
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
                  value={values.rulesRole}
                  onValueChange={(v) => setField('rulesRole', v)}
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
                    value={values.locale}
                    onValueChange={(val) => {
                      if (val === 'en' || val === 'cs') setField('locale', val);
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

              <SaveRow
                onSave={handleSave}
                saving={saving}
                dirty={form.isDirty}
                disabled={!isCommunityEnabled}
              />
            </div>
          </fieldset>
        </div>
      </CardContent>
    </Card>
  );
}
