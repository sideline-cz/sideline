import type { GroupApi } from '@sideline/domain';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Input } from '~/components/ui/input';
import { Separator } from '~/components/ui/separator';
import { tr } from '~/lib/translations.js';
import type { SettingsFormValues } from './settingsForm';
import { NONE_VALUE, textChannelOptions } from './shared';
import type { CardForm } from './useCardForm';

interface RemindersCardProps {
  form: CardForm<SettingsFormValues>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
}

export function RemindersCard({ form: { values, setField }, discordChannels }: RemindersCardProps) {
  const channelOptions = React.useMemo(
    () => textChannelOptions(discordChannels, tr('teamSettings_channelNone')),
    [discordChannels],
  );

  return (
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
              value={values.remindersChannelId}
              onValueChange={(v) => setField('remindersChannelId', v)}
              placeholder={tr('teamSettings_channelNone')}
              pinnedValues={[NONE_VALUE]}
              options={channelOptions}
            />
          </div>
          <Separator />
          {/* Scheduled rules quiz. Off unless a channel is picked — the
              channel IS the opt-in, so there is no separate toggle to get
              out of sync with it. */}
          <div>
            <label htmlFor='rules-quiz-channel' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_rulesQuizChannel')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_rulesQuizChannelHelp')}
            </p>
            <SearchableSelect
              id='rules-quiz-channel'
              value={values.rulesQuizChannel}
              onValueChange={(v) => setField('rulesQuizChannel', v)}
              placeholder={tr('teamSettings_channelNone')}
              pinnedValues={[NONE_VALUE]}
              options={channelOptions}
            />
          </div>
          {values.rulesQuizChannel !== NONE_VALUE && (
            <div className='grid gap-4 sm:grid-cols-2'>
              <div>
                <label htmlFor='rules-quiz-interval' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_rulesQuizInterval')}
                </label>
                <Input
                  id='rules-quiz-interval'
                  type='number'
                  min={1}
                  max={90}
                  value={values.rulesQuizIntervalDays}
                  onChange={(e) => setField('rulesQuizIntervalDays', e.target.value)}
                />
              </div>
              <div>
                <label htmlFor='rules-quiz-time' className='text-sm font-medium mb-1 block'>
                  {tr('teamSettings_rulesQuizTime')}
                </label>
                <Input
                  id='rules-quiz-time'
                  type='time'
                  value={values.rulesQuizTime}
                  onChange={(e) => setField('rulesQuizTime', e.target.value)}
                />
                <p className='text-xs text-muted-foreground mt-1'>
                  {tr('teamSettings_rulesQuizTimeHelp')}
                </p>
              </div>
            </div>
          )}
          <Separator />
          <div className='flex items-center gap-2'>
            <input
              id='rsvp-reminders-enabled'
              type='checkbox'
              checked={values.rsvpRemindersEnabled}
              onChange={(e) => setField('rsvpRemindersEnabled', e.target.checked)}
              className='h-4 w-4'
            />
            <label htmlFor='rsvp-reminders-enabled' className='text-sm font-medium'>
              {tr('teamSettings_rsvpRemindersEnabled')}
            </label>
          </div>
          <div>
            <label htmlFor='rsvp-reminder-days-before' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_rsvpReminderDaysBefore')}
            </label>
            <Input
              id='rsvp-reminder-days-before'
              type='number'
              min={0}
              max={14}
              value={values.rsvpReminderDaysBefore}
              onChange={(e) => setField('rsvpReminderDaysBefore', e.target.value)}
              disabled={!values.rsvpRemindersEnabled}
              className='max-w-32'
            />
          </div>
          <div>
            <label htmlFor='max-missed-rsvps' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_maxMissedRsvps')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>
              {tr('teamSettings_maxMissedRsvps_help')}
            </p>
            <Input
              id='max-missed-rsvps'
              type='number'
              min={1}
              max={50}
              value={values.maxMissedRsvps}
              onChange={(e) => setField('maxMissedRsvps', e.target.value)}
              disabled={!values.rsvpRemindersEnabled}
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
              value={values.rsvpReminderTime}
              onChange={(e) => setField('rsvpReminderTime', e.target.value)}
              className='flex h-9 rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors max-w-32'
            />
          </div>
          <div>
            <label htmlFor='timezone' className='text-sm font-medium mb-1 block'>
              {tr('teamSettings_timezone')}
            </label>
            <p className='text-xs text-muted-foreground mb-2'>{tr('teamSettings_timezoneHelp')}</p>
            <select
              id='timezone'
              value={values.timezone}
              onChange={(e) => setField('timezone', e.target.value)}
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
  );
}
