import type { GroupApi } from '@sideline/domain';
import { ChannelSyncEvent } from '@sideline/domain';
import { Schema } from 'effect';
import { AlertTriangle, MessageSquare } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Alert, AlertDescription } from '~/components/ui/alert';
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
import { toGroupOptions } from '~/lib/group-options.js';
import { tr } from '~/lib/translations.js';
import type { SettingsFormValues } from './settingsForm';
import {
  categoryChannelOptions,
  DEFAULT_CHANNEL_FORMAT,
  DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  DEFAULT_ROLE_FORMAT,
  isFormatValid,
  NONE_VALUE,
  renderFormatPreview,
  textChannelOptions,
} from './shared';
import type { CardForm } from './useCardForm';

interface DiscordDefaultsCardProps {
  form: CardForm<SettingsFormValues>;
  discordChannels: ReadonlyArray<GroupApi.DiscordChannelInfo>;
  groups: ReadonlyArray<GroupApi.GroupInfo>;
}

const decodeCleanupMode = Schema.decodeUnknownSync(ChannelSyncEvent.ChannelCleanupMode);

export function DiscordDefaultsCard({
  form: { values, setField },
  discordChannels,
  groups,
}: DiscordDefaultsCardProps) {
  const noneLabel = tr('teamSettings_channelNone');
  const channelOptions = React.useMemo(
    () => textChannelOptions(discordChannels, noneLabel),
    [discordChannels, noneLabel],
  );
  const categoryOptions = React.useMemo(
    () => categoryChannelOptions(discordChannels, noneLabel),
    [discordChannels, noneLabel],
  );

  return (
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
                  {values.roleFormat !== DEFAULT_ROLE_FORMAT && (
                    <Button
                      variant='link'
                      size='sm'
                      className='h-auto p-0 text-xs'
                      onClick={() => setField('roleFormat', DEFAULT_ROLE_FORMAT)}
                    >
                      {tr('teamSettings_formatResetDefault')}
                    </Button>
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  {tr('teamSettings_roleFormatHelp', { emoji: '{emoji}', name: '{name}' })}
                </p>
                <Input
                  value={values.roleFormat}
                  onChange={(e) => setField('roleFormat', e.target.value)}
                />
                <div className='text-xs text-muted-foreground'>
                  <span>{tr('teamSettings_formatPreview')} </span>
                  <span className='font-mono'>{renderFormatPreview(values.roleFormat, false)}</span>
                </div>
                {!isFormatValid(values.roleFormat) && (
                  <p className='text-xs text-destructive'>
                    {tr('teamSettings_formatMustIncludeName', { name: '{name}' })}
                  </p>
                )}
              </div>
              {/* Channel format */}
              <div className='space-y-2'>
                <div className='flex items-center justify-between'>
                  <Label>{tr('teamSettings_channelFormat')}</Label>
                  {values.channelFormat !== DEFAULT_CHANNEL_FORMAT && (
                    <Button
                      variant='link'
                      size='sm'
                      className='h-auto p-0 text-xs'
                      onClick={() => setField('channelFormat', DEFAULT_CHANNEL_FORMAT)}
                    >
                      {tr('teamSettings_formatResetDefault')}
                    </Button>
                  )}
                </div>
                <p className='text-xs text-muted-foreground'>
                  {tr('teamSettings_channelFormatHelp', { emoji: '{emoji}', name: '{name}' })}
                </p>
                <Input
                  value={values.channelFormat}
                  onChange={(e) => setField('channelFormat', e.target.value)}
                />
                <div className='text-xs text-muted-foreground'>
                  <span>{tr('teamSettings_formatPreview')} </span>
                  <span className='font-mono'>
                    {renderFormatPreview(values.channelFormat, true)}
                  </span>
                </div>
                {!isFormatValid(values.channelFormat) && (
                  <p className='text-xs text-destructive'>
                    {tr('teamSettings_formatMustIncludeName', { name: '{name}' })}
                  </p>
                )}
              </div>
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
                checked={values.createDiscordChannelOnGroup}
                onCheckedChange={(v) => setField('createDiscordChannelOnGroup', v)}
              />
            </div>
            <div>
              <label htmlFor='cleanup-on-group-delete' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_channelCleanupOnGroupDelete')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('teamSettings_channelCleanupOnGroupDeleteHelp')}
              </p>
              <Select
                value={values.cleanupOnGroupDelete}
                onValueChange={(v) => setField('cleanupOnGroupDelete', decodeCleanupMode(v))}
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
            <h4 className='text-sm font-semibold'>{tr('teamSettings_rosterChannelSettings')}</h4>
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
                checked={values.createDiscordChannelOnRoster}
                onCheckedChange={(v) => setField('createDiscordChannelOnRoster', v)}
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
                value={values.cleanupOnRosterDeactivate}
                onValueChange={(v) => setField('cleanupOnRosterDeactivate', decodeCleanupMode(v))}
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
            <div>
              <label htmlFor='roster-category' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_rosterCategory')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('teamSettings_rosterCategoryHelp')}
              </p>
              <SearchableSelect
                id='roster-category'
                value={values.rosterCategory}
                onValueChange={(v) => setField('rosterCategory', v)}
                placeholder={noneLabel}
                pinnedValues={[NONE_VALUE]}
                options={categoryOptions}
              />
            </div>
          </div>

          {/* Archive category (shared, shown when either mode is archive) */}
          {(values.cleanupOnGroupDelete === 'archive' ||
            values.cleanupOnRosterDeactivate === 'archive') && (
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
                  value={values.archiveCategory}
                  onValueChange={(v) => setField('archiveCategory', v)}
                  placeholder={noneLabel}
                  pinnedValues={[NONE_VALUE]}
                  options={categoryOptions}
                />
              </div>
            </>
          )}

          <Separator />

          {/* Events channels sub-section */}
          <div className='flex flex-col gap-4'>
            <h4 className='text-sm font-semibold'>{tr('teamSettings_eventsChannelsTitle')}</h4>
            {values.personalEventsCategory === NONE_VALUE && (
              <Alert variant='default'>
                <AlertTriangle className='size-4' />
                <AlertDescription>{tr('teamSettings_eventsNoSurfaceWarning')}</AlertDescription>
              </Alert>
            )}
            <div>
              <label htmlFor='channel-late-rsvp' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_channelLateRsvp')}
              </label>
              <SearchableSelect
                id='channel-late-rsvp'
                value={values.channelLateRsvp}
                onValueChange={(v) => setField('channelLateRsvp', v)}
                placeholder={noneLabel}
                pinnedValues={[NONE_VALUE]}
                options={channelOptions}
              />
            </div>
            <div>
              <label htmlFor='personal-events-category' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_personalEventsCategory')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('teamSettings_personalEventsCategoryHelp')}
              </p>
              <SearchableSelect
                id='personal-events-category'
                value={values.personalEventsCategory}
                onValueChange={(v) => setField('personalEventsCategory', v)}
                placeholder={noneLabel}
                pinnedValues={[NONE_VALUE]}
                options={categoryOptions}
              />
            </div>
            <div>
              <label htmlFor='personal-events-group' className='text-sm font-medium mb-1 block'>
                {tr('teamSettings_personalEventsGroup')}
              </label>
              <p className='text-xs text-muted-foreground mb-2'>
                {tr('teamSettings_personalEventsGroupHelp')}
              </p>
              <SearchableSelect
                id='personal-events-group'
                value={values.personalEventsGroupId}
                onValueChange={(v) => setField('personalEventsGroupId', v)}
                placeholder={noneLabel}
                pinnedValues={[NONE_VALUE]}
                options={[{ value: NONE_VALUE, label: noneLabel }, ...toGroupOptions(groups)]}
              />
            </div>
            <div className='space-y-2'>
              <div className='flex items-center justify-between'>
                <Label>{tr('teamSettings_personalEventsChannelFormat')}</Label>
                {values.personalEventsChannelFormat !== DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT && (
                  <Button
                    variant='link'
                    size='sm'
                    className='h-auto p-0 text-xs'
                    onClick={() =>
                      setField(
                        'personalEventsChannelFormat',
                        DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
                      )
                    }
                  >
                    {tr('teamSettings_formatResetDefault')}
                  </Button>
                )}
              </div>
              <p className='text-xs text-muted-foreground'>
                {tr('teamSettings_personalEventsChannelFormatHelp', {
                  name: '{name}',
                  discord_id: '{discord_id}',
                })}
              </p>
              <Input
                value={values.personalEventsChannelFormat}
                onChange={(e) => setField('personalEventsChannelFormat', e.target.value)}
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
