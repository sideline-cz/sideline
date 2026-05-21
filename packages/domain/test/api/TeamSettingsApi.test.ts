// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference types/schemas that do not yet exist in the domain package
// (rsvpReminderDaysBefore, rsvpReminderTime, remindersChannelId, timezone on
// UpdateTeamSettingsRequest and TeamSettingsInfo; member_group_id and
// discord_role_id on EventStartedEvent and RsvpReminderEvent).
// They will FAIL to compile / run until the developer implements the domain task.

import { describe, expect, it } from '@effect/vitest';
import { Option, Schema } from 'effect';
import * as TeamSettingsApi from '~/api/TeamSettingsApi.js';
import * as EventRpcEvents from '~/rpc/event/EventRpcEvents.js';

// ---------------------------------------------------------------------------
// UpdateTeamSettingsRequest — rsvpReminderTime
// ---------------------------------------------------------------------------

describe('UpdateTeamSettingsRequest — rsvpReminderTime validation', () => {
  it('accepts a valid time "18:00"', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderTime: '18:00',
    });
    // Option.some because the field is present
    expect(Option.isSome(result.rsvpReminderTime)).toBe(true);
    if (Option.isSome(result.rsvpReminderTime)) {
      expect(result.rsvpReminderTime.value).toBe('18:00');
    }
  });

  it('accepts "00:00"', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderTime: '00:00',
    });
    expect(Option.isSome(result.rsvpReminderTime)).toBe(true);
  });

  it('accepts "23:54" (latest valid time before midnight wrap window)', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderTime: '23:54',
    });
    expect(Option.isSome(result.rsvpReminderTime)).toBe(true);
  });

  it('rejects "23:55" (would cause BETWEEN predicate to wrap past midnight)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: '23:55',
      }),
    ).toThrow();
  });

  it('rejects "23:59" (midnight wrap)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: '23:59',
      }),
    ).toThrow();
  });

  it('rejects "24:00" (hour out of range)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: '24:00',
      }),
    ).toThrow();
  });

  it('rejects "5:00" (no leading zero)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: '5:00',
      }),
    ).toThrow();
  });

  it('rejects "abc"', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: 'abc',
      }),
    ).toThrow();
  });

  it('rejects "18:60" (minutes out of range)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderTime: '18:60',
      }),
    ).toThrow();
  });

  it('omitting rsvpReminderTime yields None', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
    });
    expect(Option.isNone(result.rsvpReminderTime)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UpdateTeamSettingsRequest — rsvpRemindersEnabled
// ---------------------------------------------------------------------------

describe('UpdateTeamSettingsRequest — rsvpRemindersEnabled', () => {
  it('accepts true', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpRemindersEnabled: true,
    });
    expect(Option.isSome(result.rsvpRemindersEnabled)).toBe(true);
    if (Option.isSome(result.rsvpRemindersEnabled)) {
      expect(result.rsvpRemindersEnabled.value).toBe(true);
    }
  });

  it('accepts false', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpRemindersEnabled: false,
    });
    expect(Option.isSome(result.rsvpRemindersEnabled)).toBe(true);
    if (Option.isSome(result.rsvpRemindersEnabled)) {
      expect(result.rsvpRemindersEnabled.value).toBe(false);
    }
  });

  it('omitting rsvpRemindersEnabled yields None', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
    });
    expect(Option.isNone(result.rsvpRemindersEnabled)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UpdateTeamSettingsRequest — rsvpReminderDaysBefore
// ---------------------------------------------------------------------------

describe('UpdateTeamSettingsRequest — rsvpReminderDaysBefore validation', () => {
  it('accepts 0 (minimum boundary)', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderDaysBefore: 0,
    });
    expect(Option.isSome(result.rsvpReminderDaysBefore)).toBe(true);
    if (Option.isSome(result.rsvpReminderDaysBefore)) {
      expect(result.rsvpReminderDaysBefore.value).toBe(0);
    }
  });

  it('accepts 14 (maximum boundary)', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderDaysBefore: 14,
    });
    expect(Option.isSome(result.rsvpReminderDaysBefore)).toBe(true);
    if (Option.isSome(result.rsvpReminderDaysBefore)) {
      expect(result.rsvpReminderDaysBefore.value).toBe(14);
    }
  });

  it('accepts 7 (mid-range)', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      rsvpReminderDaysBefore: 7,
    });
    expect(Option.isSome(result.rsvpReminderDaysBefore)).toBe(true);
  });

  it('rejects -1 (below minimum)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderDaysBefore: -1,
      }),
    ).toThrow();
  });

  it('rejects 15 (above maximum)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        rsvpReminderDaysBefore: 15,
      }),
    ).toThrow();
  });

  it('omitting rsvpReminderDaysBefore yields None', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
    });
    expect(Option.isNone(result.rsvpReminderDaysBefore)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// UpdateTeamSettingsRequest — timezone validation
// ---------------------------------------------------------------------------

describe('UpdateTeamSettingsRequest — timezone validation', () => {
  it('accepts "Europe/Prague"', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      timezone: 'Europe/Prague',
    });
    expect(Option.isSome(result.timezone)).toBe(true);
    if (Option.isSome(result.timezone)) {
      expect(result.timezone.value).toBe('Europe/Prague');
    }
  });

  it('accepts "America/New_York"', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      timezone: 'America/New_York',
    });
    expect(Option.isSome(result.timezone)).toBe(true);
  });

  it('accepts "UTC"', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
      timezone: 'UTC',
    });
    expect(Option.isSome(result.timezone)).toBe(true);
  });

  it('rejects "Foo/Bar" (not a valid IANA timezone)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        timezone: 'Foo/Bar',
      }),
    ).toThrow();
  });

  it('rejects empty string ""', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        timezone: '',
      }),
    ).toThrow();
  });

  it('rejects "Europe Prague" (space not slash)', () => {
    expect(() =>
      Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
        eventHorizonDays: 30,
        timezone: 'Europe Prague',
      }),
    ).toThrow();
  });

  it('omitting timezone yields None', () => {
    const result = Schema.decodeUnknownSync(TeamSettingsApi.UpdateTeamSettingsRequest)({
      eventHorizonDays: 30,
    });
    expect(Option.isNone(result.timezone)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// EventStartedEvent — round-trips with new optional fields
// ---------------------------------------------------------------------------

describe('EventStartedEvent — round-trip with new fields', () => {
  const baseFields = {
    _tag: 'event_started',
    id: 'evt-sync-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    guild_id: '123456789012345678',
    event_id: 'e0000000-0000-0000-0000-000000000001',
    title: 'Saturday Match',
    start_at: '2026-05-01T16:00:00.000Z',
    event_type: 'match',
  };

  it('round-trips with all Option fields populated', () => {
    const input = {
      ...baseFields,
      end_at: '2026-05-01T18:00:00.000Z',
      location: 'Stadium',
      location_url: 'https://maps.google.com/stadium',
      member_group_id: '00000000-0000-0000-0000-000000000010',
      discord_channel_id: '987654321098765432',
      discord_role_id: '111111111111111111',
      image_url: 'https://example.com/cover.png',
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.EventStartedEvent)(input);
    expect(Option.isSome(result.end_at)).toBe(true);
    expect(Option.isSome(result.location)).toBe(true);
    expect(Option.isSome(result.location_url)).toBe(true);
    expect(Option.isSome(result.member_group_id)).toBe(true);
    expect(Option.isSome(result.discord_channel_id)).toBe(true);
    expect(Option.isSome(result.discord_role_id)).toBe(true);
    expect(Option.isSome(result.image_url)).toBe(true);
  });

  it('round-trips with all Option fields None (null in payload)', () => {
    const input = {
      ...baseFields,
      end_at: null,
      location: null,
      location_url: null,
      member_group_id: null,
      discord_channel_id: null,
      discord_role_id: null,
      image_url: null,
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.EventStartedEvent)(input);
    expect(Option.isNone(result.end_at)).toBe(true);
    expect(Option.isNone(result.location)).toBe(true);
    expect(Option.isNone(result.location_url)).toBe(true);
    expect(Option.isNone(result.member_group_id)).toBe(true);
    expect(Option.isNone(result.discord_channel_id)).toBe(true);
    expect(Option.isNone(result.discord_role_id)).toBe(true);
    expect(Option.isNone(result.image_url)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// RsvpReminderEvent — round-trips with member_group_id and discord_role_id
// ---------------------------------------------------------------------------

describe('RsvpReminderEvent — round-trip with new fields', () => {
  const baseFields = {
    _tag: 'rsvp_reminder',
    id: 'rsvp-sync-1',
    team_id: '00000000-0000-0000-0000-000000000001',
    guild_id: '123456789012345678',
    event_id: 'e0000000-0000-0000-0000-000000000002',
    title: 'Training Reminder',
    start_at: '2026-05-02T14:00:00.000Z',
    discord_channel_id: null,
  };

  it('round-trips with member_group_id Some and discord_role_id Some', () => {
    const input = {
      ...baseFields,
      member_group_id: '00000000-0000-0000-0000-000000000020',
      discord_role_id: '222222222222222222',
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.RsvpReminderEvent)(input);
    expect(Option.isSome(result.member_group_id)).toBe(true);
    expect(Option.isSome(result.discord_role_id)).toBe(true);
  });

  it('round-trips with member_group_id None', () => {
    const input = {
      ...baseFields,
      member_group_id: null,
      discord_role_id: null,
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.RsvpReminderEvent)(input);
    expect(Option.isNone(result.member_group_id)).toBe(true);
    expect(Option.isNone(result.discord_role_id)).toBe(true);
  });

  it('round-trips with member_group_id None and discord_role_id Some', () => {
    const input = {
      ...baseFields,
      member_group_id: null,
      discord_role_id: '333333333333333333',
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.RsvpReminderEvent)(input);
    expect(Option.isNone(result.member_group_id)).toBe(true);
    expect(Option.isSome(result.discord_role_id)).toBe(true);
  });

  it('round-trips with member_group_id Some and discord_role_id None', () => {
    const input = {
      ...baseFields,
      member_group_id: '00000000-0000-0000-0000-000000000021',
      discord_role_id: null,
    };
    const result = Schema.decodeUnknownSync(EventRpcEvents.RsvpReminderEvent)(input);
    expect(Option.isSome(result.member_group_id)).toBe(true);
    expect(Option.isNone(result.discord_role_id)).toBe(true);
  });
});
