import type { ChannelSyncEvent, Event, TeamSettingsApi } from '@sideline/domain';
import { Option } from 'effect';
import {
  channelToOption,
  DEFAULT_PERSONAL_EVENTS_CHANNEL_FORMAT,
  groupIdToOption,
  isFormatValid,
  selectValue,
} from './shared';

/**
 * The event types that can carry a per-type override — reminder lead time (`reminderDaysBefore_*`)
 * and RSVP lock (`lockHoursBefore_*`). Both are kept as flat `string` fields on the form rather
 * than a nested map because `useCardForm` compares with `!==` over primitives — a nested object
 * would be a fresh reference every render and so read as permanently dirty.
 *
 * What an empty string means differs per feature and is documented at each mapping site below.
 */
export const OVERRIDE_EVENT_TYPES = [
  'training',
  'match',
  'tournament',
  'meeting',
  'social',
  'other',
] as const satisfies ReadonlyArray<Event.EventType>;

type ReminderOverrideFields = {
  [K in Event.EventType as `reminderDaysBefore_${K}`]: string;
};

export const reminderOverrideField = <K extends Event.EventType>(
  eventType: K,
): `reminderDaysBefore_${K}` => `reminderDaysBefore_${eventType}`;

type LockOverrideFields = {
  [K in Event.EventType as `lockHoursBefore_${K}`]: string;
};

export const lockOverrideField = <K extends Event.EventType>(
  eventType: K,
): `lockHoursBefore_${K}` => `lockHoursBefore_${eventType}`;

/**
 * The per-type "no early lock at all" value, as it lives in the form. Written by the `Off` option
 * of each row's selector in `GeneralLimitsCard`, never typed.
 *
 * It is a string sentinel rather than a second field because `settingsRequestFrom` is called with
 * `values` alone — it never sees the settings that were loaded — and `useCardForm` only holds flat
 * primitives. Rendering a stored `null` as `''` would make it indistinguishable from "key absent",
 * so the next save of any unrelated setting on this page would silently flip that event type from
 * off back to inherit, without the user touching the field.
 */
export const LOCK_OVERRIDE_OFF = 'off';

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
  requireCompleteProfile: boolean;
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
  // Blank means OFF — no early lock anywhere. The opposite of the blank in `lockHoursBefore_*`,
  // which means "inherit this value".
  rsvpLockHoursBefore: string;
} & ReminderOverrideFields &
  LockOverrideFields;

const overrideFieldsFrom = (
  overrides: TeamSettingsApi.TeamSettingsInfo['rsvpReminderDaysBeforeOverrides'],
): ReminderOverrideFields =>
  Object.fromEntries(
    OVERRIDE_EVENT_TYPES.map((eventType) => [
      reminderOverrideField(eventType),
      overrides[eventType] === undefined ? '' : String(overrides[eventType]),
    ]),
  ) as ReminderOverrideFields;

/**
 * Three stored states, three form values: key absent -> `''` (inherit the team-wide value), a
 * number -> its digits, an explicit `null` -> the `off` sentinel.
 */
const lockOverrideFieldsFrom = (
  overrides: TeamSettingsApi.TeamSettingsInfo['rsvpLockHoursBeforeOverrides'],
): LockOverrideFields =>
  Object.fromEntries(
    OVERRIDE_EVENT_TYPES.map((eventType) => {
      const stored = overrides[eventType];
      return [
        lockOverrideField(eventType),
        stored === undefined ? '' : stored === null ? LOCK_OVERRIDE_OFF : String(stored),
      ];
    }),
  ) as LockOverrideFields;

