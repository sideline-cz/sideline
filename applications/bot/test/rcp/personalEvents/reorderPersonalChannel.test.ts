// TDD mode — PR 4 of the all-day-Discord-start-time plan (§4.7/§7.7g of the
// test spec).
//
// `reorderPersonalChannel.ts`'s `MemberMessage` type and `desiredOrder`
// currently sort ONLY by `start_at` (descending) — the pre-PR-4 shape. PR 4
// extends `MemberMessage` with `all_day`/`local_date`, and rewrites
// `desiredOrder` to be the REVERSE of the canonical ascending day-grouped key
// `(local_date ASC, allDay-first, start_at ASC, id ASC)` — i.e.
// `(local_date DESC, allDay-LAST, start_at DESC, id DESC)` — so that on the
// (already-reversed) personal channel the all-day item for a given day ends
// up nearest the input box, at the bottom of that day's block.
//
// IMPORTANT, stated once so a reviewer does not misread these tests: under
// the v4 storage anchor (all-day events anchored to real team-local midnight,
// not a noon-UTC sentinel), a same-day all-day event's `start_at` is
// numerically the EARLIEST instant of its day by construction — so a plain
// `start_at`-only sort ALREADY places it correctly relative to same-day timed
// events, coincidentally producing the same order as the new day-grouped keyicing.
// Case 1 below is therefore primarily a WIRING/coverage test (the new fields
// thread through `MemberMessage` and `desiredOrder` at all, matching the
// plan's explicit spec) rather than a test that can fail only the OLD code —
// see case 3 for the one scenario that genuinely DISTINGUISHES old vs new
// behaviour: two all-day events sharing the exact same `start_at` (§4.4.3's
// pagination-tiebreaker hazard, applied here to the reorder's own stability)
// require the `id` tiebreaker or their relative order is undefined.

import type { EventRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { reorderPersonalChannel } from '~/rcp/personalEvents/reorderPersonalChannel.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const TEAM_ID = '00000000-0000-0000-0000-000000000001';
const GUILD_ID = '520000000000000001';
const MEMBER_ID = 'mbr-00000000-0000-0000-0000-000000000001';
const DISCORD_ID = '520000000000000011';
const PERSONAL_CHANNEL_ID = '520000000000000021';

type MockMessage = {
  event_id: string;
  personal_channel_id: string;
  discord_message_id: string;
  start_at: DateTime.Utc;
  all_day: boolean;
  local_date: string;
};

type MockEntry = Partial<EventRpcModels.UpcomingEventForUserEntry> & {
  event_id: string;
  title: string;
};

const makeEntry = (eventId: string, startAt: DateTime.Utc, allDay: boolean): MockEntry => ({
  event_id: eventId,
  team_id: TEAM_ID as any,
  title: `Event ${eventId}`,
  description: Option.none() as any,
  image_url: Option.none() as any,
  start_at: startAt,
  end_at: Option.none() as any,
  location: Option.none() as any,
  location_url: Option.none() as any,
  event_type: 'training' as any,
  yes_count: 0,
  no_count: 0,
  maybe_count: 0,
  my_response: Option.some('yes') as any,
  my_response_actual: Option.some('yes') as any,
  my_message: Option.none() as any,
  all_day: allDay,
  start_date: Option.none() as any,
  end_date: Option.none() as any,
});

const makeLayers = (messages: ReadonlyArray<MockMessage>, entries: ReadonlyArray<MockEntry>) => {
  const createMessageCalls: string[] = [];
  const deleteMessageCalls: string[] = [];

  const rpcLayer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (method === 'PersonalEvents/ListMessagesForMember') {
          return () => Effect.succeed(messages);
        }
        if (method === 'Guild/GetAllUpcomingEventsForUser') {
          return () => Effect.succeed({ events: entries, total: entries.length, team_id: TEAM_ID });
        }
        if (method === 'Event/GetYesAttendeesForEmbed') {
          return () => Effect.succeed([]);
        }
        if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
          return () => Effect.succeed(undefined);
        }
        if (method === 'PersonalEvents/DeletePersonalEventMessage') {
          return () => Effect.succeed(undefined);
        }
        return () => Effect.succeed(null);
      },
    }),
  );

  const restLayer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (prop === 'createMessage') {
          return (channelId: string, _payload: unknown) => {
            createMessageCalls.push(channelId === PERSONAL_CHANNEL_ID ? 'created' : channelId);
            return Effect.succeed({ id: `new-${createMessageCalls.length}` });
          };
        }
        if (prop === 'deleteMessage') {
          return (_channelId: string, messageId: string) => {
            deleteMessageCalls.push(messageId);
            return Effect.succeed(undefined);
          };
        }
        if (prop === 'updateMessage') {
          return () => Effect.succeed({});
        }
        return () => Effect.succeed(null);
      },
    }),
  );

  return { rpcLayer, restLayer, createMessageCalls, deleteMessageCalls };
};

const run = (
  effect: Effect.Effect<void, never, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(layers, ChannelReorderSemaphore.Live))));

