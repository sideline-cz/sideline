import { Discord as DiscordSchema, type EventRpcEvents, EventRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { handleChannelMoved } from '~/rcp/event/handleChannelMoved.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Snowflake helper
// ---------------------------------------------------------------------------

const sf = (n: number | string): DiscordSchema.Snowflake =>
  DiscordSchema.Snowflake.makeUnsafe(String(n).padStart(18, '0'));

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const SYNC_EVENT_ID = 'sync-channel-moved-1';
const NIL_EVENT_ID = '00000000-0000-0000-0000-000000000000';
const OLD_CHANNEL = sf('200000000000000001');
const NEW_CHANNEL = sf('200000000000000002');

// ---------------------------------------------------------------------------
// ChannelEventEntry factory (used by reorderChannelMessages mock)
// ---------------------------------------------------------------------------

let _entrySeq = 0;
const _makeChannelEventEntry = (eventId?: string): EventRpcModels.ChannelEventEntry => {
  _entrySeq++;
  return new EventRpcModels.ChannelEventEntry({
    event_id: eventId ?? `ch-entry-${_entrySeq}`,
    team_id: TEAM_ID,
    title: `Entry ${_entrySeq}`,
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2030-06-01T10:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'match',
    status: 'active',
    all_day: false,
    discord_message_id: sf(100_000 + _entrySeq),
  });
};

// Fake event IDs used across tests
const EV1 = 'event-id-0000000001';
const EV2 = 'event-id-0000000002';
const EV3 = 'event-id-0000000003';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<EventRpcEvents.EventChannelMovedEvent> = {},
): EventRpcEvents.EventChannelMovedEvent =>
  ({
    _tag: 'event_channel_moved' as const,
    id: SYNC_EVENT_ID,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: NIL_EVENT_ID as any,
    old_channel_id: Option.some(OLD_CHANNEL),
    new_channel_id: Option.some(NEW_CHANNEL),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Stub embed info
// ---------------------------------------------------------------------------

const makeEmbedInfo = (): EventRpcModels.EventEmbedInfo =>
  new EventRpcModels.EventEmbedInfo({
    title: 'Test Event',
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2030-01-01T10:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'match',
    all_day: false,
    status: 'active',
  });

// ---------------------------------------------------------------------------
// Tracking structures
// ---------------------------------------------------------------------------

interface Calls {
  repointChannelEvents: number;
  deleteMessage: Array<{ channelId: DiscordSchema.Snowflake; msgId: DiscordSchema.Snowflake }>;
  createMessage: Array<DiscordSchema.Snowflake>;
  saveDiscordMessageId: Array<{ eventId: string; channelId: DiscordSchema.Snowflake }>;
  getChannelEventsCalled: Array<DiscordSchema.Snowflake>;
  getUnpostedUpcomingByChannelCalled: Array<DiscordSchema.Snowflake>;
}

const freshCalls = (): Calls => ({
  repointChannelEvents: 0,
  deleteMessage: [],
  createMessage: [],
  saveDiscordMessageId: [],
  getChannelEventsCalled: [],
  getUnpostedUpcomingByChannelCalled: [],
});

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

/**
 * Build a SyncRpc Proxy layer. Provides fine-grained control over each RPC
 * method so tests can assert call patterns.
 *
 * - `moved`: rows returned by RepointChannelEvents (for step 3 deletes)
 * - `unpostedEventIds`: event IDs returned by GetUnpostedUpcomingByChannel (step 4 posts)
 * - `getEventEmbedInfo`: override per-event embed info (default: Some(makeEmbedInfo()))
 */
function makeSyncRpcLayer(opts: {
  moved: Array<{ event_id: string; old_message_id: Option.Option<DiscordSchema.Snowflake> }>;
  unpostedEventIds: ReadonlyArray<string>;
  channelEventsForNew?: Array<unknown>;
  channelEventsForOld?: Array<unknown>;
  getEventEmbedInfo?: (eventId: string) => Option.Option<EventRpcModels.EventEmbedInfo>;
  calls: Calls;
}): Layer.Layer<SyncRpc> {
  const {
    moved,
    unpostedEventIds,
    channelEventsForNew = [],
    channelEventsForOld = [],
    calls,
    getEventEmbedInfo = (_id: string) => Option.some(makeEmbedInfo()),
  } = opts;

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Event/RepointChannelEvents': (_args: any) => {
      calls.repointChannelEvents++;
      return Effect.succeed(moved.map((row) => new EventRpcModels.MovedEventRow(row as any)));
    },
    'Event/GetUnpostedUpcomingByChannel': (args: any) => {
      const chId = args.discord_channel_id as DiscordSchema.Snowflake;
      calls.getUnpostedUpcomingByChannelCalled.push(chId);
      return Effect.succeed(unpostedEventIds);
    },
    'Event/GetChannelEvents': (args: any) => {
      const chId = args.discord_channel_id as DiscordSchema.Snowflake;
      calls.getChannelEventsCalled.push(chId);
      if (chId === NEW_CHANNEL) return Effect.succeed(channelEventsForNew);
      if (chId === OLD_CHANNEL) return Effect.succeed(channelEventsForOld);
      return Effect.succeed([]);
    },
    'Event/GetEventEmbedInfo': (args: any) => {
      return Effect.succeed(getEventEmbedInfo(args.event_id));
    },
    'Event/GetRsvpCounts': () =>
      Effect.succeed({ yesCount: 0, noCount: 0, maybeCount: 0, canRsvp: true }),
    'Event/GetYesAttendeesForEmbed': () => Effect.succeed([]),
    'Event/GetChannelDivider': () => Effect.succeed(Option.none()),
    'Event/SaveDiscordMessageId': (args: any) => {
      calls.saveDiscordMessageId.push({
        eventId: args.event_id,
        channelId: args.discord_channel_id,
      });
      return Effect.void;
    },
  };

  return Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;
        return defaults[method] ?? (() => Effect.succeed(null));
      },
    }),
  );
}

