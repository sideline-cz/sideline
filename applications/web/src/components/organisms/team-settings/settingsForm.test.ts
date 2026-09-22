// The guard that replaces `TeamSettingsPage.dirty.test.ts`.
//
// That test scanned source text, because nothing tied a field's dirty flag to
// the handler that sent it and the type system could not express the link.
// Now both come from `SettingsFormValues`: `useCardForm` derives the dirty
// flag from it and `settingsRequestFrom` builds the payload from it. The link
// is real, so it can be tested for real — and the exhaustiveness test below
// fails if a field is ever added to the form and forgotten in the payload,
// which is the shape of the bug that shipped.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  findInvalidSettingsField,
  type SettingsFormValues,
  settingsRequestFrom,
} from './settingsForm';
import { NONE_VALUE } from './shared';
import { isFormDirty } from './useCardForm';

const BASE: SettingsFormValues = {
  horizonDays: '30',
  minPlayersThreshold: '8',
  rsvpRemindersEnabled: true,
  rsvpReminderDaysBefore: '2',
  maxMissedRsvps: '3',
  claimRequestDaysBefore: '5',
  rsvpReminderTime: '18:00',
  timezone: 'Europe/Prague',
  remindersChannelId: NONE_VALUE,
  rulesQuizChannel: NONE_VALUE,
  rulesQuizIntervalDays: '7',
  rulesQuizTime: '18:00',
  channelLateRsvp: NONE_VALUE,
  archiveCategory: NONE_VALUE,
  rosterCategory: NONE_VALUE,
  personalEventsCategory: NONE_VALUE,
  personalEventsGroupId: NONE_VALUE,
  personalEventsChannelFormat: 'events-{discord_id}',
  cleanupOnGroupDelete: 'nothing',
  cleanupOnRosterDeactivate: 'nothing',
  createDiscordChannelOnGroup: false,
  createDiscordChannelOnRoster: false,
  roleFormat: '{emoji} {name}',
  channelFormat: '{emoji}│{name}',
  requireCompleteProfile: false,
  // Blank = no override, so the whole feature is off in the baseline.
  reminderDaysBefore_training: '',
  reminderDaysBefore_match: '',
  reminderDaysBefore_tournament: '',
  reminderDaysBefore_meeting: '',
  reminderDaysBefore_social: '',
  reminderDaysBefore_other: '',
};

/**
 * A different, still-valid value for every field. Typed as the form itself, so
 * adding a field to `SettingsFormValues` and not to this object is a type
 * error — the loop below can never silently skip a field.
 */
const EDITED: SettingsFormValues = {
  horizonDays: '60',
  minPlayersThreshold: '10',
  rsvpRemindersEnabled: false,
  rsvpReminderDaysBefore: '3',
  maxMissedRsvps: '4',
  claimRequestDaysBefore: '6',
  rsvpReminderTime: '19:30',
  timezone: 'Europe/Berlin',
  remindersChannelId: '111111111111111111',
  rulesQuizChannel: '222222222222222222',
  rulesQuizIntervalDays: '14',
  rulesQuizTime: '22:35',
  channelLateRsvp: '333333333333333333',
  archiveCategory: '444444444444444444',
  rosterCategory: '555555555555555555',
  personalEventsCategory: '666666666666666666',
  personalEventsGroupId: '77777777-7777-4777-8777-777777777777',
  personalEventsChannelFormat: 'ev-{name}',
  cleanupOnGroupDelete: 'archive',
  cleanupOnRosterDeactivate: 'delete',
  createDiscordChannelOnGroup: true,
  createDiscordChannelOnRoster: true,
  roleFormat: '{name}',
  channelFormat: '{name}',
  requireCompleteProfile: true,
  reminderDaysBefore_training: '1',
  reminderDaysBefore_match: '2',
  reminderDaysBefore_tournament: '7',
  reminderDaysBefore_meeting: '0',
  reminderDaysBefore_social: '5',
  reminderDaysBefore_other: '14',
};

const FIELDS = Object.keys(BASE) as ReadonlyArray<keyof SettingsFormValues>;

const edit = (key: keyof SettingsFormValues): SettingsFormValues => ({
  ...BASE,
  [key]: EDITED[key],
});

