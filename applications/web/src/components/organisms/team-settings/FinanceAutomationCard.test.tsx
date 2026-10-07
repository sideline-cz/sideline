// The two money toggles that `updateTeamSettings` owns, after being moved off the General tab.
//
// They had no test at all while they lived in `GeneralLimitsCard` — only fixture values — so the
// move itself could have dropped either control with nothing going red. These assert both halves
// of what a move can break: that the control still renders bound to the right stored value, and
// that toggling it reaches the SHARED form, which is what the one save bar actually sends.

import { fireEvent, render, screen } from '@testing-library/react';
import { Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';

vi.mock('~/lib/translations.js', () => ({
  tr: (key: string) => key,
}));

const { FinanceAutomationCard } = await import('./FinanceAutomationCard.js');
const { settingsFormFrom } = await import('./settingsForm.js');
const { useCardForm } = await import('./useCardForm.js');

// Plain fixture, not a decoded `Schema.Class` instance — same convention (and same `as never`)
// as `GeneralLimitsCard.test.ts`, which nothing under test decodes.
const storedSettings = (over: Record<string, unknown> = {}) => ({
  eventHorizonDays: 30,
  minPlayersThreshold: 8,
  rsvpRemindersEnabled: true,
  requireCompleteProfile: false,
  autoAssignVariableSymbols: false,
  autoApplyCreditEnabled: false,
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
let dirty = false;

function Host({ settings }: { settings: Record<string, unknown> }) {
  const form = useCardForm(settingsFormFrom(settings as never));
  latest = form.values;
  dirty = form.isDirty;
  return <FinanceAutomationCard form={form} />;
}

const renderCard = (over: Record<string, unknown> = {}) =>
  render(<Host settings={storedSettings(over)} />);

const variableSymbols = () =>
  screen.getByLabelText<HTMLInputElement>('teamSettings_autoAssignVariableSymbols');
const autoApplyCredit = () =>
  screen.getByLabelText<HTMLInputElement>('teamSettings_autoApplyCreditEnabled');

describe('FinanceAutomationCard', () => {
  it('renders both toggles unchecked when the team has opted into neither', () => {
    renderCard();
    expect(variableSymbols().checked).toBe(false);
    expect(autoApplyCredit().checked).toBe(false);
    expect(dirty).toBe(false);
  });

  it('reflects each stored value independently', () => {
    renderCard({ autoAssignVariableSymbols: true, autoApplyCreditEnabled: false });
    expect(variableSymbols().checked).toBe(true);
    expect(autoApplyCredit().checked).toBe(false);
  });

  it('writes the variable-symbol toggle into the shared form', () => {
    renderCard();
    fireEvent.click(variableSymbols());
    expect(latest.autoAssignVariableSymbols).toBe(true);
    // The other toggle must not move with it — they were adjacent checkboxes in the card they
    // came from, which is exactly the shape where a copy-paste wires both to one field.
    expect(latest.autoApplyCreditEnabled).toBe(false);
    expect(dirty).toBe(true);
  });

  it('writes the auto-apply-credit toggle into the shared form', () => {
    renderCard();
    fireEvent.click(autoApplyCredit());
    expect(latest.autoApplyCreditEnabled).toBe(true);
    expect(latest.autoAssignVariableSymbols).toBe(false);
    expect(dirty).toBe(true);
  });

  it('toggling back to the stored value leaves the form clean', () => {
    renderCard({ autoApplyCreditEnabled: true });
    fireEvent.click(autoApplyCredit());
    expect(latest.autoApplyCreditEnabled).toBe(false);
    expect(dirty).toBe(true);
    fireEvent.click(autoApplyCredit());
    // Back to stored: the save bar must not offer to save a no-op.
    expect(latest.autoApplyCreditEnabled).toBe(true);
    expect(dirty).toBe(false);
  });
});
