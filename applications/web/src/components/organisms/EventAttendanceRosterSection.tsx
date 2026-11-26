import type { EventRosterApi, Roster as RosterDomain } from '@sideline/domain';
import { Event, EventRosterModel, RosterModel, Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { Loader2 } from 'lucide-react';
import React from 'react';

import { ColorPicker } from '~/components/atoms/ColorPicker.js';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
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
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Checkbox } from '~/components/ui/checkbox';
import { Input } from '~/components/ui/input';
import { Label } from '~/components/ui/label';
import { Switch } from '~/components/ui/switch';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface EventAttendanceRosterSectionProps {
  teamId: string;
  eventId: string;
  rosters: ReadonlyArray<RosterDomain.RosterInfo>;
  initialEventRosterLink: Option.Option<EventRosterApi.EventRosterLink>;
  onRefresh: () => void;
}

export function EventAttendanceRosterSection({
  teamId,
  eventId,
  rosters,
  initialEventRosterLink,
  onRefresh,
}: EventAttendanceRosterSectionProps) {
  const run = useRun();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const eventIdBranded = Schema.decodeSync(Event.EventId)(eventId);

  // Current link state — starts from loader data, updated locally after mutations
  const [link, setLink] = React.useState<EventRosterApi.EventRosterLink | null>(
    Option.getOrNull(initialEventRosterLink),
  );

  // Unlinked form state
  const [mode, setMode] = React.useState<'link' | 'create'>('link');
  const [selectedRosterId, setSelectedRosterId] = React.useState('');
  const [newRosterName, setNewRosterName] = React.useState('');
  const [newRosterEmoji, setNewRosterEmoji] = React.useState('');
  const [newRosterColor, setNewRosterColor] = React.useState<string | undefined>(undefined);
  const [autoApprove, setAutoApprove] = React.useState(false);
  const [rsvpAnswers, setRsvpAnswers] = React.useState<
    ReadonlyArray<EventRosterModel.RosterRsvpAnswer>
  >(EventRosterModel.DEFAULT_ROSTER_RSVP_ANSWERS);
  const [createDiscordChannel, setCreateDiscordChannel] = React.useState(false);

  // Backfill dialog
  const [backfillDialogOpen, setBackfillDialogOpen] = React.useState(false);
  const [pendingAutoApproveValue, setPendingAutoApproveValue] = React.useState(false);

  // Unlink dialog
  const [unlinkDialogOpen, setUnlinkDialogOpen] = React.useState(false);

  const [submitting, setSubmitting] = React.useState(false);

  // Linking an event to an archived roster is never the intent; the linked roster itself is
  // rendered from `link`, so hiding inactive ones here cannot hide an existing link.
  const activeRosters = React.useMemo(() => rosters.filter((r) => r.active), [rosters]);

  // Channel state lives on the roster list, not the link; `onRefresh` reloads both.
  const linkedRoster =
    link === null ? undefined : rosters.find((r) => r.rosterId === link.rosterId);
  const channelProvisioning = linkedRoster?.discordChannelProvisioning ?? false;

  // Same polling as the roster page while the bot provisions the channel.
  React.useEffect(() => {
    if (!channelProvisioning) return;
    const id = setInterval(onRefresh, 5000);
    return () => clearInterval(id);
  }, [channelProvisioning, onRefresh]);

  // Sync link state back from prop when the parent reloads
  React.useEffect(() => {
    setLink(Option.getOrNull(initialEventRosterLink));
  }, [initialEventRosterLink]);

  // When the link loads, sync autoApprove from the server
  React.useEffect(() => {
    if (link !== null) {
      setAutoApprove(link.autoApprove);
    }
  }, [link]);

  const handleAutoApproveChange = (checked: boolean) => {
    if (link === null) {
      // Unlinked — just toggle local state
      setAutoApprove(checked);
      return;
    }
    if (checked && !link.autoApprove) {
      // Toggling OFF→ON on a live link requires backfill confirmation
      setPendingAutoApproveValue(true);
      setBackfillDialogOpen(true);
    } else if (!checked && link.autoApprove) {
      // Toggling ON→OFF — do immediately
      void handlePatchAutoApprove(false);
    }
  };

  const handlePatchAutoApprove = React.useCallback(
    async (value: boolean) => {
      setSubmitting(true);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRoster.patchEventRosterLink({
            params: { teamId: teamIdBranded, eventId: eventIdBranded },
            payload: { autoApprove: value },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('eventRoster_patchFailed'))),
        run({ success: tr('eventRoster_autoApprove') }),
      );
      setSubmitting(false);
      if (Option.isSome(result)) {
        setLink(result.value);
        setAutoApprove(result.value.autoApprove);
        onRefresh();
      }
    },
    [teamIdBranded, eventIdBranded, run, onRefresh],
  );

  const handlePatchRsvpAnswers = React.useCallback(
    async (next: ReadonlyArray<EventRosterModel.RosterRsvpAnswer>) => {
      if (link === null) return;
      setSubmitting(true);
      const result = await ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.eventRoster.patchEventRosterLink({
            params: { teamId: teamIdBranded, eventId: eventIdBranded },
            payload: { autoApprove: link.autoApprove, rsvpAnswers: next },
          }),
        ),
        Effect.mapError(() => ClientError.make(tr('eventRoster_patchFailed'))),
        run({ success: tr('eventRoster_rsvpAnswersSaved') }),
      );
      setSubmitting(false);
      if (Option.isSome(result)) {
        setLink(result.value);
        onRefresh();
      }
    },
    [link, teamIdBranded, eventIdBranded, run, onRefresh],
  );

  const handleBackfillConfirm = async () => {
    setBackfillDialogOpen(false);
    await handlePatchAutoApprove(pendingAutoApproveValue);
  };

  const handleBackfillCancel = () => {
    setBackfillDialogOpen(false);
    // Revert the pending change — no-op since autoApprove state wasn't changed yet
  };

  const requestDiscordChannel = React.useCallback(
    (rosterId: RosterModel.RosterId) =>
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.roster.createChannel({ params: { teamId: teamIdBranded, rosterId } }),
        ),
        Effect.mapError(() => ClientError.make(tr('roster_channelCreateFailed'))),
        run({ success: tr('roster_channelCreateRequested') }),
      ),
    [teamIdBranded, run],
  );

  const handleCreateChannel = React.useCallback(async () => {
    if (link === null) return;
    setSubmitting(true);
    await requestDiscordChannel(link.rosterId);
    setSubmitting(false);
    onRefresh();
  }, [link, requestDiscordChannel, onRefresh]);

  const handleLinkExisting = React.useCallback(async () => {
    if (!selectedRosterId) return;
    const rosterId = Schema.decodeSync(RosterModel.RosterId)(selectedRosterId);
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventRoster.linkEventRoster({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: { rosterId, autoApprove, rsvpAnswers },
        }),
      ),
      Effect.catchTag('EventRosterAlreadyLinked', () =>
        Effect.fail(ClientError.make(tr('eventRoster_linkFailed'))),
      ),
      Effect.mapError(() => ClientError.make(tr('eventRoster_linkFailed'))),
      run({ success: tr('eventRoster_autoApprove') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      setLink(result.value);
      setSelectedRosterId('');
      onRefresh();
    }
  }, [selectedRosterId, autoApprove, rsvpAnswers, teamIdBranded, eventIdBranded, run, onRefresh]);

  const handleCreateAndLink = React.useCallback(async () => {
    if (!newRosterName.trim()) return;
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventRoster.createAndLinkRoster({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: {
            name: newRosterName.trim(),
            emoji: newRosterEmoji ? Option.some(newRosterEmoji) : Option.none(),
            color: newRosterColor ? Option.some(newRosterColor) : Option.none(),
            autoApprove,
            rsvpAnswers,
          },
        }),
      ),
      Effect.catchTag('EventRosterAlreadyLinked', () =>
        Effect.fail(ClientError.make(tr('eventRoster_createFailed'))),
      ),
      Effect.mapError(() => ClientError.make(tr('eventRoster_createFailed'))),
      run({ success: tr('eventRoster_autoApprove') }),
    );
    if (Option.isSome(result)) {
      // The roster is linked either way; a failed channel request surfaces its own toast and
      // leaves the "Create Discord channel" button on the linked card as the retry.
      if (createDiscordChannel) await requestDiscordChannel(result.value.rosterId);
      setLink(result.value);
      setNewRosterName('');
      setNewRosterEmoji('');
      setNewRosterColor(undefined);
      setCreateDiscordChannel(false);
      onRefresh();
    }
    setSubmitting(false);
  }, [
    newRosterName,
    newRosterEmoji,
    newRosterColor,
    autoApprove,
    rsvpAnswers,
    createDiscordChannel,
    requestDiscordChannel,
    teamIdBranded,
    eventIdBranded,
    run,
    onRefresh,
  ]);

  const handleUnlinkConfirm = async () => {
    setUnlinkDialogOpen(false);
    setSubmitting(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventRoster.unlinkEventRoster({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('eventRoster_patchFailed'))),
      run({ success: tr('eventRoster_unlinked') }),
    );
    setSubmitting(false);
    if (Option.isSome(result)) {
      setLink(null);
      setAutoApprove(false);
      onRefresh();
    }
  };

  const showNoOwnerGroupWarning = link !== null && !link.hasOwnerGroup && !link.autoApprove;

  return (
    <>
      <Card className='mb-6 max-w-md'>
        <CardHeader>
          <CardTitle className='text-base'>{tr('eventRoster_section')}</CardTitle>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          {showNoOwnerGroupWarning && (
            <div className='rounded-md border border-amber-200 bg-amber-50 px-4 py-2 text-sm text-amber-800'>
              {tr('eventRoster_noOwnerGroupWarning')}
            </div>
          )}

          {link !== null ? (
            // Linked state
            <>
              <div className='flex items-center justify-between'>
                <div>
                  <p className='font-medium'>
                    {tr('eventRoster_linked', { name: link.rosterName })}
                  </p>
                  <p className='text-xs text-muted-foreground'>
                    {tr('roster_memberCount', { count: link.memberCount })}
                  </p>
                </div>
                <Button
                  variant='outline'
                  size='sm'
                  onClick={() => setUnlinkDialogOpen(true)}
                  disabled={submitting}
                >
                  {tr('eventRoster_unlink')}
                </Button>
              </div>

              {linkedRoster !== undefined && (
                <div className='flex items-center justify-between gap-2'>
                  {channelProvisioning ? (
                    <p className='flex items-center gap-2 text-sm text-muted-foreground'>
                      <Loader2 className='size-4 animate-spin' />
                      {tr('discord_channelProvisioning')}
                    </p>
                  ) : Option.isSome(linkedRoster.discordChannelId) ? (
                    <p className='text-sm'>
                      {tr('eventRoster_discordChannel', {
                        name: Option.getOrElse(linkedRoster.discordChannelName, () =>
                          linkedRoster.discordChannelId.pipe(Option.getOrElse(() => '')),
                        ),
                      })}
                    </p>
                  ) : (
                    <Button
                      variant='outline'
                      size='sm'
                      onClick={handleCreateChannel}
                      disabled={submitting}
                    >
                      {tr('eventRoster_createDiscordChannel')}
                    </Button>
                  )}
                </div>
              )}

              <div className='flex items-center gap-2'>
                <Switch
                  id='event-roster-auto-approve'
                  checked={link.autoApprove}
                  onCheckedChange={handleAutoApproveChange}
                  disabled={submitting}
                />
                <Label htmlFor='event-roster-auto-approve'>{tr('eventRoster_autoApprove')}</Label>
              </div>
              <p className='text-xs text-muted-foreground -mt-2'>
                {tr('eventRoster_autoApproveHelp')}
              </p>
              <RsvpAnswersPicker
                idPrefix='event-roster-rsvp-answer'
                value={link.rsvpAnswers ?? EventRosterModel.DEFAULT_ROSTER_RSVP_ANSWERS}
                onChange={handlePatchRsvpAnswers}
                disabled={submitting}
              />
            </>
          ) : (
            // Unlinked state
            <>
              <div className='flex flex-wrap gap-2'>
                <Button
                  variant={mode === 'link' ? 'default' : 'outline'}
                  size='sm'
                  onClick={() => setMode('link')}
                >
                  {tr('eventRoster_linkExisting')}
                </Button>
                <Button
                  variant={mode === 'create' ? 'default' : 'outline'}
                  size='sm'
                  onClick={() => setMode('create')}
                >
                  {tr('eventRoster_createNew')}
                </Button>
              </div>

              {mode === 'link' ? (
                <div className='flex gap-2'>
                  <SearchableSelect
                    value={selectedRosterId}
                    onValueChange={setSelectedRosterId}
                    placeholder={tr('eventRoster_linkRosterPlaceholder')}
                    options={activeRosters.map((r) => ({
                      value: r.rosterId,
                      label: Option.isSome(r.emoji) ? `${r.emoji.value} ${r.name}` : r.name,
                    }))}
                    className='flex-1'
                  />
                  <Button onClick={handleLinkExisting} disabled={!selectedRosterId || submitting}>
                    {tr('eventRoster_linkRoster')}
                  </Button>
                </div>
              ) : (
                <div className='flex flex-col gap-2'>
                  <div className='flex gap-2 items-end'>
                    <div className='flex flex-col'>
                      <label htmlFor='new-roster-emoji' className='text-sm font-medium mb-1'>
                        {tr('roster_emoji')}
                      </label>
                      <Input
                        id='new-roster-emoji'
                        value={newRosterEmoji}
                        onChange={(e) => setNewRosterEmoji(e.target.value)}
                        className='w-16 shrink-0'
                        placeholder='🏅'
                      />
                    </div>
                    <div className='flex flex-col'>
                      <label htmlFor='new-roster-color' className='text-sm font-medium mb-1'>
                        {tr('common_color')}
                      </label>
                      <ColorPicker
                        id='new-roster-color'
                        value={newRosterColor}
                        onChange={setNewRosterColor}
                      />
                    </div>
                    <div className='flex flex-col flex-1'>
                      <label htmlFor='new-roster-name' className='text-sm font-medium mb-1'>
                        {tr('eventRoster_createRosterName')}
                      </label>
                      <Input
                        id='new-roster-name'
                        value={newRosterName}
                        onChange={(e) => setNewRosterName(e.target.value)}
                        placeholder={tr('roster_rosterNamePlaceholder')}
                      />
                    </div>
                  </div>
                  <div className='flex items-center gap-2'>
                    <Switch
                      id='new-roster-create-discord-channel'
                      checked={createDiscordChannel}
                      onCheckedChange={setCreateDiscordChannel}
                    />
                    <Label htmlFor='new-roster-create-discord-channel'>
                      {tr('eventRoster_alsoCreateDiscordChannel')}
                    </Label>
                  </div>
                  <Button
                    onClick={handleCreateAndLink}
                    disabled={!newRosterName.trim() || submitting}
                  >
                    {tr('eventRoster_create')}
                  </Button>
                </div>
              )}

              <div className='flex items-center gap-2'>
                <Switch
                  id='event-roster-auto-approve-unlinked'
                  checked={autoApprove}
                  onCheckedChange={setAutoApprove}
                />
                <Label htmlFor='event-roster-auto-approve-unlinked'>
                  {tr('eventRoster_autoApprove')}
                </Label>
              </div>
              <p className='text-xs text-muted-foreground -mt-2'>
                {tr('eventRoster_autoApproveHelp')}
              </p>
              <RsvpAnswersPicker
                idPrefix='event-roster-rsvp-answer-unlinked'
                value={rsvpAnswers}
                onChange={setRsvpAnswers}
                disabled={submitting}
              />
            </>
          )}
        </CardContent>
      </Card>

      {/* Backfill confirmation dialog */}
      <AlertDialog open={backfillDialogOpen} onOpenChange={setBackfillDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('eventRoster_backfillDialogTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('eventRoster_backfillDialogBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleBackfillCancel}>
              {tr('eventRoster_backfillDialogCancel')}
            </AlertDialogCancel>
            <AlertDialogAction onClick={handleBackfillConfirm}>
              {tr('eventRoster_backfillDialogConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Unlink confirmation dialog */}
      <AlertDialog open={unlinkDialogOpen} onOpenChange={setUnlinkDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('eventRoster_unlinkConfirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{tr('eventRoster_unlinkConfirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('eventRoster_unlinkConfirmCancel')}</AlertDialogCancel>
            <AlertDialogAction variant='destructive' onClick={handleUnlinkConfirm}>
              {tr('eventRoster_unlinkConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

const RSVP_ANSWER_ORDER: ReadonlyArray<EventRosterModel.RosterRsvpAnswer> = [
  'yes',
  'coming_later',
  'maybe',
];

function RsvpAnswersPicker({
  idPrefix,
  value,
  onChange,
  disabled,
}: {
  idPrefix: string;
  value: ReadonlyArray<EventRosterModel.RosterRsvpAnswer>;
  onChange: (next: ReadonlyArray<EventRosterModel.RosterRsvpAnswer>) => void;
  disabled: boolean;
}) {
  const labels: Record<EventRosterModel.RosterRsvpAnswer, string> = {
    yes: tr('rsvp_yes'),
    coming_later: tr('rsvp_comingLater'),
    maybe: tr('rsvp_maybe'),
  };
  return (
    <fieldset className='flex flex-col gap-2'>
      <legend className='mb-1 text-sm font-medium'>{tr('eventRoster_rsvpAnswers')}</legend>
      <div className='flex flex-wrap gap-4'>
        {RSVP_ANSWER_ORDER.map((answer) => {
          const checked = value.includes(answer);
          const id = `${idPrefix}-${answer}`;
          return (
            <div key={answer} className='flex items-center gap-2'>
              <Checkbox
                id={id}
                checked={checked}
                // The set can never be empty, so the last ticked answer stays ticked.
                disabled={disabled || (checked && value.length === 1)}
                onCheckedChange={(next) =>
                  onChange(next === true ? [...value, answer] : value.filter((a) => a !== answer))
                }
              />
              <Label htmlFor={id}>{labels[answer]}</Label>
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