describe('SettingsFormValues', () => {
  it('gives every field a distinct edited value to test with', () => {
    for (const key of FIELDS) {
      expect(EDITED[key], `EDITED.${key} must differ from BASE.${key}`).not.toBe(BASE[key]);
    }
  });

  describe('every field enables the Save button it belongs to', () => {
    it.each(FIELDS)('%s', (key) => {
      expect(isFormDirty(BASE, edit(key))).toBe(true);
    });
  });

  describe('every field the form tracks is actually sent', () => {
    // This is the bug that shipped, inverted: a field the settings card could
    // edit was not in the payload its Save button posted.
    const baseRequest = JSON.stringify(settingsRequestFrom(BASE));

    it.each(FIELDS)('%s', (key) => {
      expect(JSON.stringify(settingsRequestFrom(edit(key)))).not.toBe(baseRequest);
    });
  });

  it('is clean when nothing has been touched', () => {
    expect(isFormDirty(BASE, { ...BASE })).toBe(false);
  });

  // Task 5 — dedicated dirty-check for the new setting, matching how this file already asserts
  // `rsvpRemindersEnabled` is picked up by the generic per-field loop above.
  it('requireCompleteProfile dirty check: toggling it enables Save', () => {
    expect(isFormDirty(BASE, { ...BASE, requireCompleteProfile: true })).toBe(true);
    expect(isFormDirty(BASE, { ...BASE, requireCompleteProfile: false })).toBe(false);
  });
});

describe('settingsRequestFrom', () => {
  it('sends the rules-quiz fields, which the reminders card owns', () => {
    const request = settingsRequestFrom(EDITED);
    expect(request.rulesQuizChannelId).toStrictEqual(
      Option.some(Option.some('222222222222222222')),
    );
    expect(request.rulesQuizIntervalDays).toStrictEqual(Option.some(14));
    expect(request.rulesQuizTime).toStrictEqual(Option.some('22:35'));
  });

  it('leaves the retired global events channel untouched', () => {
    expect(settingsRequestFrom(BASE).discordEventsChannelId).toStrictEqual(Option.none());
  });

  it('maps NONE_VALUE to a cleared channel rather than a blank id', () => {
    expect(settingsRequestFrom(BASE).remindersChannelId).toStrictEqual(Option.some(Option.none()));
  });

  it('trims the seconds some browsers append to a time input', () => {
    const request = settingsRequestFrom({ ...BASE, rulesQuizTime: '22:35:00' });
    expect(request.rulesQuizTime).toStrictEqual(Option.some('22:35'));
  });

  // Task 5 (`.work-plans/discord-full-onboarding.md`) — the profile-gate opt-in
  // (`team_settings.require_complete_profile`). Same shape as `rsvpRemindersEnabled` above: a
  // plain boolean on the form, sent as `Option.some(<value>)` on every save (unlike the
  // select/channel fields, a checkbox is never "untouched").
  it('requireCompleteProfile round-trips: seed false, toggle to true, Option.some(true) in the payload', () => {
    expect(BASE.requireCompleteProfile).toBe(false);
    const request = settingsRequestFrom({ ...BASE, requireCompleteProfile: true });
    expect(request.requireCompleteProfile).toStrictEqual(Option.some(true));
  });
});

