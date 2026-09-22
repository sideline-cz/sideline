import { Team, type TeamApi } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import React from 'react';
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
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import { Separator } from '~/components/ui/separator';
import { Switch } from '~/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '~/components/ui/toggle-group';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';
import { SaveRow } from './team-settings/SaveRow';
import { useCardForm } from './team-settings/useCardForm';

type ChannelMode = 'one' | 'split';

interface EventPreferencesFormValues extends Record<string, boolean | string> {
  readonly showAttendeeList: boolean;
  readonly rsvpReminderDms: boolean;
  readonly channelMode: ChannelMode;
}

interface EventPreferencesCardProps {
  readonly teamId: string;
  // Non-nullable on purpose. `useCardForm` seeds its `useState` from this ONCE, so a card
  // that first mounted against a failed load would keep those seed values after a
  // successful retry — showing defaults over a real baseline, dirty, with Save armed to
  // overwrite the member's actual settings (and, via channelMode, delete their channels).
  // The failure state is `EventPreferencesLoadFailed`, a DIFFERENT component, so React
  // remounts on the transition and the form is always seeded from real prefs.
  readonly prefs: TeamApi.MemberEventPreferences;
  readonly onRefresh: () => void;
}

function valuesFromPrefs(prefs: TeamApi.MemberEventPreferences): EventPreferencesFormValues {
  return {
    showAttendeeList: prefs.showAttendeeList,
    rsvpReminderDms: prefs.rsvpReminderDms,
    channelMode: prefs.personalChannelsSplit ? 'split' : 'one',
  };
}

/** Load-failure sibling of `EventPreferencesCard`. Holds no form state — see the note above. */
export function EventPreferencesLoadFailed({ onRefresh }: { readonly onRefresh: () => void }) {
  return (
    <Card className='w-full max-w-md mt-4'>
      <CardHeader>
        <CardTitle>{tr('eventPrefs_title')}</CardTitle>
        <CardDescription>{tr('eventPrefs_description')}</CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <Alert variant='destructive'>
          <AlertDescription>{tr('eventPrefs_loadFailed')}</AlertDescription>
        </Alert>
        <Button variant='outline' size='sm' onClick={onRefresh}>
          {tr('common_retry')}
        </Button>
      </CardContent>
    </Card>
  );
}

/**
 * Nastavitelná docházka (design.md §A). One card per team, rendered by
 * `EventPreferencesSection` in `MyProfilePage`. Reuses `team-settings/useCardForm.ts` +
 * `team-settings/SaveRow.tsx` in place (generic despite the folder — design.md §A.2).
 *
 * Explicit Save only — no auto-save. The channel-mode `ToggleGroup` is destructive
 * (Discord channels are rebuilt), so it gets an `AlertDialog` on Save, gated on
 * `channelModeChanged`, captured once before the request so a fresh `onRefresh()` baseline
 * can never be compared against itself (design.md §A.6/§A.8).
 */