/**
 * Build a DiscordREST Proxy layer. Records create/delete calls.
 */
function makeRestLayer(
  calls: Calls,
  opts: {
    createMessageResult?: (
      chId: DiscordSchema.Snowflake,
    ) => Effect.Effect<{ id: string }, any, any>;
    deleteMessageResult?: (
      chId: DiscordSchema.Snowflake,
      msgId: DiscordSchema.Snowflake,
    ) => Effect.Effect<any, any, any>;
  } = {},
): Layer.Layer<DiscordREST> {
  let msgCounter = 1_000_000;

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    getGuild: (_guildId: any) =>
      Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null }),
    createMessage: (chId: any, _payload: any) => {
      calls.createMessage.push(chId);
      if (opts.createMessageResult) return opts.createMessageResult(chId);
      msgCounter++;
      return Effect.succeed({ id: String(msgCounter).padStart(18, '0') });
    },
    deleteMessage: (chId: any, msgId: any) => {
      calls.deleteMessage.push({ channelId: chId, msgId });
      if (opts.deleteMessageResult) return opts.deleteMessageResult(chId, msgId);
      return Effect.succeed({});
    },
    updateMessage: () => Effect.succeed({}),
    listMessages: () => Effect.succeed([]),
  };

  return Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;
        return defaults[method] ?? (() => Effect.succeed(null));
      },
    }),
  );
}

const buildLayers = (
  syncRpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
): Layer.Layer<SyncRpc | DiscordREST | ChannelReorderSemaphore> =>
  Layer.mergeAll(syncRpcLayer, restLayer, ChannelReorderSemaphore.Live);

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST | ChannelReorderSemaphore>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ===========================================================================
// Tests
// ===========================================================================

