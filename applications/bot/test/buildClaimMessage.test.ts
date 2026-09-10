import * as m from '@sideline/i18n/messages';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildClaimMessage, type ClaimedByEntry } from '~/rest/events/buildClaimMessage.js';

const locale = 'en' as const;

const baseOpts = {
  title: 'Tuesday Training',
  startAt: DateTime.makeUnsafe('2023-11-14T22:13:20.000Z'),
  endAt: Option.none<DateTime.Utc>(),
  description: Option.none<string>(),
  claimedBy: Option.none<ClaimedByEntry>(),
  eventStatus: 'active',
  teamId: 'team-1',
  eventId: 'event-1',
  locale,
  // PR 1 (all-day-discord-start-time-plan.md §5 PR 1 step 5): `allDay` is a new required
  // field on buildClaimMessage's opts. `false` here keeps every pre-existing test in this
  // file byte-for-byte unchanged (§7.4 case 4).
  allDay: false,
};

describe('buildClaimMessage — Where field with locationUrl', () => {
  it('renders plain location text when locationUrl is None', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.some('Main Field'),
      locationUrl: Option.none(),
    });
    const fields = embeds[0].fields ?? [];
    const whereField = fields.find((f) => f.name === m.bot_embed_where({}, { locale }));
    expect(whereField).toBeDefined();
    expect(whereField?.value).toBe('Main Field');
  });

  it('renders a markdown link when location and locationUrl are both Some', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.some('Main Field'),
      locationUrl: Option.some('https://maps.google.com/x'),
    });
    const fields = embeds[0].fields ?? [];
    const whereField = fields.find((f) => f.name === m.bot_embed_where({}, { locale }));
    expect(whereField).toBeDefined();
    expect(whereField?.value).toBe('[Main Field](<https://maps.google.com/x>)');
  });

  it('omits the Where field when location is None even if locationUrl is Some', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.some('https://x'),
    });
    const fields = embeds[0].fields ?? [];
    const whereField = fields.find((f) => f.name === m.bot_embed_where({}, { locale }));
    expect(whereField).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// New TDD tests for the updated claimedBy shape and formatNameWithMention rendering
// ---------------------------------------------------------------------------

describe('buildClaimMessage — Status field with new claimedBy shape', () => {
  it('renders Status field as **Name (<@id>)** when claimed with name + discord_id', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      claimedBy: Option.some({
        discord_id: Option.some('123456789'),
        name: Option.some('Alice'),
        nickname: Option.none(),
        display_name: Option.none(),
        username: Option.none(),
      }),
      eventStatus: 'active',
    });
    const fields = embeds[0].fields ?? [];
    const statusField = fields.find((f) => f.name === m.bot_claim_status_label({}, { locale }));
    expect(statusField).toBeDefined();
    expect(statusField?.value).not.toContain('****');
    expect(statusField?.value).toContain('**Alice**');
    expect(statusField?.value).toContain('<@123456789>');
  });

  it('renders unclaimed status when claimedBy is None', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      claimedBy: Option.none(),
      eventStatus: 'active',
    });
    const fields = embeds[0].fields ?? [];
    const statusField = fields.find((f) => f.name === m.bot_claim_status_label({}, { locale }));
    expect(statusField).toBeDefined();
    expect(statusField?.value).toBe(m.bot_claim_status_unclaimed({}, { locale }));
  });

  it('falls back to bare <@id> when only discord_id is present', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      claimedBy: Option.some({
        discord_id: Option.some('999'),
        name: Option.none(),
        nickname: Option.none(),
        display_name: Option.none(),
        username: Option.none(),
      }),
      eventStatus: 'active',
    });
    const fields = embeds[0].fields ?? [];
    const statusField = fields.find((f) => f.name === m.bot_claim_status_label({}, { locale }));
    expect(statusField).toBeDefined();
    expect(statusField?.value).not.toContain('****');
    expect(statusField?.value).toContain('<@999>');
    expect(statusField?.value).not.toContain('Unknown');
  });
});

// ---------------------------------------------------------------------------
// PR 1 §7.4 — all-day "When" field: date, not a fake noon clock time.
// Plan: all-day-discord-start-time-plan.md §7.4, builder tests for buildClaimMessage.
// ---------------------------------------------------------------------------
describe('buildClaimMessage — When field with allDay (PR 1)', () => {
  const ALL_DAY_MARKER = ` · ${m.bot_embed_all_day({}, { locale: 'en' })}`;
  const NOON_JUL_15 = DateTime.makeUnsafe('2026-07-15T12:00:00Z'); // 1784116800
  const NOON_JUL_17 = DateTime.makeUnsafe('2026-07-17T12:00:00Z'); // 1784289600

  it('allDay true, no end → When field is exactly <t:S:D> · All day', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      allDay: true,
      startAt: NOON_JUL_15,
      endAt: Option.none(),
    });
    const fields = embeds[0].fields ?? [];
    const whenField = fields.find((f) => f.name === m.bot_embed_when({}, { locale }));
    expect(whenField?.value).toBe(`<t:1784116800:D>${ALL_DAY_MARKER}`);
  });

  it('allDay true, multi-day → When field is exactly <t:S:D> — <t:E:D> · All day', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      allDay: true,
      startAt: NOON_JUL_15,
      endAt: Option.some(NOON_JUL_17),
    });
    const fields = embeds[0].fields ?? [];
    const whenField = fields.find((f) => f.name === m.bot_embed_when({}, { locale }));
    expect(whenField?.value).toBe(`<t:1784116800:D> — <t:1784289600:D>${ALL_DAY_MARKER}`);
  });

  it('allDay true → description still contains <t:S:R> (unchanged from today)', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      allDay: true,
      startAt: NOON_JUL_15,
      endAt: Option.none(),
    });
    expect(embeds[0].description).toContain('<t:1784116800:R>');
  });

  it('allDay false → all existing assertions unchanged, byte-for-byte', () => {
    const { embeds } = buildClaimMessage({
      ...baseOpts,
      location: Option.none(),
      locationUrl: Option.none(),
      allDay: false,
      startAt: NOON_JUL_15,
      endAt: Option.none(),
    });
    const fields = embeds[0].fields ?? [];
    const whenField = fields.find((f) => f.name === m.bot_embed_when({}, { locale }));
    expect(whenField?.value).toBe('<t:1784116800:f>');
  });
});