export function EventPreferencesCard({ teamId, prefs, onRefresh }: EventPreferencesCardProps) {
  const run = useRun();
  const baseline = valuesFromPrefs(prefs);
  const form = useCardForm(baseline);
  const { setField } = form;

  const [saving, setSaving] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  const personalChannelsAvailable = prefs.personalChannelsAvailable;
  // Captured fresh on every render from props-derived `baseline` — never read after an
  // `await`, where `baseline` would already reflect the just-saved values (design.md §A.6).
  const channelModeChanged =
    personalChannelsAvailable && form.values.channelMode !== baseline.channelMode;

  const attendeesId = `event-prefs-attendees-${teamId}`;
  const attendeesHelpId = `event-prefs-attendees-help-${teamId}`;
  const remindersId = `event-prefs-reminders-${teamId}`;
  const remindersHelpId = `event-prefs-reminders-help-${teamId}`;
  const channelsLabelId = `event-prefs-channels-label-${teamId}`;
  const channelsHelpId = `event-prefs-channels-help-${teamId}`;

  const doSave = async (changed: boolean) => {
    setSaving(true);
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.team.updateMyEventPreferences({
          params: { teamId: Schema.decodeSync(Team.TeamId)(teamId) },
          payload: {
            showAttendeeList: form.values.showAttendeeList,
            rsvpReminderDms: form.values.rsvpReminderDms,
            personalChannelsSplit: form.values.channelMode === 'split',
          },
        }),
      ),
      Effect.mapError(() => ClientError.make(tr('eventPrefs_saveFailed'))),
      run({ success: changed ? tr('eventPrefs_savedChannels') : tr('eventPrefs_saved') }),
    );
    setSaving(false);
    setConfirmOpen(false);
    if (Option.isSome(result)) {
      onRefresh();
    }
  };

  const handleSaveClick = () => {
    if (channelModeChanged) {
      setConfirmOpen(true);
      return;
    }
    void doSave(false);
  };

  return (
    <>
      <Card className='w-full max-w-md mt-4'>
        <CardHeader>
          <CardTitle>{tr('eventPrefs_title')}</CardTitle>
          <CardDescription>{tr('eventPrefs_description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className='flex flex-col gap-5'>
            <div className='flex items-start justify-between gap-4'>
              <div>
                <Label htmlFor={attendeesId} className='text-sm font-medium block'>
                  {tr('eventPrefs_showAttendees')}
                </Label>
                <p id={attendeesHelpId} className='text-xs text-muted-foreground mt-1'>
                  {tr('eventPrefs_showAttendeesHelp')}
                </p>
              </div>
              <Switch
                id={attendeesId}
                checked={form.values.showAttendeeList}
                aria-describedby={attendeesHelpId}
                disabled={saving}
                onCheckedChange={(checked) => setField('showAttendeeList', checked)}
              />
            </div>

            <Separator />

            <div className='flex items-start justify-between gap-4'>
              <div>
                <Label htmlFor={remindersId} className='text-sm font-medium block'>
                  {tr('eventPrefs_reminders')}
                </Label>
                <p id={remindersHelpId} className='text-xs text-muted-foreground mt-1'>
                  {tr('eventPrefs_remindersHelp')}
                </p>
              </div>
              <Switch
                id={remindersId}
                checked={form.values.rsvpReminderDms}
                aria-describedby={remindersHelpId}
                disabled={saving}
                onCheckedChange={(checked) => setField('rsvpReminderDms', checked)}
              />
            </div>

            {personalChannelsAvailable && (
              <>
                <Separator />
                <div>
                  <span id={channelsLabelId} className='text-sm font-medium mb-1 block'>
                    {tr('eventPrefs_channels')}
                  </span>
                  <ToggleGroup
                    type='single'
                    variant='outline'
                    value={form.values.channelMode}
                    aria-labelledby={channelsLabelId}
                    aria-describedby={channelsHelpId}
                    onValueChange={(value) => {
                      if (value === 'one' || value === 'split') setField('channelMode', value);
                    }}
                  >
                    <ToggleGroupItem value='one' disabled={saving}>
                      {tr('eventPrefs_channelsOne')}
                    </ToggleGroupItem>
                    <ToggleGroupItem value='split' disabled={saving}>
                      {tr('eventPrefs_channelsSplit')}
                    </ToggleGroupItem>
                  </ToggleGroup>
                  <p id={channelsHelpId} className='text-xs text-muted-foreground mt-2'>
                    {tr('eventPrefs_channelsHelp')}
                  </p>
                </div>
              </>
            )}

            <SaveRow onSave={handleSaveClick} saving={saving} dirty={form.isDirty} />
          </div>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{tr('eventPrefs_confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {form.values.channelMode === 'split'
                ? tr('eventPrefs_confirmToSplit')
                : tr('eventPrefs_confirmToOne')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{tr('common_cancel')}</AlertDialogCancel>
            <AlertDialogAction disabled={saving} onClick={() => void doSave(channelModeChanged)}>
              {tr('eventPrefs_confirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