describe('findInvalidSettingsField', () => {
  it('accepts the saved values', () => {
    expect(findInvalidSettingsField(BASE)).toBeUndefined();
    expect(findInvalidSettingsField(EDITED)).toBeUndefined();
  });

  // Clearing a number input to retype it is the case that broke the page: the
  // handler used to bail with a bare `return`, so Save silently did nothing —
  // for every setting, not just the one being edited.
  it.each([
    ['horizonDays', 'teamSettings_horizonDays'],
    ['minPlayersThreshold', 'teamSettings_minPlayersThreshold'],
    ['rsvpReminderDaysBefore', 'teamSettings_rsvpReminderDaysBefore'],
    ['maxMissedRsvps', 'teamSettings_maxMissedRsvps'],
    ['claimRequestDaysBefore', 'teamSettings_claimRequestDaysBefore'],
    ['rulesQuizIntervalDays', 'teamSettings_rulesQuizInterval'],
  ] as ReadonlyArray<readonly [keyof SettingsFormValues, string]>)(
    'names %s when it is cleared',
    (field, expected) => {
      expect(findInvalidSettingsField({ ...BASE, [field]: '' })).toBe(expected);
    },
  );

  it.each([
    [{ horizonDays: '0' }, 'teamSettings_horizonDays'],
    [{ horizonDays: '366' }, 'teamSettings_horizonDays'],
    [{ minPlayersThreshold: '101' }, 'teamSettings_minPlayersThreshold'],
    [{ rsvpReminderDaysBefore: '15' }, 'teamSettings_rsvpReminderDaysBefore'],
    [{ maxMissedRsvps: '0' }, 'teamSettings_maxMissedRsvps'],
    [{ claimRequestDaysBefore: '1.5' }, 'teamSettings_claimRequestDaysBefore'],
    [{ claimRequestDaysBefore: '31' }, 'teamSettings_claimRequestDaysBefore'],
    [{ rulesQuizIntervalDays: '91' }, 'teamSettings_rulesQuizInterval'],
    [{ rulesQuizTime: '25:00' }, 'teamSettings_rulesQuizTime'],
    [{ rulesQuizTime: '' }, 'teamSettings_rulesQuizTime'],
    [{ roleFormat: '{emoji}' }, 'teamSettings_roleFormat'],
    [{ channelFormat: 'static' }, 'teamSettings_channelFormat'],
    [{ personalEventsChannelFormat: '  ' }, 'teamSettings_personalEventsChannelFormat'],
    [{ timezone: '' }, 'teamSettings_timezone'],
    // The DTO refuses 23:55 and later, because the reminder would wrap past
    // midnight. Unvalidated here, it came back as a bare "save failed".
    [{ rsvpReminderTime: '23:55' }, 'teamSettings_rsvpReminderTime'],
    [{ rsvpReminderTime: '' }, 'teamSettings_rsvpReminderTime'],
  ] as ReadonlyArray<readonly [Partial<SettingsFormValues>, string]>)(
    'rejects %o',
    (patch, expected) => {
      expect(findInvalidSettingsField({ ...BASE, ...patch })).toBe(expected);
    },
  );

  it('accepts the last minute before the wrap guard', () => {
    expect(findInvalidSettingsField({ ...BASE, rsvpReminderTime: '23:54' })).toBeUndefined();
  });

  // Blank is the one number field where empty is meaningful rather than a half-typed value: it
  // means "this type has no override", so it must NOT be reported as invalid.
  it('accepts a blank per-event-type override', () => {
    expect(
      findInvalidSettingsField({ ...BASE, reminderDaysBefore_tournament: '' }),
    ).toBeUndefined();
  });

  it.each([['15'], ['-1']])('rejects a per-event-type override of %s', (raw) => {
    expect(findInvalidSettingsField({ ...BASE, reminderDaysBefore_tournament: raw })).toBe(
      'teamSettings_rsvpReminderDaysBeforeOverrides',
    );
  });

  it('accepts the bounds of a per-event-type override', () => {
    expect(
      findInvalidSettingsField({ ...BASE, reminderDaysBefore_tournament: '0' }),
    ).toBeUndefined();
    expect(
      findInvalidSettingsField({ ...BASE, reminderDaysBefore_tournament: '14' }),
    ).toBeUndefined();
  });
});

describe('rsvpReminderDaysBeforeOverrides payload', () => {
  it('omits every event type while the boxes are blank', () => {
    expect(settingsRequestFrom(BASE).rsvpReminderDaysBeforeOverrides).toStrictEqual(
      Option.some({}),
    );
  });

  // The key must be ABSENT, not sent as 0 — the server falls back to the team-wide value only for
  // types missing from the map, so a 0 here would silently mean "remind on the day of the event".
  it('sends only the types that were filled in', () => {
    expect(
      settingsRequestFrom({ ...BASE, reminderDaysBefore_tournament: '3' })
        .rsvpReminderDaysBeforeOverrides,
    ).toStrictEqual(Option.some({ tournament: 3 }));
  });

  // Matches the sibling `rsvpReminderDaysBefore` field, which also parses with `parseInt`: a
  // fractional entry truncates rather than being rejected, so it can never reach the server as a
  // non-integer the schema would refuse.
  it('truncates a fractional entry the way the team-wide field does', () => {
    expect(
      settingsRequestFrom({ ...BASE, reminderDaysBefore_social: '1.5' })
        .rsvpReminderDaysBeforeOverrides,
    ).toStrictEqual(Option.some({ social: 1 }));
  });

  it('keeps an explicit 0, which is not the same as blank', () => {
    expect(
      settingsRequestFrom({ ...BASE, reminderDaysBefore_match: '0' })
        .rsvpReminderDaysBeforeOverrides,
    ).toStrictEqual(Option.some({ match: 0 }));
  });
});
