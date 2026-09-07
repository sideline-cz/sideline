import type { ChannelSyncEvent, TeamSettingsApi } from '@sideline/domain';
import { Option } from 'effect';
import {
  channelToOption,
  DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  groupIdToOption,
  isFormatValid,
  selectValue,
} from './shared';

/**
 * Every field the team-settings Save button owns — the single source for both
 * the dirty check (via `useCardForm`) and the request payload
 * (`settingsRequestFrom`). Adding a field here and forgetting the payload is
 * caught by `settingsForm.test.ts`.
 */
export type SettingsFormValues = {
  horizonDays: string;
  minPlayersThreshold: string;
  rsvpRemindersEnabled: boolean;
  rsvpReminderDaysBefore: string;
  maxMissedRsvps: string;
  claimRequestDaysBefore: string;
  rsvpReminderTime: string;
  timezone: string;
  remindersChannelId: string;
  rulesQuizChannel: string;
  rulesQuizIntervalDays: string;
  rulesQuizTime: string;
  channelLateRsvp: string;
  archiveCategory: string;
  rosterCategory: string;
  personalEventsCategory: string;
  personalEventsGroupId: string;
  personalEventsChannelFormat: string;
  cleanupOnGroupDelete: ChannelSyncEvent.ChannelCleanupMode;
  cleanupOnRosterDeactivate: ChannelSyncEvent.ChannelCleanupMode;
  createDiscordChannelOnGroup: boolean;
  createDiscordChannelOnRoster: boolean;
  roleFormat: string;
  channelFormat: string;
};

export const settingsFormFrom = (
  settings: TeamSettingsApi.TeamSettingsInfo,
): SettingsFormValues => ({
  horizonDays: String(settings.eventHorizonDays),
  minPlayersThreshold: String(settings.minPlayersThreshold),
  rsvpRemindersEnabled: settings.rsvpRemindersEnabled,
  rsvpReminderDaysBefore: String(settings.rsvpReminderDaysBefore),
  maxMissedRsvps: String(settings.maxMissedRsvps),
  claimRequestDaysBefore: String(settings.claimRequestDaysBefore),
  rsvpReminderTime: settings.rsvpReminderTime || '18:00',
  timezone: settings.timezone || 'Europe/Prague',
  remindersChannelId: selectValue(settings.remindersChannelId),
  rulesQuizChannel: selectValue(settings.rulesQuizChannelId),
  rulesQuizIntervalDays: String(settings.rulesQuizIntervalDays),
  rulesQuizTime: settings.rulesQuizTime,
  channelLateRsvp: selectValue(settings.discordChannelLateRsvp),
  archiveCategory: selectValue(settings.discordArchiveCategoryId),
  rosterCategory: selectValue(settings.discordRosterCategoryId),
  personalEventsCategory: selectValue(settings.discordPersonalEventsCategoryId),
  personalEventsGroupId: selectValue(settings.discordPersonalEventsGroupId),
  personalEventsChannelFormat:
    settings.discordPersonalEventsChannelFormat || DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  cleanupOnGroupDelete: settings.discordChannelCleanupOnGroupDelete,
  cleanupOnRosterDeactivate: settings.discordChannelCleanupOnRosterDeactivate,
  createDiscordChannelOnGroup: settings.createDiscordChannelOnGroup,
  createDiscordChannelOnRoster: settings.createDiscordChannelOnRoster,
  roleFormat: settings.discordRoleFormat,
  channelFormat: settings.discordChannelFormat,
});

/** `<input type="time">` yields `HH:MM:SS` in some browsers. */
const normaliseTime = (value: string) => value.slice(0, 5);

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The translation key of the first field that would be rejected, or
 * `undefined` when the form can be sent.
 *
 * Every one of these used to be a bare `return` inside the save handler, so a
 * half-typed or out-of-range field made Save do **nothing at all** — no toast,
 * no spinner, no request, no clue which field was at fault. Clearing a number
 * input to retype it leaves `''`, `parseInt` gives `NaN`, and the whole page
 * stopped saving, including every setting unrelated to the one being edited.
 *
 * Bounds mirror `UpdateTeamSettingsRequest` and the DB CHECK constraints;
 * those stay the real backstop. This exists so the person is told which field
 * to look at.
 */
