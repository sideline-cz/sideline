import type { GroupApi, TeamApi } from '@sideline/domain';
import { applyTemplate, sanitizeRendered } from '@sideline/template-renderer';
import { Effect, Option } from 'effect';
import { MessageSquare } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import { Textarea } from '~/components/ui/textarea';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { SaveRow } from './SaveRow';
import { NONE_VALUE, textChannelOptions } from './shared';
import { welcomeFormFrom, welcomeRequestFrom } from './teamInfoForm';
import { useCardForm } from './useCardForm';

interface WelcomeMessageCardProps {
  teamInfo: TeamApi.TeamInfo;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  onRefresh: () => void;
}

export function WelcomeMessageCard({
  teamInfo,
  discordChannels,
  onRefresh,
}: WelcomeMessageCardProps) {
  const run = useRun();
  const form = useCardForm(welcomeFormFrom(teamInfo));
  const { values, setField } = form;
  const [saving, setSaving] = React.useState(false);

  const channelOptions = React.useMemo(
    () => textChannelOptions(discordChannels, tr('teamSettings_channelNone')),
    [discordChannels],
  );
  const achievementOptions = React.useMemo(
    () => textChannelOptions(discordChannels, tr('teamSettings_achievementChannelDisabled')),
    [discordChannels],
  );

  const welcomePreview = React.useMemo(() => {
    if (!values.welcomeTemplate.trim()) return '';
    return sanitizeRendered(
      applyTemplate(values.welcomeTemplate, {
        memberMention: '<@123456789>',
        memberName: 'Alex',
        inviterMention: '<@987654321>',
        inviterName: 'Captain',
        groupName: 'Goalkeepers',
        teamName: teamInfo.name,
      }),
    );
  }, [values.welcomeTemplate, teamInfo.name]);

  const handleSave = React.useCallback(async () => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateTeamInfo({
          params: { teamId: teamInfo.teamId },
          payload: welcomeRequestFrom(values),
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('teamSettings_welcomeSaveFailed'))),
      run({ success: tr('teamSettings_welcomeSaved') }),
    );
    setSaving(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  }, [teamInfo.teamId, values, run, onRefresh]);

  return (
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
              value={values.welcomeChannel}
              onValueChange={(v) => setField('welcomeChannel', v)}
              placeholder={tr('teamSettings_channelNone')}
              pinnedValues={[NONE_VALUE]}
              options={channelOptions}
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
              value={values.systemLogChannel}
              onValueChange={(v) => setField('systemLogChannel', v)}
              placeholder={tr('teamSettings_channelNone')}
              pinnedValues={[NONE_VALUE]}
              options={channelOptions}
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
              value={values.achievementChannel}
              onValueChange={(v) => setField('achievementChannel', v)}
              placeholder={tr('teamSettings_achievementChannelDisabled')}
              pinnedValues={[NONE_VALUE]}
              options={achievementOptions}
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
              value={values.welcomeTemplate}
              onChange={(e) => setField('welcomeTemplate', e.target.value)}
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
          <SaveRow onSave={handleSave} saving={saving} dirty={form.isDirty} />
        </div>
      </CardContent>
    </Card>
  );
}