describe('handleChannelMoved', () => {
  let calls: Calls;

  beforeEach(() => {
    calls = freshCalls();
  });

  // -------------------------------------------------------------------------
  // A1: Happy path — 3 moved events (old messages deleted) + 3 unposted events
  //     queried from GetUnpostedUpcomingByChannel → 3 createMessage(new) + 3 saves.
  //     reorderChannelMessages runs for both old and new channel.
  // -------------------------------------------------------------------------
  it('A1: happy path — 3 deletes from moved rows + 3 posts from unposted list + reorder both', async () => {
    const moved = [
      { event_id: EV1, old_message_id: Option.some(sf('300000000000000001')) },
      { event_id: EV2, old_message_id: Option.some(sf('300000000000000002')) },
      { event_id: EV3, old_message_id: Option.some(sf('300000000000000003')) },
    ];

    const rpcLayer = makeSyncRpcLayer({
      moved,
      unpostedEventIds: [EV1, EV2, EV3],
      calls,
    });
    const restLayer = makeRestLayer(calls);

    await run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer));

    expect(calls.repointChannelEvents, 'RepointChannelEvents called once').toBe(1);
    // Step 3: deletes of old messages from moved rows
    expect(calls.deleteMessage, '3 old messages deleted').toHaveLength(3);
    for (const del of calls.deleteMessage) {
      expect(del.channelId).toBe(OLD_CHANNEL);
    }
    // Step 4: posts from GetUnpostedUpcomingByChannel
    expect(
      calls.getUnpostedUpcomingByChannelCalled,
      'GetUnpostedUpcomingByChannel called for new channel',
    ).toContain(NEW_CHANNEL);
    expect(calls.createMessage, '3 new messages created').toHaveLength(3);
    for (const chId of calls.createMessage) {
      expect(chId).toBe(NEW_CHANNEL);
    }
    expect(calls.saveDiscordMessageId, '3 SaveDiscordMessageId calls').toHaveLength(3);
    // Step 5+6: reorderChannelMessages ran for both channels
    const channelsQueried = new Set(calls.getChannelEventsCalled);
    expect(channelsQueried.has(NEW_CHANNEL), 'new channel reordered').toBe(true);
    expect(channelsQueried.has(OLD_CHANNEL), 'old channel reordered').toBe(true);
  });

  // -------------------------------------------------------------------------
  // A2: Post-all — GetUnpostedUpcomingByChannel returns N > 10 event ids →
  //     handler posts ALL of them (no cap in handleChannelMoved; cap lives in
  //     reorderChannelMessages). Exactly N createMessage(new) + N saves.
  // -------------------------------------------------------------------------
  it('A2: post-all — 15 unposted events → exactly 15 createMessage + 15 saves (no cap in handler)', async () => {
    const eventIds = Array.from({ length: 15 }, (_, i) => `ev-postall-${i + 1}`);
    const moved = eventIds.map((event_id, i) => ({
      event_id,
      old_message_id: Option.some(sf(400_000_000_000_000_000 + i)),
    }));

    const rpcLayer = makeSyncRpcLayer({
      moved,
      unpostedEventIds: eventIds,
      calls,
    });
    const restLayer = makeRestLayer(calls);

    await run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer));

    // All 15 must be posted — handler does not cap
    expect(calls.saveDiscordMessageId, 'exactly 15 saves (handler posts all, no cap)').toHaveLength(
      15,
    );
    const savedIds = calls.saveDiscordMessageId.map((s) => s.eventId);
    expect(new Set(savedIds).size).toBe(15);
    expect(calls.createMessage, '15 createMessage calls').toHaveLength(15);
  });

  // -------------------------------------------------------------------------
  // A3: Skip on missing embed info — one event's GetEventEmbedInfo returns None
  //     → that event is not posted; others are.
  // -------------------------------------------------------------------------
  it('A3: skip on missing embed info — event with None embed is skipped, others posted', async () => {
    const moved = [
      { event_id: EV1, old_message_id: Option.some(sf('500000000000000001')) },
      { event_id: EV2, old_message_id: Option.some(sf('500000000000000002')) },
      { event_id: EV3, old_message_id: Option.some(sf('500000000000000003')) },
    ];

    const rpcLayer = makeSyncRpcLayer({
      moved,
      // EV1 is in the unposted list but has no embed info
      unpostedEventIds: [EV1, EV2, EV3],
      calls,
      getEventEmbedInfo: (eventId: string) => {
        if (eventId === EV1) return Option.none();
        return Option.some(makeEmbedInfo());
      },
    });
    const restLayer = makeRestLayer(calls);

    await run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer));

    // EV1 skipped, EV2 + EV3 posted
    expect(calls.createMessage, '2 creates (EV1 skipped due to missing embed)').toHaveLength(2);
    expect(calls.saveDiscordMessageId, '2 saves').toHaveLength(2);
    const savedIds = calls.saveDiscordMessageId.map((s) => s.eventId);
    expect(savedIds).not.toContain(EV1);
    expect(savedIds).toContain(EV2);
    expect(savedIds).toContain(EV3);
  });

  // -------------------------------------------------------------------------
  // A4: Unposted list is independent of moved rows — moved can be empty (all
  //     rows already repointed on a prior attempt) while GetUnpostedUpcomingByChannel
  //     still returns stuck events → they ARE posted.
  //     This is the crash-retry recovery regression guard.
  // -------------------------------------------------------------------------
  it('A4: crash-retry recovery — moved=[] but GetUnpostedUpcomingByChannel returns stuck events → events posted', async () => {
    // Simulate retry: RepointChannelEvents returns [] (already done on first attempt)
    // but the events are still unposted in the DB (bot crashed before posting them)
    const rpcLayer = makeSyncRpcLayer({
      moved: [],
      unpostedEventIds: [EV1, EV2],
      calls,
    });
    const restLayer = makeRestLayer(calls);

    await run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer));

    expect(calls.repointChannelEvents, 'RepointChannelEvents called once').toBe(1);
    // No old messages to delete (moved=[])
    expect(calls.deleteMessage, 'no deletes on retry').toHaveLength(0);
    // Unposted events ARE still posted
    expect(calls.createMessage, '2 createMessage on retry').toHaveLength(2);
    expect(calls.saveDiscordMessageId, '2 saves on retry').toHaveLength(2);
    const savedIds = calls.saveDiscordMessageId.map((s) => s.eventId);
    expect(savedIds).toContain(EV1);
    expect(savedIds).toContain(EV2);
  });

  // -------------------------------------------------------------------------
  // A5: Old message already gone — deleteMessage fails with ErrorResponse code 10008
  //     → swallowed; handler still resolves and still posts.
  // -------------------------------------------------------------------------
  it('A5: 10008 on delete is swallowed — handler resolves and still posts', async () => {
    const moved = [{ event_id: EV1, old_message_id: Option.some(sf('700000000000000001')) }];

    const rpcLayer = makeSyncRpcLayer({
      moved,
      unpostedEventIds: [EV1],
      calls,
    });
    const restLayer = makeRestLayer(calls, {
      deleteMessageResult: (_chId, _msgId) =>
        Effect.fail({
          _tag: 'ErrorResponse',
          data: { code: 10008, message: 'Unknown Message' },
        }),
    });

    await expect(
      run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer)),
    ).resolves.toBeUndefined();

    // Delete was attempted
    expect(calls.deleteMessage).toHaveLength(1);
    // Post to new channel still happened
    expect(calls.createMessage).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // A6: new_channel_id = None — repoint called, old messages deleted, NO createMessage,
  //     reorderChannelMessages(old) runs, no reorder(new).
  // -------------------------------------------------------------------------
  it('A6: new_channel_id=None — repoint, delete old, no createMessage, reorder old only', async () => {
    const moved = [
      { event_id: EV1, old_message_id: Option.some(sf('800000000000000001')) },
      { event_id: EV2, old_message_id: Option.some(sf('800000000000000002')) },
    ];

    const rpcLayer = makeSyncRpcLayer({
      moved,
      unpostedEventIds: [],
      calls,
    });
    const restLayer = makeRestLayer(calls);

    const event = makeEvent({ new_channel_id: Option.none() });

    await run(handleChannelMoved(event), buildLayers(rpcLayer, restLayer));

    expect(calls.repointChannelEvents).toBe(1);
    // Old messages deleted
    expect(calls.deleteMessage).toHaveLength(2);
    // No createMessage (new_channel is None)
    expect(calls.createMessage).toHaveLength(0);
    // GetUnpostedUpcomingByChannel NOT called (new_channel_id is None)
    expect(calls.getUnpostedUpcomingByChannelCalled).toHaveLength(0);
    // Old channel was reordered (GetChannelEvents called for OLD channel)
    expect(calls.getChannelEventsCalled.includes(OLD_CHANNEL), 'old reorder ran').toBe(true);
    // New channel was NOT reordered
    expect(calls.getChannelEventsCalled.includes(NEW_CHANNEL), 'no new reorder').toBe(false);
  });

  // -------------------------------------------------------------------------
  // A7: Embed info missing for one event in a mixed list — verifies the embed
  //     None path via GetEventEmbedInfo directly (same logic as A3 but checks
  //     saved IDs precisely).
  // -------------------------------------------------------------------------
  it('A7: embed info None → event skipped, no createMessage for that event', async () => {
    const moved = [
      { event_id: EV1, old_message_id: Option.some(sf('900000000000000001')) },
      { event_id: EV2, old_message_id: Option.some(sf('900000000000000002')) },
    ];

    const rpcLayer = makeSyncRpcLayer({
      moved,
      unpostedEventIds: [EV1, EV2],
      calls,
      // EV1 has no embed info → must be skipped
      getEventEmbedInfo: (eventId: string) => {
        if (eventId === EV1) return Option.none();
        return Option.some(makeEmbedInfo());
      },
    });
    const restLayer = makeRestLayer(calls);

    await run(handleChannelMoved(makeEvent()), buildLayers(rpcLayer, restLayer));

    // EV1 skipped, EV2 posted → exactly 1 create
    expect(calls.createMessage, 'EV1 skipped due to missing embed info').toHaveLength(1);
    const savedIds = calls.saveDiscordMessageId.map((s) => s.eventId);
    expect(savedIds).not.toContain(EV1);
    expect(savedIds).toContain(EV2);
  });
});