export const findInvalidSettingsField = (values: SettingsFormValues): string | undefined => {
  // A blank field must not parse to a number. `Number('')` is 0, and 0 is in
  // range for the coach-claim window — so clearing that input used to save a
  // silent zero instead of naming itself.
  const num = (raw: string, parse: (s: string) => number) =>
    raw.trim() === '' ? Number.NaN : parse(raw);
  const int = (raw: string) => num(raw, (s) => Number.parseInt(s, 10));
  const outside = (n: number, min: number, max: number) => Number.isNaN(n) || n < min || n > max;
  const claimDays = num(values.claimRequestDaysBefore, Number);
  const reminderTime = normaliseTime(values.rsvpReminderTime);

  const checks: ReadonlyArray<readonly [boolean, string]> = [
    [outside(int(values.horizonDays), 1, 365), 'teamSettings_horizonDays'],
    [outside(int(values.minPlayersThreshold), 0, 100), 'teamSettings_minPlayersThreshold'],
    [outside(int(values.rsvpReminderDaysBefore), 0, 14), 'teamSettings_rsvpReminderDaysBefore'],
    [outside(int(values.maxMissedRsvps), 1, 50), 'teamSettings_maxMissedRsvps'],
    [
      !Number.isInteger(claimDays) || claimDays < 0 || claimDays > 30,
      'teamSettings_claimRequestDaysBefore',
    ],
    // `rsvpReminderTime` reaches the DTO's 23:54 ceiling (later would wrap past
    // midnight). Unvalidated, an empty or 23:59 time got a bare "save failed".
    [!HH_MM.test(reminderTime) || reminderTime >= '23:55', 'teamSettings_rsvpReminderTime'],
    [values.timezone.trim().length === 0, 'teamSettings_timezone'],
    [!isFormatValid(values.roleFormat), 'teamSettings_roleFormat'],
    [!isFormatValid(values.channelFormat), 'teamSettings_channelFormat'],
    // Only required to be non-empty — the placeholders are optional because a
    // static name is fine for a private per-member channel.
    [
      values.personalEventsChannelFormat.trim().length === 0,
      'teamSettings_personalEventsChannelFormat',
    ],
    [outside(int(values.rulesQuizIntervalDays), 1, 90), 'teamSettings_rulesQuizInterval'],
    [!HH_MM.test(normaliseTime(values.rulesQuizTime)), 'teamSettings_rulesQuizTime'],
  ];

  return checks.find(([invalid]) => invalid)?.[1];
};

/**
 * Assumes `findInvalidSettingsField` returned `undefined`. Every key of
 * `SettingsFormValues` must appear here; the exhaustiveness test enforces it.
 */
export const settingsRequestFrom = (
  values: SettingsFormValues,
): TeamSettingsApi.UpdateTeamSettingsRequest => ({
  eventHorizonDays: Option.some(Number.parseInt(values.horizonDays, 10)),
  minPlayersThreshold: Option.some(Number.parseInt(values.minPlayersThreshold, 10)),
  rsvpRemindersEnabled: Option.some(values.rsvpRemindersEnabled),
  rsvpReminderDaysBefore: Option.some(Number.parseInt(values.rsvpReminderDaysBefore, 10)),
  maxMissedRsvps: Option.some(Number.parseInt(values.maxMissedRsvps, 10)),
  claimRequestDaysBefore: Option.some(Number(values.claimRequestDaysBefore)),
  rsvpReminderTime: Option.some(normaliseTime(values.rsvpReminderTime)),
  timezone: Option.some(values.timezone),
  remindersChannelId: Option.some(channelToOption(values.remindersChannelId)),
  rulesQuizChannelId: Option.some(channelToOption(values.rulesQuizChannel)),
  rulesQuizIntervalDays: Option.some(Number.parseInt(values.rulesQuizIntervalDays, 10)),
  rulesQuizTime: Option.some(normaliseTime(values.rulesQuizTime)),
  discordChannelLateRsvp: Option.some(channelToOption(values.channelLateRsvp)),
  discordArchiveCategoryId: Option.some(channelToOption(values.archiveCategory)),
  discordRosterCategoryId: Option.some(channelToOption(values.rosterCategory)),
  discordPersonalEventsCategoryId: Option.some(channelToOption(values.personalEventsCategory)),
  discordPersonalEventsGroupId: Option.some(groupIdToOption(values.personalEventsGroupId)),
  discordPersonalEventsChannelFormat: Option.some(values.personalEventsChannelFormat),
  discordChannelCleanupOnGroupDelete: Option.some(values.cleanupOnGroupDelete),
  discordChannelCleanupOnRosterDeactivate: Option.some(values.cleanupOnRosterDeactivate),
  createDiscordChannelOnGroup: Option.some(values.createDiscordChannelOnGroup),
  createDiscordChannelOnRoster: Option.some(values.createDiscordChannelOnRoster),
  discordRoleFormat: Option.some(values.roleFormat),
  discordChannelFormat: Option.some(values.channelFormat),
  // Not surfaced in the UI anymore (global events board removed); `None` omits
  // the key on the wire so the server keeps the existing value.
  discordEventsChannelId: Option.none(),
});
