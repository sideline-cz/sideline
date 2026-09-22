import { Discord as DomainDiscord, EventRpcModels } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildAttendeesEmbed } from '~/rest/events/buildAttendeesEmbed.js';

const makeAttendee = (opts: {
  discord_id?: Option.Option<string>;
  name?: Option.Option<string>;
  nickname?: Option.Option<string>;
  display_name?: Option.Option<string>;
  username?: Option.Option<string>;
  message?: Option.Option<string>;
  response?: 'yes' | 'no' | 'maybe' | 'coming_later';
}): EventRpcModels.RsvpAttendeeEntry =>
  new EventRpcModels.RsvpAttendeeEntry({
    discord_id: Option.map(opts.discord_id ?? Option.none(), DomainDiscord.Snowflake.makeUnsafe),
    name: opts.name ?? Option.none(),
    nickname: opts.nickname ?? Option.none(),
    display_name: opts.display_name ?? Option.none(),
    username: opts.username ?? Option.none(),
    response: opts.response ?? 'yes',
    message: opts.message ?? Option.none(),
  });

const baseOpts = {
  total: 1,
  offset: 0,
  limit: 10,
  teamId: 'team-1',
  eventId: 'event-1',
  locale: 'en' as const,
};

// Extract all text from a rendered embed to verify formatEntry output.
const collectFieldValues = (attendees: EventRpcModels.RsvpAttendeeEntry[]): string => {
  const { embeds } = buildAttendeesEmbed({
    ...baseOpts,
    attendees,
    total: attendees.length,
  });
  return (embeds[0].fields ?? []).map((f) => f.value).join('\n');
};

