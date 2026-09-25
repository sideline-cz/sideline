import type { EventAttendanceApi, EventRsvp } from '@sideline/domain';
import { Event, Team, TeamMember } from '@sideline/domain';
import type { DateTime } from 'effect';
import { Effect, Option, Schema } from 'effect';
import React from 'react';

import { Button } from '~/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '~/components/ui/card';
import { Checkbox } from '~/components/ui/checkbox';
import { formatLocalDate, formatLocalTime } from '~/lib/datetime.js';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

type RsvpResponse = EventRsvp.RsvpResponse;

// Same canonical response -> label-key mapping as EventRsvpPanel — this is just a muted hint,
// not the RSVP panel itself, so it isn't worth sharing/exporting a module for.
const RESPONSE_LABEL_KEY: Record<RsvpResponse, string> = {
  yes: 'rsvp_yes',
  coming_later: 'rsvp_comingLater',
  maybe: 'rsvp_maybe',
  no: 'rsvp_no',
};

interface EventAttendanceConfirmSectionProps {
  teamId: string;
  eventId: string;
  confirmedAt: Option.Option<DateTime.Utc>;
  entries: ReadonlyArray<EventAttendanceApi.EventAttendanceEntry>;
  onRefresh: () => void;
}

const seedPresent = (
  source: ReadonlyArray<EventAttendanceApi.EventAttendanceEntry>,
): Record<string, boolean> => {
  const next: Record<string, boolean> = {};
  for (const entry of source) {
    next[entry.teamMemberId] = entry.present;
  }
  return next;
};

export function EventAttendanceConfirmSection({
  teamId,
  eventId,
  confirmedAt,
  entries,
  onRefresh,
}: EventAttendanceConfirmSectionProps) {
  const run = useRun();

  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const eventIdBranded = Schema.decodeSync(Event.EventId)(eventId);

  const [present, setPresent] = React.useState<Record<string, boolean>>(() => seedPresent(entries));
  const [saving, setSaving] = React.useState(false);

  // Re-seed whenever the parent refreshes (e.g. router.invalidate()) so a stale confirmation
  // doesn't linger — see the PUT handler below for why this same call also runs on failure.
  React.useEffect(() => {
    setPresent(seedPresent(entries));
  }, [entries]);

  const handleConfirm = React.useCallback(async () => {
    setSaving(true);
    await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.eventAttendance.confirmEventAttendance({
          params: { teamId: teamIdBranded, eventId: eventIdBranded },
          payload: {
            // Full replace — every listed entry is sent, not just the ones toggled.
            entries: entries.map((entry) => ({
              teamMemberId: Schema.decodeSync(TeamMember.TeamMemberId)(entry.teamMemberId),
              present: present[entry.teamMemberId] ?? entry.present,
            })),
          },
        }),
      ),
      Effect.catchTag('EventAttendanceNotConfirmable', () =>
        Effect.fail(ClientError.make(tr('eventAttendance_notConfirmable'))),
      ),
      Effect.mapError(() => ClientError.make(tr('eventAttendance_saveFailed'))),
      run({ success: tr('eventAttendance_saved') }),
    );
    setSaving(false);
    // Refresh on every outcome, success or failure — an earlier slice only invalidated on one
    // error tag and left a stale row clickable forever.
    onRefresh();
  }, [teamIdBranded, eventIdBranded, entries, present, run, onRefresh]);

  return (
    <Card className='mb-6 max-w-md' id='event-attendance'>
      <CardHeader>
        <CardTitle className='text-base'>{tr('eventAttendance_section')}</CardTitle>
        <p className='text-sm text-muted-foreground'>{tr('eventAttendance_description')}</p>
      </CardHeader>
      <CardContent className='flex flex-col gap-4'>
        {Option.isSome(confirmedAt) && (
          <p className='text-sm text-muted-foreground'>
            {tr('eventAttendance_confirmedAt', {
              date: formatLocalDate(confirmedAt.value),
              time: formatLocalTime(confirmedAt.value),
            })}
          </p>
        )}

        {entries.length === 0 ? (
          <p className='text-sm text-muted-foreground'>{tr('eventAttendance_empty')}</p>
        ) : (
          <>
            <div className='flex flex-col gap-2'>
              {entries.map((entry) => {
                const inputId = `event-attendance-${entry.teamMemberId}`;
                return (
                  <label
                    key={entry.teamMemberId}
                    htmlFor={inputId}
                    className='flex items-center gap-2 text-sm'
                  >
                    <Checkbox
                      id={inputId}
                      checked={present[entry.teamMemberId] ?? entry.present}
                      onCheckedChange={(checked) =>
                        setPresent((prev) => ({
                          ...prev,
                          [entry.teamMemberId]: checked === true,
                        }))
                      }
                    />
                    <span>{entry.displayName}</span>
                    {Option.isSome(entry.rsvpResponse) && (
                      <span className='text-xs text-muted-foreground'>
                        ({tr(RESPONSE_LABEL_KEY[entry.rsvpResponse.value])})
                      </span>
                    )}
                  </label>
                );
              })}
            </div>

            <Button onClick={handleConfirm} disabled={saving} className='self-start'>
              {saving
                ? tr('eventAttendance_saving')
                : Option.isSome(confirmedAt)
                  ? tr('eventAttendance_update')
                  : tr('eventAttendance_confirm')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
