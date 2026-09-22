// Nastavitelná docházka (plan §10.1). `buildPersonalMessage` itself does not
// change (plan §7.3 — "No change"): Setting 1 (show_attendee_list) reaches it
// only through the `yesAttendees` argument callers already pass, and Setting 2
// (rsvp_reminder_dms) never reaches it at all. These tests pin both facts so a
// future diff that threads a reminder-preference flag into this file, or that
// stops the attendee toggle from affecting the hash, is caught immediately.

import { EventRpcModels } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';

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
    yes_count: 1,
    no_count: 0,
    maybe_count: 0,
    coming_later_count: 0,
    my_response: Option.none(),
    my_message: Option.none(),
    all_day: false,
    status: 'active',
    event_type_name: Option.none(),
    event_type_color: Option.none(),
    start_date: Option.none(),
    end_date: Option.none(),
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

describe('buildPersonalMessage — attendee toggle participates in the payload hash', () => {
  it('hash with yesAttendees: [] differs from hash with yesAttendees: [one attendee]', () => {
    const entry = makeEntry();
    const hidden = buildPersonalMessage({
      entry,
      yesAttendees: [],
      discordId: '510000000000000001' as any,
      locale: 'en',
    });
    const shown = buildPersonalMessage({
      entry,
      yesAttendees: [makeAttendee('Alice')],
      discordId: '510000000000000001' as any,
      locale: 'en',
    });

    expect(hidden.hash).not.toEqual(shown.hash);
  });
});

describe('buildPersonalMessage — Setting 2 (rsvp_reminder_dms) scope tripwire', () => {
  it('an unanswered entry still yields needsMentionEdit === true and editPayload.content === "<@id>"', () => {
    const entry = makeEntry({ my_response: Option.none() });
    const render = buildPersonalMessage({
      entry,
      yesAttendees: [],
      discordId: '510000000000000002' as any,
      locale: 'en',
    });

    expect(render.needsMentionEdit).toBe(true);
    expect(render.editPayload.content).toBe('<@510000000000000002>');
  });

  // This is deliberately a source-text assertion, not a behavioural one: Setting 2 is
  // the RSVP-reminder-DM opt-out (plan §2.1/§6.7), and it is scoped OUT of this file by
  // design (plan §7.3 — "Setting 2 does not touch this file"). If a future diff adds a
  // `rsvp_reminder_dms` (or similarly named reminder-preference) parameter here, that is
  // the design drifting from the plan, and this assertion is the guard that catches it —
  // deliberately reading the file's own source rather than re-deriving its behaviour.
  it('the file contains no reminder-preference input (no reference to rsvp_reminder_dms or a reminder param)', async () => {
    const fs = await import('node:fs/promises');
    const url = await import('node:url');
    const path = url.fileURLToPath(
      new URL('../../../src/rest/events/buildPersonalEventMessage.ts', import.meta.url),
    );
    const source = await fs.readFile(path, 'utf-8');
    expect(source).not.toMatch(/rsvp_reminder_dms|reminderDms|reminder_dms/i);
  });
});