describe('buildAttendeesEmbed - formatEntry', () => {
  it('formats with name and mention as "**Alice** (<@123>)"', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.some('Alice'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Alice** (<@123>)');
  });

  it('formats with name, mention, and message', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.some('Alice'),
      message: Option.some('Hello'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Alice** (<@123>) — "Hello"');
  });

  it('formats with only discord_id as mention fallback', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.none(),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('<@123>');
  });

  it('formats with only name as "**Bob**"', () => {
    const attendee = makeAttendee({
      discord_id: Option.none(),
      name: Option.some('Bob'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Bob**');
    expect(text).not.toContain('<@');
  });

  it('formats with neither name nor discord_id as "Unknown"', () => {
    const attendee = makeAttendee({
      discord_id: Option.none(),
      name: Option.none(),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('Unknown');
  });

  it('formats with only name and message as "**Bob** — \\"msg\\""', () => {
    const attendee = makeAttendee({
      discord_id: Option.none(),
      name: Option.some('Bob'),
      message: Option.some('msg'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Bob** — "msg"');
  });

  it('falls back to bold nickname with mention when name is None but nickname is set', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.none(),
      nickname: Option.some('Server Nick'),
      username: Option.some('bob_discord'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Server Nick** (<@123>)');
    expect(text).not.toContain('bob_discord');
  });

  it('falls back to bold username with mention when name and nickname are None', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.none(),
      username: Option.some('bob_discord'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**bob_discord** (<@123>)');
  });

  it('falls back to bold username when name is None but username is set (no discord_id)', () => {
    const attendee = makeAttendee({
      discord_id: Option.none(),
      name: Option.none(),
      username: Option.some('bob_discord'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**bob_discord**');
    expect(text).not.toContain('<@');
  });

  it('falls back to bold display_name when name and nickname are None but display_name is set', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.none(),
      nickname: Option.none(),
      display_name: Option.some('Global Nick'),
      username: Option.some('bob_discord'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Global Nick** (<@123>)');
    expect(text).not.toContain('bob_discord');
  });

  it('prefers nickname over display_name when both are set', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('456'),
      name: Option.none(),
      nickname: Option.some('Server Nick'),
      display_name: Option.some('Global Nick'),
      username: Option.some('bob_discord'),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Server Nick** (<@456>)');
    expect(text).not.toContain('Global Nick');
    expect(text).not.toContain('bob_discord');
  });

  it('falls back to bold display_name with mention when name, nickname, and username are all None', () => {
    const attendee = makeAttendee({
      discord_id: Option.some('123'),
      name: Option.none(),
      nickname: Option.none(),
      display_name: Option.some('Global Nick'),
      username: Option.none(),
    });
    const text = collectFieldValues([attendee]);
    expect(text).toContain('**Global Nick** (<@123>)');
  });
});

// ---------------------------------------------------------------------------
// coming_later grouping and field order
//
// The wire projects a stored "coming_later" row down to response: 'maybe'
// (RsvpAttendeeEntry.response is restricted to 'yes'|'no'|'maybe' — see
// packages/domain/src/rpc/event/EventRpcModels.ts), so both a legacy `maybe`
// attendee and a converted `coming_later` attendee arrive here with the same
// response: 'maybe' literal and land in the same group. What changes is the
// FIELD ORDER: yes → coming_later(maybe) → no (previously yes → no → maybe).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// docs/plans/rsvp-maybe-restore.md — `maybe` becomes a first-class,
// distinct-from-coming_later response. The server-side coming_later -> maybe
// wire projection is removed, so `RsvpAttendeeEntry.response` now arrives as
// its true value and `buildAttendeesEmbed` must render FOUR sections in the
// canonical gradient order: yes -> coming_later -> maybe -> no.
// ---------------------------------------------------------------------------

describe('buildAttendeesEmbed — four sections in gradient order (yes -> coming_later -> maybe -> no)', () => {
  it('places sections in the order yes, coming_later, maybe, no — even when seeded out of order', () => {
    const yesAttendee = makeAttendee({ name: Option.some('Yes Person'), response: 'yes' });
    const noAttendee = makeAttendee({ name: Option.some('No Person'), response: 'no' });
    const maybeAttendee = makeAttendee({ name: Option.some('Maybe Person'), response: 'maybe' });
    const comingLaterAttendee = makeAttendee({
      name: Option.some('Later Person'),
      response: 'coming_later',
    });

    const { embeds } = buildAttendeesEmbed({
      ...baseOpts,
      attendees: [noAttendee, maybeAttendee, yesAttendee, comingLaterAttendee],
      total: 4,
    });

    const fields = embeds[0].fields ?? [];
    const yesIndex = fields.findIndex((f) => f.value.includes('Yes Person'));
    const comingLaterIndex = fields.findIndex((f) => f.value.includes('Later Person'));
    const maybeIndex = fields.findIndex((f) => f.value.includes('Maybe Person'));
    const noIndex = fields.findIndex((f) => f.value.includes('No Person'));

    expect(yesIndex).toBeGreaterThanOrEqual(0);
    expect(comingLaterIndex).toBeGreaterThanOrEqual(0);
    expect(maybeIndex).toBeGreaterThanOrEqual(0);
    expect(noIndex).toBeGreaterThanOrEqual(0);
    expect(yesIndex).toBeLessThan(comingLaterIndex);
    expect(comingLaterIndex).toBeLessThan(maybeIndex);
    expect(maybeIndex).toBeLessThan(noIndex);
  });

  // INVERTED (docs/plans/rsvp-maybe-restore.md): the projection that made a
  // legacy `maybe` and a converted `coming_later` arrive as the same literal
  // is removed. They must now land in DIFFERENT fields.
  it('a maybe attendee and a coming_later attendee land in DIFFERENT fields, not the same group', () => {
    const maybeAttendee = makeAttendee({ name: Option.some('Legacy'), response: 'maybe' });
    const comingLaterAttendee = makeAttendee({
      name: Option.some('Converted'),
      response: 'coming_later',
    });

    const { embeds } = buildAttendeesEmbed({
      ...baseOpts,
      attendees: [maybeAttendee, comingLaterAttendee],
      total: 2,
    });

    const fields = embeds[0].fields ?? [];
    const maybeField = fields.find((f) => f.value.includes('Legacy'));
    const comingLaterField = fields.find((f) => f.value.includes('Converted'));

    expect(maybeField).toBeDefined();
    expect(comingLaterField).toBeDefined();
    expect(maybeField).not.toBe(comingLaterField);
    expect(maybeField?.value).not.toContain('Converted');
    expect(comingLaterField?.value).not.toContain('Legacy');
  });

  it('an empty section (no attendees of that response) is omitted entirely', () => {
    const yesAttendee = makeAttendee({ name: Option.some('Yes Person'), response: 'yes' });
    const noAttendee = makeAttendee({ name: Option.some('No Person'), response: 'no' });

    const { embeds } = buildAttendeesEmbed({
      ...baseOpts,
      attendees: [yesAttendee, noAttendee],
      total: 2,
    });

    // Only two sections should be present — no empty coming_later/maybe fields.
    expect(embeds[0].fields).toHaveLength(2);
  });

  it('each rendered section carries its own count, independent of the other three', () => {
    const attendees = [
      makeAttendee({ name: Option.some('Y1'), response: 'yes' }),
      makeAttendee({ name: Option.some('Y2'), response: 'yes' }),
      makeAttendee({ name: Option.some('CL1'), response: 'coming_later' }),
      makeAttendee({ name: Option.some('M1'), response: 'maybe' }),
      makeAttendee({ name: Option.some('M2'), response: 'maybe' }),
      makeAttendee({ name: Option.some('M3'), response: 'maybe' }),
      makeAttendee({ name: Option.some('N1'), response: 'no' }),
    ];

    const { embeds } = buildAttendeesEmbed({ ...baseOpts, attendees, total: attendees.length });
    const fields = embeds[0].fields ?? [];

    const yesField = fields.find((f) => f.value.includes('Y1'));
    const comingLaterField = fields.find((f) => f.value.includes('CL1'));
    const maybeField = fields.find((f) => f.value.includes('M1'));
    const noField = fields.find((f) => f.value.includes('N1'));

    expect(yesField?.name).toContain('2');
    expect(comingLaterField?.name).toContain('1');
    expect(maybeField?.name).toContain('3');
    expect(noField?.name).toContain('1');
  });
});
