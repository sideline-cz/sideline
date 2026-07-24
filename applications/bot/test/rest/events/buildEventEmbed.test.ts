import { Discord as DomainDiscord, EventRpcModels } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildCancelledEmbed, buildEventEmbed } from '~/rest/events/buildEventEmbed.js';

const makeAttendee = (
  discord_id: Option.Option<string>,
  name: Option.Option<string>,
  username: Option.Option<string> = Option.none(),
  nickname: Option.Option<string> = Option.none(),
  display_name: Option.Option<string> = Option.none(),
): EventRpcModels.RsvpAttendeeEntry =>
  new EventRpcModels.RsvpAttendeeEntry({
    discord_id: Option.map(discord_id, DomainDiscord.Snowflake.makeUnsafe),
    name,
    nickname,
    display_name,
    username,
    response: 'yes',
    message: Option.none(),
  });

const makeCounts = (yesCount = 0, noCount = 0, maybeCount = 0, canRsvp = true) =>
  new EventRpcModels.RsvpCountsResult({ yesCount, noCount, maybeCount, canRsvp });

const START_AT = DateTime.makeUnsafe('2026-06-01T18:00:00Z');

const baseOpts = {
  teamId: 'team-1',
  eventId: 'event-1',
  title: 'Test Event',
  description: Option.none<string>(),
  imageUrl: Option.none<string>(),
  startAt: START_AT,
  endAt: Option.none<DateTime.Utc>(),
  location: Option.none<string>(),
  locationUrl: Option.none<string>(),
  eventType: 'training',
  locale: 'en' as const,
};

describe('buildEventEmbed', () => {
  describe('"Going" field', () => {
    it('shows bold names when name is available', () => {
      const attendee = makeAttendee(Option.some('123'), Option.some('Alice'));
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [attendee],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toContain('**Alice**');
    });

    it('renders "Unknown" when name is None and no username or nickname', () => {
      const attendee = makeAttendee(Option.some('456'), Option.none());
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [attendee],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toBe('Unknown');
    });

    it('uses comma-space separator between names', () => {
      const alice = makeAttendee(Option.some('111'), Option.some('Alice'));
      const bob = makeAttendee(Option.some('222'), Option.some('Bob'));
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(2, 0, 0),
        yesAttendees: [alice, bob],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toBe('**Alice**, **Bob**');
    });

    it('shows "+N more" suffix when yesCount > yesAttendees.length', () => {
      const alice = makeAttendee(Option.some('111'), Option.some('Alice'));
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(5, 0, 0),
        yesAttendees: [alice],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toContain('+4 more');
    });

    it('falls back to bold username when name is None but username is set', () => {
      const attendee = makeAttendee(Option.some('789'), Option.none(), Option.some('alice123'));
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [attendee],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toContain('**alice123**');
    });

    it('renders "Unknown" when name, username, and discord_id are all None', () => {
      const attendee = makeAttendee(Option.none(), Option.none());
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [attendee],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toBe('Unknown');
    });

    it('falls back to bold display_name when name and nickname are None but display_name is set', () => {
      const attendee = makeAttendee(
        Option.some('789'),
        Option.none(),
        Option.none(),
        Option.none(),
        Option.some('Global Nick'),
      );
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [attendee],
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeDefined();
      expect(goingField?.value).toContain('**Global Nick**');
    });

    it('is omitted when isStarted is true', () => {
      const alice = makeAttendee(Option.some('111'), Option.some('Alice'));
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        counts: makeCounts(1, 0, 0),
        yesAttendees: [alice],
        isStarted: true,
      });

      const fields = embeds[0].fields ?? [];
      const goingField = fields.find((f) => f.name.toLowerCase().includes('going'));
      expect(goingField).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Image URL / thumbnail tests
  // These tests will FAIL until the developer updates buildEventEmbed to
  // accept imageUrl and set embeds[0].thumbnail when Option.isSome.
  // ---------------------------------------------------------------------------

  describe('thumbnail (imageUrl)', () => {
    it('embeds[0] has no thumbnail when imageUrl is Option.none()', () => {
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        imageUrl: Option.none<string>(),
        counts: makeCounts(0, 0, 0),
        yesAttendees: [],
      });
      expect((embeds[0] as any).thumbnail).toBeUndefined();
    });

    it('embeds[0] has no image key when imageUrl is Option.none()', () => {
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        imageUrl: Option.none<string>(),
        counts: makeCounts(0, 0, 0),
        yesAttendees: [],
      });
      expect((embeds[0] as any).image).toBeUndefined();
    });

    it('embeds[0].thumbnail.url equals the image URL when imageUrl is Option.some()', () => {
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        imageUrl: Option.some('https://example.com/cover.png'),
        counts: makeCounts(0, 0, 0),
        yesAttendees: [],
      });
      expect((embeds[0] as any).thumbnail).toEqual({ url: 'https://example.com/cover.png' });
    });

    it('embeds[0] has no image key (only thumbnail) when imageUrl is Option.some()', () => {
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        imageUrl: Option.some('https://example.com/cover.png'),
        counts: makeCounts(0, 0, 0),
        yesAttendees: [],
      });
      expect((embeds[0] as any).image).toBeUndefined();
    });

    it('thumbnail is still set when isStarted is true and imageUrl is Some', () => {
      const { embeds } = buildEventEmbed({
        ...baseOpts,
        imageUrl: Option.some('https://example.com/started.png'),
        counts: makeCounts(0, 0, 0),
        yesAttendees: [],
        isStarted: true,
      });
      expect((embeds[0] as any).thumbnail).toEqual({ url: 'https://example.com/started.png' });
    });
  });
});

