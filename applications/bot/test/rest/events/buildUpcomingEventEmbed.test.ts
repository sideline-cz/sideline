import { EventRpcModels } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildUpcomingEventEmbed } from '~/rest/events/buildUpcomingEventEmbed.js';

const FUTURE_START = DateTime.makeUnsafe('2099-06-01T18:00:00Z');

const makeEntry = (
  overrides: Partial<
    ConstructorParameters<typeof EventRpcModels.UpcomingEventForUserEntry>[0]
  > = {},
): EventRpcModels.UpcomingEventForUserEntry =>
  new EventRpcModels.UpcomingEventForUserEntry({
    event_id: 'event-1',
    team_id: 'team-1',
    title: 'Training Session',
    description: Option.none(),
    image_url: Option.none(),
    start_at: FUTURE_START,
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'training',
    yes_count: 0,
    no_count: 0,
    maybe_count: 0,
    my_response: Option.none(),
    my_response_actual: Option.none(),
    my_message: Option.none(),
    all_day: false,
    ...overrides,
  });

const makeAttendee = (name: string): EventRpcModels.RsvpAttendeeEntry =>
  new EventRpcModels.RsvpAttendeeEntry({
    discord_id: Option.none(),
    name: Option.some(name),
    nickname: Option.none(),
    username: Option.none(),
    display_name: Option.none(),
    response: 'yes',
    message: Option.none(),
  });

const baseParams = {
  locale: 'en' as const,
  yesAttendees: [] as ReadonlyArray<EventRpcModels.RsvpAttendeeEntry>,
};