export const settingsFormFrom = (
  settings: TeamSettingsApi.TeamSettingsInfo,
): SettingsFormValues => ({
  ...overrideFieldsFrom(settings.rsvpReminderDaysBeforeOverrides),
  ...lockOverrideFieldsFrom(settings.rsvpLockHoursBeforeOverrides),
  rsvpLockHoursBefore: Option.match(settings.rsvpLockHoursBefore, {
    onNone: () => '',
    onSome: String,
  }),
  horizonDays: String(settings.eventHorizonDays),
  minPlayersThreshold: String(settings.minPlayersThreshold),
  rsvpRemindersEnabled: settings.rsvpRemindersEnabled,
  requireCompleteProfile: settings.requireCompleteProfile,
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
    // Blank is VALID here — it means "no early lock at all" — unlike every other number field
    // above where blank is the half-typed value being guarded against. The `off` sentinel is NOT
    // valid in the team-wide scalar: blank already says the same thing.
    [
      values.rsvpLockHoursBefore.trim() !== '' && outside(int(values.rsvpLockHoursBefore), 0, 336),
      'teamSettings_rsvpLockHoursBefore',
    ],
    // Blank is VALID here too, but it means "inherit the scalar above" — the other of this card's
    // two blanks. `outside(NaN, 0, 336)` is `TRUE` (see `outside` above), so every non-numeric
    // string is rejected — including the `off` sentinel. Matching `off` EXPLICITLY is what lets
    // it through, while every typo next to it (`offf`, `nope`) still fails. Compared lowercased
    // so a value that did not come from the card's selector — a hand-edited stored `Off`, an
    // older client — is not turned into a validation error the user cannot clear.
    ...OVERRIDE_EVENT_TYPES.map((eventType) => {
      const raw = values[lockOverrideField(eventType)].trim().toLowerCase();
      return [
        raw !== '' && raw !== LOCK_OVERRIDE_OFF && outside(int(raw), 0, 336),
        'teamSettings_rsvpLockHoursBeforeOverrides',
      ] as const;
    }),
    // Per-event-type reminder overrides. Blank is the valid "no override" value here, unlike every
    // other number field above where blank is the bug being guarded against.
    ...OVERRIDE_EVENT_TYPES.map(
      (eventType) =>
        [
          values[reminderOverrideField(eventType)].trim() !== '' &&
            outside(int(values[reminderOverrideField(eventType)]), 0, 14),
          'teamSettings_rsvpReminderDaysBeforeOverrides',
        ] as const,
    ),
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
  // Blank means OFF — there is no lock at all — so it is sent as a present-but-cleared
  // `Some(None)` rather than omitted. (Blank in the override map below means the opposite:
  // inherit this value. Two different blanks in one card.)
  rsvpLockHoursBefore: Option.some(
    values.rsvpLockHoursBefore.trim() === ''
      ? Option.none()
      : Option.some(Number.parseInt(values.rsvpLockHoursBefore, 10)),
  ),
  // Blank means INHERIT the value above, so the key is omitted entirely. `off` is the explicit
  // per-type "no lock" and must survive as a real `null` — flattening it to blank here is what
  // would let the next save of an unrelated field silently turn that type back to inherit.
  rsvpLockHoursBeforeOverrides: Option.some(
    Object.fromEntries(
      OVERRIDE_EVENT_TYPES.flatMap((eventType) => {
        const raw = values[lockOverrideField(eventType)].trim().toLowerCase();
        if (raw === '') return [];
        return [[eventType, raw === LOCK_OVERRIDE_OFF ? null : Number.parseInt(raw, 10)] as const];
      }),
    ),
  ),
  // Blank means "no override", so the key is omitted entirely rather than sent as 0 — the server
  // falls back to `rsvpReminderDaysBefore` for any type missing from the map.
  rsvpReminderDaysBeforeOverrides: Option.some(
    Object.fromEntries(
      OVERRIDE_EVENT_TYPES.flatMap((eventType) => {
        const raw = values[reminderOverrideField(eventType)].trim();
        return raw === '' ? [] : [[eventType, Number.parseInt(raw, 10)] as const];
      }),
    ),
  ),
  eventHorizonDays: Option.some(Number.parseInt(values.horizonDays, 10)),
  minPlayersThreshold: Option.some(Number.parseInt(values.minPlayersThreshold, 10)),
  rsvpRemindersEnabled: Option.some(values.rsvpRemindersEnabled),
  requireCompleteProfile: Option.some(values.requireCompleteProfile),
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
