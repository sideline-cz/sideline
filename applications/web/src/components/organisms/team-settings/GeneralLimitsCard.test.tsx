// The per-type RSVP-lock override grid. The subject is the tri-state row: `off` is the documented
// escape hatch for the all-day skew (a 24h team-wide lock closes a Saturday tournament on Friday
// midnight), so an admin has to be able to AUTHOR it — before this control it was reachable only
// by round-tripping a value the API already held, which made the mitigation fictional.
//
// The three states live in one flat string field because `useCardForm` holds
// `Record<string, Primitive>`; these tests read that string straight off the form so a regression
// to a nested value (permanently dirty) or to a flattened `''` (silently re-inherits on the next
// unrelated save) is visible here, not only at the API.

import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

vi.mock('@sideline/i18n/runtime', () => ({
  getLocale: () => 'en',
}));

const { GeneralLimitsCard, daysEcho } = await import('./GeneralLimitsCard.js');
const { settingsFormFrom } = await import('./settingsForm.js');
const { useCardForm } = await import('./useCardForm.js');

// Plain fixture, not a decoded `Schema.Class` instance — same convention (and same `as never`)
// as `settingsForm.test.ts`, which nothing under test decodes.
const storedSettings = (over: Record<string, unknown> = {}) => ({
  eventHorizonDays: 30,
  minPlayersThreshold: 8,
  rsvpRemindersEnabled: true,
  requireCompleteProfile: false,
  rsvpReminderDaysBefore: 2,
  rsvpReminderDaysBeforeOverrides: {},
  maxMissedRsvps: 3,
  claimRequestDaysBefore: 5,
  rsvpReminderTime: '18:00',
  timezone: 'Europe/Prague',
  remindersChannelId: Option.none(),
  rulesQuizChannelId: Option.none(),
  rulesQuizIntervalDays: 7,
  rulesQuizTime: '18:00',
  discordChannelLateRsvp: Option.none(),
  discordArchiveCategoryId: Option.none(),
  discordRosterCategoryId: Option.none(),
  discordPersonalEventsCategoryId: Option.none(),
  discordPersonalEventsGroupId: Option.none(),
  discordPersonalEventsChannelFormat: 'events-{discord_id}',
  discordChannelCleanupOnGroupDelete: 'nothing',
  discordChannelCleanupOnRosterDeactivate: 'nothing',
  createDiscordChannelOnGroup: false,
  createDiscordChannelOnRoster: false,
  discordRoleFormat: '{emoji} {name}',
  discordChannelFormat: '{emoji}│{name}',
  rsvpLockHoursBefore: Option.none(),
  rsvpLockHoursBeforeOverrides: {},
  ...over,
});

/** The live form value, so a test can assert what Save would send, not just what is on screen. */
let latest: Record<string, unknown> = {};

function Host({ settings }: { settings: Record<string, unknown> }) {
  const form = useCardForm(settingsFormFrom(settings as never));
  latest = form.values;
  return <GeneralLimitsCard form={form} />;
}

const renderCard = (over: Record<string, unknown> = {}) =>
  render(<Host settings={storedSettings(over)} />);

const modeSelect = (eventType: string) =>
  screen.getByLabelText<HTMLSelectElement>(`event_type_${eventType}`);

const hoursBox = (eventType: string) =>
  screen.getByLabelText<HTMLInputElement>(
    `event_type_${eventType} — teamSettings_lockOverride_hours`,
  );

describe('daysEcho', () => {
  it('echoes hours in days only at or above a full day, and never for the sentinel', () => {
    expect(daysEcho('120')).toBe('= 5 days');
    // Below the 24h floor there is nothing useful to say.
    expect(daysEcho('12')).toBeUndefined();
    // Must not render `= NaN days`.
    expect(daysEcho('off')).toBeUndefined();
    expect(daysEcho('')).toBeUndefined();
  });
});

describe('GeneralLimitsCard — per-type lock override', () => {
  it('shows each stored state on its own row: absent = inherit, null = off, number = hours', () => {
    renderCard({
      rsvpLockHoursBefore: Option.some(24),
      rsvpLockHoursBeforeOverrides: { tournament: null, training: 3 },
    });

    expect(modeSelect('tournament').value).toBe('off');
    expect(modeSelect('training').value).toBe('hours');
    expect(modeSelect('match').value).toBe('inherit');
    expect(hoursBox('training').value).toBe('3');
  });

  it('AUTHORS off: picking Off on a row writes the sentinel, not a blank', () => {
    renderCard({ rsvpLockHoursBefore: Option.some(24) });

    expect(latest.lockHoursBefore_tournament).toBe('');
    fireEvent.change(modeSelect('tournament'), { target: { value: 'off' } });

    expect(latest.lockHoursBefore_tournament).toBe('off');
    expect(modeSelect('tournament').value).toBe('off');
    // Off has no number to type — the box is gone, not disabled-and-ignored.
    expect(
      screen.queryByLabelText('event_type_tournament — teamSettings_lockOverride_hours'),
    ).toBeNull();
  });

  it('switching to Hours seeds the inherited value, and the box survives being cleared', () => {
    renderCard({ rsvpLockHoursBefore: Option.some(24) });

    fireEvent.change(modeSelect('match'), { target: { value: 'hours' } });
    expect(hoursBox('match').value).toBe('24');

    fireEvent.change(hoursBox('match'), { target: { value: '' } });
    // An emptied box means "inherit" in the payload, but the row must not snap back to Inherit
    // mid-edit and yank the input out from under the cursor.
    expect(latest.lockHoursBefore_match).toBe('');
    expect(modeSelect('match').value).toBe('hours');
    expect(hoursBox('match')).toBeTruthy();
  });

  // The row above arrives in `inherit` and is switched to `hours` by the `<select>`, which is the
  // only path that used to set `stickyHours`. A row that arrives from the SERVER already in hours
  // mode never touches that handler, so it had `stickyHours === false` and clearing the box to
  // retype it read as `''` = inherit — unmounting the input mid-keystroke.
  it('a SERVER-arrived hours row survives being cleared: the box stays mounted', () => {
    renderCard({
      rsvpLockHoursBefore: Option.some(48),
      rsvpLockHoursBeforeOverrides: { training: 24 },
    });

    expect(modeSelect('training').value).toBe('hours');
    expect(hoursBox('training').value).toBe('24');

    fireEvent.change(hoursBox('training'), { target: { value: '' } });

    expect(latest.lockHoursBefore_training).toBe('');
    expect(modeSelect('training').value).toBe('hours');
    expect(
      screen.queryByLabelText('event_type_training — teamSettings_lockOverride_hours'),
    ).not.toBeNull();
  });

  it('back to Inherit clears the field so the key is omitted again', () => {
    renderCard({ rsvpLockHoursBeforeOverrides: { tournament: null } });

    fireEvent.change(modeSelect('tournament'), { target: { value: 'inherit' } });
    expect(latest.lockHoursBefore_tournament).toBe('');
  });
});