describe('buildUpcomingEventEmbed', () => {
  describe('embed title', () => {
    it('uses entry title as embed title', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      expect(embeds[0].title).toBe('Training Session');
    });

    it('has no footer', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      expect(embeds[0].footer).toBeUndefined();
    });
  });

  describe('embed color', () => {
    it('uses training color when not started', () => {
      const { embeds } = buildUpcomingEventEmbed({
        ...baseParams,
        entry: makeEntry({ event_type: 'training' }),
      });
      expect(embeds[0].color).toBe(0x57f287);
    });

    it('uses match color when not started', () => {
      const { embeds } = buildUpcomingEventEmbed({
        ...baseParams,
        entry: makeEntry({ event_type: 'match' }),
      });
      expect(embeds[0].color).toBe(0xed4245);
    });

    it('uses default color for unknown event type', () => {
      const { embeds } = buildUpcomingEventEmbed({
        ...baseParams,
        entry: makeEntry({ event_type: 'unknown_type' }),
      });
      expect(embeds[0].color).toBe(0x99aab5);
    });
  });

  describe('description', () => {
    it('includes description text when present', () => {
      const entry = makeEntry({ description: Option.some('Bring your boots') });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect(embeds[0].description).toContain('Bring your boots');
    });

    it('does not include description when absent', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      expect(embeds[0].description).not.toContain('Bring your boots');
    });
  });

  describe('fields', () => {
    it('includes a when field', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const fields = embeds[0].fields ?? [];
      const whenField = fields.find(
        (f) => f.name.toLowerCase().includes('when') || f.name.toLowerCase().includes('date'),
      );
      expect(whenField).toBeDefined();
    });

    it('includes location field when location is set', () => {
      const entry = makeEntry({ location: Option.some('Sports Hall') });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const fields = embeds[0].fields ?? [];
      const whereField = fields.find((f) => f.value === 'Sports Hall');
      expect(whereField).toBeDefined();
    });

    it('does not include location field when location is absent', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const fields = embeds[0].fields ?? [];
      const hasLocation = fields.some((f) => f.value === 'Sports Hall');
      expect(hasLocation).toBe(false);
    });

    it('includes rsvp counts field with yes/no/maybe values', () => {
      const entry = makeEntry({ yes_count: 5, no_count: 2, maybe_count: 1 });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const allValues = (embeds[0].fields ?? []).map((f) => f.value).join(' ');
      expect(allValues).toContain('5');
      expect(allValues).toContain('2');
      expect(allValues).toContain('1');
    });

    it('includes your rsvp field', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const fields = embeds[0].fields ?? [];
      // The "your rsvp" field should exist
      expect(fields.length).toBeGreaterThanOrEqual(3);
    });

    it('lists yes-attendee names in a going field when present', () => {
      const entry = makeEntry({ yes_count: 2 });
      const { embeds } = buildUpcomingEventEmbed({
        ...baseParams,
        entry,
        yesAttendees: [makeAttendee('Alice'), makeAttendee('Bob')],
      });
      const allText = (embeds[0].fields ?? []).map((f) => f.value).join(' ');
      expect(allText).toContain('Alice');
      expect(allText).toContain('Bob');
    });

    it('shows "+N more" when yes_count exceeds listed attendees', () => {
      const entry = makeEntry({ yes_count: 5 });
      const { embeds } = buildUpcomingEventEmbed({
        ...baseParams,
        entry,
        yesAttendees: [makeAttendee('Alice'), makeAttendee('Bob')],
      });
      const allText = (embeds[0].fields ?? []).map((f) => f.value).join(' ');
      expect(allText).toContain('+3 more');
    });

    it('omits the going field when there are no yes attendees', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const goingField = (embeds[0].fields ?? []).find((f) => f.name.includes('Going'));
      expect(goingField).toBeUndefined();
    });
  });

  describe('when field with end_at', () => {
    it('shows only start timestamp when end_at is absent', () => {
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const fields = embeds[0].fields ?? [];
      // First field is "when", should not contain " — "
      expect(fields[0].value).not.toContain(' — ');
    });

    it('shows start and end timestamp separated by dash when end_at is set', () => {
      const endAt = DateTime.makeUnsafe('2099-06-01T20:00:00Z');
      const entry = makeEntry({ end_at: Option.some(endAt) });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const fields = embeds[0].fields ?? [];
      expect(fields[0].value).toContain(' — ');
    });
  });

  describe('RSVP buttons', () => {
    it('returns two component rows (rsvp + attendees) when user has no response', () => {
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      expect(components).toHaveLength(2);
    });

    it('rsvp row has three buttons (yes/no/maybe)', () => {
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      expect(components[0].components).toHaveLength(3);
    });

    it('includes an attendees button targeting this event on the second row', () => {
      const entry = makeEntry({ event_id: 'ev-42', team_id: 'tm-7' });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const attendeesBtn = (components[1].components as ReadonlyArray<{ custom_id: string }>).find(
        (b) => b.custom_id.startsWith('attendees:'),
      );
      expect(attendeesBtn?.custom_id).toBe('attendees:tm-7:ev-42:0');
    });

    it('rsvp buttons are always enabled', () => {
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry: makeEntry() });
      const rsvpButtons = components[0].components as ReadonlyArray<{ disabled?: boolean }>;
      expect(rsvpButtons.every((b) => !b.disabled)).toBe(true);
    });

    it('yes button uses success style when my_response is yes', () => {
      const entry = makeEntry({ my_response: Option.some('yes') });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const yesButton = components[0].components[0] as { style: number };
      expect(yesButton.style).toBe(3); // success/green
    });

    it('no button uses danger style when my_response is no', () => {
      const entry = makeEntry({ my_response: Option.some('no') });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const noButton = components[0].components[1] as { style: number };
      expect(noButton.style).toBe(4); // danger/red
    });

    it('maybe button uses primary style when my_response is maybe', () => {
      const entry = makeEntry({ my_response: Option.some('maybe') });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const maybeButton = components[0].components[2] as { style: number };
      expect(maybeButton.style).toBe(1); // primary/blurple
    });

    it('all rsvp buttons use secondary style when my_response is none', () => {
      const entry = makeEntry({ my_response: Option.none() });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const rsvpButtons = components[0].components as ReadonlyArray<{ style: number }>;
      expect(rsvpButtons.every((b) => b.style === 2)).toBe(true);
    });

    it('rsvp button custom_ids encode event_id, team_id, and response (no offset)', () => {
      const entry = makeEntry({ event_id: 'ev-42', team_id: 'tm-7' });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const [yesBtn, noBtn, maybeBtn] = components[0].components as ReadonlyArray<{
        custom_id: string;
      }>;
      expect(yesBtn.custom_id).toBe('upcoming-rsvp:ev-42:tm-7:yes');
      expect(noBtn.custom_id).toBe('upcoming-rsvp:ev-42:tm-7:no');
      // coming_later always opens the required-comment modal instead of an
      // instant upcoming-rsvp:...:maybe submit — see the dedicated
      // "message action row" describe block below for full coverage.
      expect(maybeBtn.custom_id).toBe('u-add-msg:tm-7:ev-42:coming_later');
    });
  });

  describe('your rsvp value', () => {
    it('shows "yes" state message when my_response is yes', () => {
      const entry = makeEntry({ my_response: Option.some('yes') });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const yourRsvpField = (embeds[0].fields ?? []).find((f) =>
        f.name.toLowerCase().includes('rsvp'),
      );
      expect(yourRsvpField).toBeDefined();
    });

    it('includes message text when my_message is set', () => {
      const entry = makeEntry({
        my_response: Option.some('yes'),
        my_message: Option.some('Cannot wait!'),
      });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const allText = (embeds[0].fields ?? []).map((f) => f.value).join(' ');
      expect(allText).toContain('Cannot wait!');
    });
  });

  describe('message action row', () => {
    it('second row holds only the attendees button when my_response is none', () => {
      const entry = makeEntry({ my_response: Option.none() });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect(components).toHaveLength(2);
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      expect(secondRow).toHaveLength(1);
      expect(secondRow[0].custom_id.startsWith('attendees:')).toBe(true);
    });

    it('keeps two rows when my_response is some', () => {
      const entry = makeEntry({ my_response: Option.some('yes') });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect(components).toHaveLength(2);
    });

    it('appends add message button after attendees when user has no message', () => {
      const entry = makeEntry({ my_response: Option.some('yes'), my_message: Option.none() });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      expect(secondRow).toHaveLength(2);
      expect(secondRow[0].custom_id.startsWith('attendees:')).toBe(true);
      expect(secondRow[1].custom_id).toBe('u-add-msg:team-1:event-1:yes');
    });

    it('appends edit and clear buttons after attendees when user has a message', () => {
      const entry = makeEntry({
        my_response: Option.some('yes'),
        my_message: Option.some('Ready!'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      expect(secondRow).toHaveLength(3);
      expect(secondRow[0].custom_id.startsWith('attendees:')).toBe(true);
      expect(secondRow[1].custom_id).toBe('u-add-msg:team-1:event-1:yes');
      expect(secondRow[2].custom_id).toBe('u-clear-msg:team-1:event-1:yes');
    });

    // -----------------------------------------------------------------------
    // coming_later — row 1's third RSVP button ("Maybe") now routes to the
    // add-message modal for the new coming_later response (coming_later
    // always requires a non-empty comment, so it can no longer be an
    // instant-submit `upcoming-rsvp:...:maybe` button). Unlike row 2's
    // edit/clear pairing (buildMessageActionRow-equivalent), this row-1 slot
    // never has a "clear message" variant — it is always the single
    // modal-trigger button, regardless of the user's current my_response /
    // my_message state.
    // -----------------------------------------------------------------------

    it('third rsvp button routes to u-add-msg:...:coming_later, not an instant upcoming-rsvp:...:maybe submit', () => {
      const entry = makeEntry({ event_id: 'ev-42', team_id: 'tm-7' });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const [, , thirdBtn] = components[0].components as ReadonlyArray<{ custom_id: string }>;
      expect(thirdBtn.custom_id).toBe('u-add-msg:tm-7:ev-42:coming_later');
      expect(thirdBtn.custom_id).not.toBe('upcoming-rsvp:ev-42:tm-7:maybe');
    });

    it('row 1 still has exactly 3 buttons regardless of my_response/my_message state (no clear-message variant for coming_later)', () => {
      const entry = makeEntry({
        event_id: 'ev-42',
        team_id: 'tm-7',
        my_response: Option.some('maybe'),
        my_message: Option.some('Already responded with a note'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect(components[0].components).toHaveLength(3);
      const [, , thirdBtn] = components[0].components as ReadonlyArray<{ custom_id: string }>;
      expect(thirdBtn.custom_id).toBe('u-add-msg:tm-7:ev-42:coming_later');
    });

    it('encodes team_id and event_id in message-button custom_ids', () => {
      const entry = makeEntry({
        event_id: 'ev-99',
        team_id: 'tm-5',
        my_response: Option.some('maybe'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      expect(secondRow[1].custom_id).toBe('u-add-msg:tm-5:ev-99:maybe');
    });

    it('add/edit button uses secondary style (2)', () => {
      const entry = makeEntry({ my_response: Option.some('yes'), my_message: Option.none() });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const addBtn = components[1].components[1] as { style: number };
      expect(addBtn.style).toBe(2);
    });

    it('clear button uses danger style (4)', () => {
      const entry = makeEntry({
        my_response: Option.some('yes'),
        my_message: Option.some('Here!'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const clearBtn = components[1].components[2] as { style: number };
      expect(clearBtn.style).toBe(4);
    });

    // -----------------------------------------------------------------------
    // my_response_actual — row 2's edit/clear buttons must be built from the
    // TRUE (unprojected) response, not the legacy-projected `my_response`
    // (which downgrades `coming_later` to `maybe`). Building them from the
    // projected value would let "Clear message" silently rewrite a stored
    // `coming_later` RSVP to `maybe` and bypass the mandatory-comment guard.
    // -----------------------------------------------------------------------

    it('edit button custom_id encodes the true coming_later response, not the projected maybe', () => {
      const entry = makeEntry({
        event_id: 'ev-42',
        team_id: 'tm-7',
        my_response: Option.some('maybe'),
        my_response_actual: Option.some('coming_later'),
        my_message: Option.some('Running late'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      const editBtn = secondRow.find((b) => b.custom_id.startsWith('u-add-msg:'));
      expect(editBtn?.custom_id).toBe('u-add-msg:tm-7:ev-42:coming_later');
    });

    it('does not render a clear-message button when the true response is coming_later', () => {
      const entry = makeEntry({
        event_id: 'ev-42',
        team_id: 'tm-7',
        my_response: Option.some('maybe'),
        my_response_actual: Option.some('coming_later'),
        my_message: Option.some('Running late'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      expect(secondRow.some((b) => b.custom_id.startsWith('u-clear-msg:'))).toBe(false);
    });

    it('still renders the clear-message button when the true response is a legacy maybe', () => {
      const entry = makeEntry({
        event_id: 'ev-42',
        team_id: 'tm-7',
        my_response: Option.some('maybe'),
        my_response_actual: Option.some('maybe'),
        my_message: Option.some('Not sure yet'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      const clearBtn = secondRow.find((b) => b.custom_id.startsWith('u-clear-msg:'));
      expect(clearBtn?.custom_id).toBe('u-clear-msg:tm-7:ev-42:maybe');
    });

    it('falls back to the legacy my_response when my_response_actual is absent (rolling-deploy safety)', () => {
      const entry = makeEntry({
        event_id: 'ev-42',
        team_id: 'tm-7',
        my_response: Option.some('yes'),
        my_response_actual: Option.none(),
        my_message: Option.some('See you there'),
      });
      const { components } = buildUpcomingEventEmbed({ ...baseParams, entry });
      const secondRow = components[1].components as ReadonlyArray<{ custom_id: string }>;
      const editBtn = secondRow.find((b) => b.custom_id.startsWith('u-add-msg:'));
      const clearBtn = secondRow.find((b) => b.custom_id.startsWith('u-clear-msg:'));
      expect(editBtn?.custom_id).toBe('u-add-msg:tm-7:ev-42:yes');
      expect(clearBtn?.custom_id).toBe('u-clear-msg:tm-7:ev-42:yes');
    });
  });

  // ---------------------------------------------------------------------------
  // Image URL / thumbnail tests
  // These tests will FAIL until the developer updates buildUpcomingEventEmbed to
  // accept image_url from the entry and set embeds[0].thumbnail when isSome.
  // ---------------------------------------------------------------------------

  describe('thumbnail (image_url)', () => {
    it('embeds[0] has no thumbnail when image_url is Option.none()', () => {
      const entry = makeEntry({ image_url: Option.none() });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect((embeds[0] as any).thumbnail).toBeUndefined();
    });

    it('embeds[0] has no image key when image_url is Option.none()', () => {
      const entry = makeEntry({ image_url: Option.none() });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect((embeds[0] as any).image).toBeUndefined();
    });

    it('embeds[0].thumbnail.url equals the image URL when image_url is Option.some()', () => {
      const entry = makeEntry({ image_url: Option.some('https://example.com/upcoming.png') });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect((embeds[0] as any).thumbnail).toEqual({ url: 'https://example.com/upcoming.png' });
    });

    it('embeds[0] has no image key (only thumbnail) when image_url is Option.some()', () => {
      const entry = makeEntry({ image_url: Option.some('https://example.com/upcoming.png') });
      const { embeds } = buildUpcomingEventEmbed({ ...baseParams, entry });
      expect((embeds[0] as any).image).toBeUndefined();
    });
  });
});