// ---------------------------------------------------------------------------
// RSVP buttons — the third button ("Maybe") becomes a modal-route trigger for
// the new "coming_later" response, since coming_later always requires a
// non-empty comment (it can no longer be an instant-submit button like
// yes/no).
// ---------------------------------------------------------------------------

describe('buildEventEmbed — RSVP buttons', () => {
  it('third RSVP button routes to the add-message modal for coming_later, not an instant rsvp:...:maybe submit', () => {
    const { components } = buildEventEmbed({
      ...baseOpts,
      counts: makeCounts(0, 0, 0, true),
      yesAttendees: [],
    });
    const rsvpRow = components[0].components as ReadonlyArray<{ custom_id: string }>;
    expect(rsvpRow).toHaveLength(4); // yes, no, coming_later-modal-trigger, attendees
    const thirdButton = rsvpRow[2];
    expect(thirdButton.custom_id).toBe(
      `rsvp-add-msg:${baseOpts.teamId}:${baseOpts.eventId}:coming_later`,
    );
    expect(thirdButton.custom_id).not.toBe(`rsvp:${baseOpts.teamId}:${baseOpts.eventId}:maybe`);
  });

  it('yes and no buttons remain instant-submit (unaffected by the coming_later modal route)', () => {
    const { components } = buildEventEmbed({
      ...baseOpts,
      counts: makeCounts(0, 0, 0, true),
      yesAttendees: [],
    });
    const rsvpRow = components[0].components as ReadonlyArray<{ custom_id: string }>;
    expect(rsvpRow[0].custom_id).toBe(`rsvp:${baseOpts.teamId}:${baseOpts.eventId}:yes`);
    expect(rsvpRow[1].custom_id).toBe(`rsvp:${baseOpts.teamId}:${baseOpts.eventId}:no`);
  });
});

describe('buildCancelledEmbed — thumbnail', () => {
  it('cancelled embed has no thumbnail regardless of title', () => {
    const { embeds } = buildCancelledEmbed('Cancelled Event', 'en');
    expect((embeds[0] as any).thumbnail).toBeUndefined();
  });

  it('cancelled embed has no image regardless of title', () => {
    const { embeds } = buildCancelledEmbed('Cancelled Event', 'en');
    expect((embeds[0] as any).image).toBeUndefined();
  });
});