describe('reorderPersonalChannel — PR 4 day-grouped ordering', () => {
  it('case 1: one all-day event and two timed events on the same local_date → recreated in [18:00, 10:00, all-day] order (all-day nearest the input box)', async () => {
    // Snowflakes deliberately assigned in the REVERSE of the expected desired
    // order, so `longestKeepablePrefix` finds no keepable prefix and every
    // message is recreated — the create-call SEQUENCE is then exactly the
    // array order `desiredOrder` produces.
    const eventAllDay = 'evt-allday';
    const event1000 = 'evt-1000';
    const event1800 = 'evt-1800';

    const messages: MockMessage[] = [
      {
        event_id: eventAllDay,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '100',
        start_at: DateTime.makeUnsafe('2026-07-14T22:00:00Z'), // local midnight 07-15 Prague
        all_day: true,
        local_date: '2026-07-15',
      },
      {
        event_id: event1000,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '200',
        start_at: DateTime.makeUnsafe('2026-07-15T08:00:00Z'), // 10:00 CEST
        all_day: false,
        local_date: '2026-07-15',
      },
      {
        event_id: event1800,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '300',
        start_at: DateTime.makeUnsafe('2026-07-15T16:00:00Z'), // 18:00 CEST
        all_day: false,
        local_date: '2026-07-15',
      },
    ];

    const entries = [
      makeEntry(eventAllDay, messages[0].start_at, true),
      makeEntry(event1000, messages[1].start_at, false),
      makeEntry(event1800, messages[2].start_at, false),
    ];

    const { rpcLayer, restLayer, deleteMessageCalls } = makeLayers(messages, entries);

    // Track create order via a dedicated counter layer (override createMessage
    // to record the event context isn't directly available to REST, so we
    // instead assert via the delete-then-create PAIRING: deletes happen in the
    // same order as `sorted`, immediately before each corresponding create).
    await run(
      reorderPersonalChannel({
        team_member_id: MEMBER_ID as any,
        discord_id: DISCORD_ID as any,
        guild_id: GUILD_ID as any,
        locale: 'en',
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // The delete sequence mirrors the desired create sequence (delete-then-
    // recreate per message, sequentially, concurrency 1) — asserting on it is
    // equivalent to asserting the create order, and ties each call back to a
    // specific message via its (now stale) discord_message_id.
    expect(deleteMessageCalls).toEqual(['300', '200', '100']);
  });

  it('case 2: events on different local_dates still sort latest-day-first, unchanged', async () => {
    const eventToday = 'evt-today';
    const eventTomorrow = 'evt-tomorrow';

    const messages: MockMessage[] = [
      {
        event_id: eventToday,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '100',
        start_at: DateTime.makeUnsafe('2026-07-15T16:00:00Z'),
        all_day: false,
        local_date: '2026-07-15',
      },
      {
        event_id: eventTomorrow,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '200',
        start_at: DateTime.makeUnsafe('2026-07-16T16:00:00Z'),
        all_day: false,
        local_date: '2026-07-16',
      },
    ];

    const entries = [
      makeEntry(eventToday, messages[0].start_at, false),
      makeEntry(eventTomorrow, messages[1].start_at, false),
    ];

    const { rpcLayer, restLayer, deleteMessageCalls } = makeLayers(messages, entries);

    await run(
      reorderPersonalChannel({
        team_member_id: MEMBER_ID as any,
        discord_id: DISCORD_ID as any,
        guild_id: GUILD_ID as any,
        locale: 'en',
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // The later day (tomorrow) still comes FIRST in the reversed personal
    // ordering (latest-day-first, unchanged from before PR 4) — the delete
    // (and therefore recreate) sequence starts with tomorrow's message.
    expect(deleteMessageCalls).toEqual(['200', '100']);
  });

  it('case 3: two all-day events with the IDENTICAL start_at are ordered deterministically by id (the pagination-tiebreaker hazard, §4.4.3)', async () => {
    const sameStart = DateTime.makeUnsafe('2026-07-14T22:00:00Z');
    const eventA = 'evt-aaaa';
    const eventB = 'evt-bbbb';

    const messages: MockMessage[] = [
      // Snowflakes deliberately assigned so the array is decreasing once
      // sorted into the expected [eventB, eventA] order (see below) — forcing
      // a full recreate, exactly like the other cases in this file.
      {
        event_id: eventB,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '300',
        start_at: sameStart,
        all_day: true,
        local_date: '2026-07-15',
      },
      {
        event_id: eventA,
        personal_channel_id: PERSONAL_CHANNEL_ID,
        discord_message_id: '150',
        start_at: sameStart,
        all_day: true,
        local_date: '2026-07-15',
      },
    ];

    const entries = [makeEntry(eventA, sameStart, true), makeEntry(eventB, sameStart, true)];

    const { rpcLayer, restLayer, deleteMessageCalls } = makeLayers(messages, entries);

    await run(
      reorderPersonalChannel({
        team_member_id: MEMBER_ID as any,
        discord_id: DISCORD_ID as any,
        guild_id: GUILD_ID as any,
        locale: 'en',
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // Every other sort column ties (same local_date, same all_day, same
    // start_at) — without the `id` tiebreaker the relative order is
    // undefined, and could repeat or drop rows across separate calls. The
    // reversed key sorts descending on id: 'evt-bbbb' > 'evt-aaaa', so
    // eventB (snowflake 300) is deleted/recreated before eventA (150).
    expect(deleteMessageCalls).toEqual(['300', '150']);
  });
});
