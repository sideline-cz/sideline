import { Discord as DomainDiscord, EventRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import {
  MAX_CHANNEL_EVENTS,
  reorderChannelMessages,
  sortEntriesForChannel,
} from '~/rcp/event/reorderChannelMessages.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Snowflake helpers
// ---------------------------------------------------------------------------

/** Convert a numeric-ish ID to a Discord.Snowflake branded string */
const sf = (n: number | string): DomainDiscord.Snowflake =>
  DomainDiscord.Snowflake.makeUnsafe(String(n).padStart(18, '0'));

/** Numeric value of a snowflake for ordering assertions */
const sfNum = (id: DomainDiscord.Snowflake): bigint => BigInt(id);

const CHANNEL_ID = sf('999000000000000001');

// ---------------------------------------------------------------------------
// MessageStore fixture
//
// An in-memory Map updated by REST mock calls. Tracks what is currently
// stored in the fictional Discord channel so we can assert ordering and content.
// ---------------------------------------------------------------------------

type MessageRecord =
  | { kind: 'event'; eventId: string; channelId: DomainDiscord.Snowflake }
  | { kind: 'divider'; channelId: DomainDiscord.Snowflake };

class MessageStore {
  private store = new Map<DomainDiscord.Snowflake, MessageRecord>();
  private counter = 100_000;

  /** Seed an existing message (id already known) */
  seed(id: DomainDiscord.Snowflake, record: MessageRecord): void {
    this.store.set(id, record);
  }

  /** Called by mock createMessage — returns the new snowflake */
  create(record: MessageRecord): DomainDiscord.Snowflake {
    this.counter++;
    const id = sf(this.counter);
    this.store.set(id, record);
    return id;
  }

  /** Called by mock deleteMessage */
  delete(id: DomainDiscord.Snowflake): void {
    this.store.delete(id);
  }

  /** Called by mock updateMessage — updates content of an existing message in place */
  update(id: DomainDiscord.Snowflake, patch: Partial<MessageRecord>): void {
    const existing = this.store.get(id);
    if (existing !== undefined) {
      this.store.set(id, { ...existing, ...patch } as MessageRecord);
    }
  }

  /** Return all message IDs for a channel, sorted numerically ascending */
  sortedIds(channelId: DomainDiscord.Snowflake): Array<DomainDiscord.Snowflake> {
    return [...this.store.entries()]
      .filter(([, r]) => r.channelId === channelId)
      .map(([id]) => id)
      .sort((a, b) => (sfNum(a) < sfNum(b) ? -1 : sfNum(a) > sfNum(b) ? 1 : 0));
  }

  get(id: DomainDiscord.Snowflake): MessageRecord | undefined {
    return this.store.get(id);
  }

  size(): number {
    return this.store.size;
  }
}

// ---------------------------------------------------------------------------
// Channel-state invariant helper
//
// Asserts that the final messages in `channelId`, sorted by snowflake
// (ascending = top-to-bottom in Discord), carry content matching `expectedItems`
// in display order.
//
// `expectedItems` is an array where each element is either:
//   { kind: 'event'; eventId: string }  — matches store.get(id).eventId
//   { kind: 'divider' }                 — matches store.get(id).kind === 'divider'
// ---------------------------------------------------------------------------

type ExpectedItem = { kind: 'event'; eventId: string } | { kind: 'divider' };

function assertChannelOrderMatches(
  expectedItems: ReadonlyArray<ExpectedItem>,
  store: MessageStore,
  channelId: DomainDiscord.Snowflake,
): void {
  const finalIds = store.sortedIds(channelId);
  expect(finalIds, `channel should have ${expectedItems.length} message(s)`).toHaveLength(
    expectedItems.length,
  );
  for (let i = 0; i < expectedItems.length; i++) {
    const record = store.get(finalIds[i]);
    const expected = expectedItems[i];
    expect(record, `message at position ${i} must exist`).toBeDefined();
    if (record === undefined) continue;
    if (expected.kind === 'divider') {
      expect(record.kind, `position ${i} should be a divider`).toBe('divider');
    } else {
      expect(record.kind, `position ${i} should be an event`).toBe('event');
      if (record.kind === 'event') {
        expect(record.eventId, `position ${i} should carry event ${expected.eventId}`).toBe(
          expected.eventId,
        );
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Shared date helpers — all tests use NOW = 2026-01-22T00:00:00Z
// ---------------------------------------------------------------------------

const NOW_ISO = '2026-01-22T00:00:00Z';

/** Future dates (start_at > NOW and also > current real-world time) */
const FUTURE_1 = '2030-01-23T00:00:00Z'; // soonest upcoming → should appear last in display order
const FUTURE_2 = '2030-01-25T00:00:00Z';
const FUTURE_3 = '2030-01-30T00:00:00Z'; // farthest upcoming → appears first among futures

/** Past dates (start_at < NOW) */
const PAST_1 = '2026-01-10T00:00:00Z'; // oldest past → appears first overall
const PAST_2 = '2026-01-15T00:00:00Z';
const PAST_3 = '2026-01-18T00:00:00Z';

// ---------------------------------------------------------------------------
// Entry factory
// ---------------------------------------------------------------------------

let _entryCounter = 0;

const makeEntry = (
  isoDate: string,
  opts: {
    eventId?: string;
    snowflake?: DomainDiscord.Snowflake;
    status?: string;
  } = {},
): EventRpcModels.ChannelEventEntry => {
  const n = ++_entryCounter;
  return new EventRpcModels.ChannelEventEntry({
    event_id: opts.eventId ?? `event-${n}`,
    team_id: 'team-1',
    title: `Event ${n}`,
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe(isoDate),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'match',
    status: opts.status ?? 'scheduled',
    discord_message_id: opts.snowflake ?? sf(n * 100), // caller assigns meaningful snowflake
  });
};

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/** Stable colour value used by `buildDividerEmbed` — the authoritative signal for divider detection */
const DIVIDER_EMBED_COLOR = 0x2b2d31;

type RpcMethodFn = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>;
type RestMethodFn = (...args: ReadonlyArray<unknown>) => Effect.Effect<unknown, unknown, unknown>;
type RpcOverrides = Partial<Record<string, RpcMethodFn>>;
type RestOverrides = Partial<Record<string, RestMethodFn>>;

/**
 * Build a SyncRpc layer backed by an in-memory state. `channelEntries` and
 * `channelDivider` represent the current DB state for the target channel.
 * Mutated state (SaveDiscordMessageId, SaveChannelDivider, DeleteChannelDivider)
 * is recorded so assertions can inspect call counts.
 */
function makeSyncRpcLayer(
  channelId: DomainDiscord.Snowflake,
  channelEntries: EventRpcModels.ChannelEventEntry[],
  channelDivider: Option.Option<DomainDiscord.Snowflake>,
  rpcCalls: {
    saveMessageId: Array<{ eventId: string; newId: DomainDiscord.Snowflake }>;
    saveChannelDivider: Array<DomainDiscord.Snowflake>;
    deleteChannelDivider: number;
  },
  overrides: RpcOverrides = {},
): Layer.Layer<SyncRpc> {
  let storedDivider = channelDivider;

  const defaults: Record<string, RpcMethodFn> = {
    'Event/GetChannelEvents': (args: unknown) => {
      const typed = args as { discord_channel_id: DomainDiscord.Snowflake };
      if (typed.discord_channel_id === channelId) return Effect.succeed(channelEntries);
      return Effect.succeed([]);
    },
    'Event/GetChannelDivider': (args: unknown) => {
      const typed = args as { discord_channel_id: DomainDiscord.Snowflake };
      if (typed.discord_channel_id === channelId) return Effect.succeed(storedDivider);
      return Effect.succeed(Option.none());
    },
    'Event/SaveDiscordMessageId': (args: unknown) => {
      const typed = args as {
        event_id: string;
        discord_message_id: DomainDiscord.Snowflake;
      };
      rpcCalls.saveMessageId.push({ eventId: typed.event_id, newId: typed.discord_message_id });
      // Update in-place so subsequent sortedEntries reads see the new snowflake
      const idx = channelEntries.findIndex((e) => e.event_id === typed.event_id);
      if (idx !== -1) {
        channelEntries[idx] = new EventRpcModels.ChannelEventEntry({
          ...channelEntries[idx],
          discord_message_id: typed.discord_message_id,
        });
      }
      return Effect.void;
    },
    'Event/SaveChannelDivider': (args: unknown) => {
      const typed = args as { discord_message_id: DomainDiscord.Snowflake };
      storedDivider = Option.some(typed.discord_message_id);
      rpcCalls.saveChannelDivider.push(typed.discord_message_id);
      return Effect.void;
    },
    'Event/DeleteChannelDivider': (_args: unknown) => {
      storedDivider = Option.none();
      rpcCalls.deleteChannelDivider++;
      return Effect.void;
    },
    'Event/GetRsvpCounts': () =>
      Effect.succeed({ yesCount: 0, noCount: 0, maybeCount: 0, canRsvp: true }),
    'Event/GetYesAttendeesForEmbed': () => Effect.succeed([]),
  };

  // Cast: Proxy intercepts all property access at runtime; static type is irrelevant for the mock
  const rpcProxy = new Proxy({} as never, {
    get: (_target: unknown, method: string) => {
      const fn = overrides[method] ?? defaults[method];
      return fn ?? (() => Effect.succeed(null));
    },
  }) as unknown as import('~/services/SyncRpc.js').SyncRpcClient;
  return Layer.succeed(SyncRpc, rpcProxy);
}

/**
 * Build a DiscordREST layer backed by a MessageStore. Tracks call counts so
 * tests can assert no spurious REST calls occur.
 *
 * Divider detection: check `payload.embeds[0].color === DIVIDER_EMBED_COLOR`
 * (the stable colour from `buildDividerEmbed`) rather than an i18n string.
 */
function makeRestLayer(
  store: MessageStore,
  channelId: DomainDiscord.Snowflake,
  restCalls: {
    createMessage: number;
    deleteMessage: number;
    updateMessage: number;
    listMessages: number;
  },
  overrides: RestOverrides = {},
): Layer.Layer<DiscordREST> {
  const defaults: Record<string, RestMethodFn> = {
    createMessage: (chId: unknown, payload: unknown) => {
      restCalls.createMessage++;
      const typedChId = chId as DomainDiscord.Snowflake;
      const typedPayload = payload as {
        embeds?: ReadonlyArray<{ color?: number; title?: string; description?: string }>;
        components?: ReadonlyArray<unknown>;
        _testEventId?: string;
      };
      // Divider detection: use the stable embed colour constant
      const isDivider = typedPayload?.embeds?.[0]?.color === DIVIDER_EMBED_COLOR;
      const newId = store.create({
        kind: isDivider ? 'divider' : 'event',
        eventId: typedPayload._testEventId ?? 'unknown',
        channelId: typedChId,
      });
      return Effect.succeed({ id: newId });
    },
    deleteMessage: (_chId: unknown, msgId: unknown) => {
      restCalls.deleteMessage++;
      store.delete(msgId as DomainDiscord.Snowflake);
      return Effect.succeed({});
    },
    updateMessage: (_chId: unknown, msgId: unknown, payload: unknown) => {
      restCalls.updateMessage++;
      const typedPayload = payload as {
        embeds?: ReadonlyArray<{ color?: number }>;
        _testEventId?: string;
      };
      const typedMsgId = msgId as DomainDiscord.Snowflake;
      const isDivider = typedPayload?.embeds?.[0]?.color === DIVIDER_EMBED_COLOR;
      if (isDivider) {
        store.update(typedMsgId, { kind: 'divider' });
      } else if (typedPayload._testEventId !== undefined) {
        store.update(typedMsgId, { kind: 'event', eventId: typedPayload._testEventId });
      }
      return Effect.succeed({});
    },
    listMessages: (_chId: unknown) => {
      restCalls.listMessages++;
      return Effect.succeed(
        store
          .sortedIds(channelId)
          .map((id) => ({ id }))
          .reverse(),
      );
    },
  };

  // Cast: Proxy intercepts all property access at runtime; static type is irrelevant for the mock
  const restProxy = new Proxy({} as never, {
    get: (_target: unknown, method: string) => {
      const fn = overrides[method] ?? defaults[method];
      return fn ?? (() => Effect.succeed(null));
    },
  }) as unknown as import('dfx/DiscordREST').DiscordRestService;
  return Layer.succeed(DiscordREST, restProxy);
}

/**
 * A stub ChannelReorderSemaphore layer that provides no actual locking
 * (single-threaded tests don't need it).
 */
const NoOpSemaphoreLayer: Layer.Layer<ChannelReorderSemaphore> = ChannelReorderSemaphore.Live;

/** Run an effect with all required mocked layers */
const run = (
  effect: Effect.Effect<void, unknown, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST | ChannelReorderSemaphore>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Convenience: build all three layers merged
// ---------------------------------------------------------------------------

function buildLayers(
  syncRpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
): Layer.Layer<SyncRpc | DiscordREST | ChannelReorderSemaphore> {
  return Layer.mergeAll(syncRpcLayer, restLayer, NoOpSemaphoreLayer);
}

// ===========================================================================
// sortEntriesForChannel (existing, kept intact)
// ===========================================================================

describe('sortEntriesForChannel', () => {
  const NOW = DateTime.makeUnsafe(NOW_ISO);

  it('sorts all-future entries with nearest upcoming last', () => {
    const jan25 = makeEntry(FUTURE_2);
    const jan23 = makeEntry(FUTURE_1);
    const jan30 = makeEntry(FUTURE_3);

    const result = sortEntriesForChannel([jan25, jan23, jan30], NOW);

    expect(result.map((e) => e.start_at)).toEqual([
      DateTime.makeUnsafe(FUTURE_3),
      DateTime.makeUnsafe(FUTURE_2),
      DateTime.makeUnsafe(FUTURE_1),
    ]);
  });

  it('sorts all-past entries by start_at ascending', () => {
    const jan15 = makeEntry(PAST_2);
    const jan10 = makeEntry(PAST_1);
    const jan18 = makeEntry(PAST_3);

    const result = sortEntriesForChannel([jan15, jan10, jan18], NOW);

    expect(result.map((e) => e.start_at)).toEqual([
      DateTime.makeUnsafe(PAST_1),
      DateTime.makeUnsafe(PAST_2),
      DateTime.makeUnsafe(PAST_3),
    ]);
  });

  it('puts past entries before future entries with nearest upcoming last', () => {
    const jan20 = makeEntry('2026-01-20T00:00:00Z');
    const jan25 = makeEntry(FUTURE_2);
    const jan23 = makeEntry(FUTURE_1);
    const jan21 = makeEntry('2026-01-21T00:00:00Z');
    const jan30 = makeEntry(FUTURE_3);

    const result = sortEntriesForChannel([jan20, jan25, jan23, jan21, jan30], NOW);

    expect(result.map((e) => e.start_at)).toEqual([
      DateTime.makeUnsafe('2026-01-20T00:00:00Z'),
      DateTime.makeUnsafe('2026-01-21T00:00:00Z'),
      DateTime.makeUnsafe(FUTURE_3),
      DateTime.makeUnsafe(FUTURE_2),
      DateTime.makeUnsafe(FUTURE_1),
    ]);
  });

  it('handles single entry', () => {
    const jan25 = makeEntry(FUTURE_2);

    const result = sortEntriesForChannel([jan25], NOW);

    expect(result).toHaveLength(1);
    expect(result[0].start_at).toEqual(DateTime.makeUnsafe(FUTURE_2));
  });

  it('handles empty array', () => {
    const result = sortEntriesForChannel([], NOW);

    expect(result).toEqual([]);
  });

  it('handles entries with same start_at', () => {
    const jan25a = makeEntry(FUTURE_2, {
      eventId: 'event-same-a',
      snowflake: DomainDiscord.Snowflake.makeUnsafe('100000000000000001'),
    });
    const jan25b = makeEntry(FUTURE_2, {
      eventId: 'event-same-b',
      snowflake: DomainDiscord.Snowflake.makeUnsafe('100000000000000002'),
    });

    const result = sortEntriesForChannel([jan25a, jan25b], NOW);

    expect(result).toHaveLength(2);
    const eventIds = result.map((e) => e.event_id);
    expect(eventIds).toContain('event-same-a');
    expect(eventIds).toContain('event-same-b');
  });

  it('treats event at exactly now as future', () => {
    const jan22 = makeEntry(NOW_ISO);
    const jan25 = makeEntry(FUTURE_2);

    const result = sortEntriesForChannel([jan22, jan25], NOW);

    // Both are future (start_at >= now), sorted descending → nearest last
    expect(result.map((e) => e.start_at)).toEqual([
      DateTime.makeUnsafe(FUTURE_2),
      DateTime.makeUnsafe(NOW_ISO),
    ]);
  });
});

// ===========================================================================
// reorderChannelMessages — orchestrator tests (TDD, all initially failing)
// ===========================================================================

describe('reorderChannelMessages (orchestrator)', () => {
  // Reset the entry counter before each test to avoid cross-test bleed
  beforeEach(() => {
    _entryCounter = 0;
  });

  // -------------------------------------------------------------------------
  // T1 — Already-ordered: no-op
  // Snowflakes [100, 200, 300] in display order (all-future: 300→200→100 by
  // start_at desc, but we assign snowflakes 100,200,300 s.t. the display order
  // already matches ascending snowflake order).
  //
  // Display order (top→bottom): item[0]=sf100, item[1]=sf200, item[2]=sf300
  // Prefix algorithm: all three already satisfy strictly-increasing constraint
  // → k=3, zero creates/deletes.
  // -------------------------------------------------------------------------
  it('T1: already-ordered messages — zero creates/deletes', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Three future events; display order is FUTURE_3 > FUTURE_2 > FUTURE_1
    // (farthest future first → nearest future last)
    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t1-1', snowflake: sf(100) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t1-2', snowflake: sf(200) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t1-3', snowflake: sf(300) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t1-1', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t1-2', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t1-3', channelId: CHANNEL_ID });

    const entries = [e1, e2, e3];

    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    expect(restCalls.createMessage, 'no creates for already-ordered').toBe(0);
    expect(restCalls.deleteMessage, 'no deletes for already-ordered').toBe(0);
  });

  // -------------------------------------------------------------------------
  // T2 — [300, 100, 200] reorder
  // Snowflake assignment: ev-t2-1=sf(300), ev-t2-2=sf(100), ev-t2-3=sf(200).
  // min(suffix from i=0) = min(300,100,200)=100 ≤ 300 → prefix breaks at i=0.
  // k=0 → ALL three recreated in display order.
  // -------------------------------------------------------------------------
  it('T2: [300,100,200] snowflakes — all three recreated in correct display order', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Display order top→bottom: FUTURE_3, FUTURE_2, FUTURE_1 (farthest→nearest)
    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t2-1', snowflake: sf(300) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t2-2', snowflake: sf(100) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t2-3', snowflake: sf(200) });

    store.seed(sf(300), { kind: 'event', eventId: 'ev-t2-1', channelId: CHANNEL_ID });
    store.seed(sf(100), { kind: 'event', eventId: 'ev-t2-2', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t2-3', channelId: CHANNEL_ID });

    const entries = [e1, e2, e3];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // All three must be recreated (old 3 deleted, 3 new created)
    expect(restCalls.deleteMessage, 'all 3 old messages deleted').toBe(3);
    expect(restCalls.createMessage, 'all 3 new messages created').toBe(3);

    // Final channel state: correct content at each snowflake position (top→bottom)
    // Display order: ev-t2-1 (FUTURE_3), ev-t2-2 (FUTURE_2), ev-t2-3 (FUTURE_1)
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t2-1' },
        { kind: 'event', eventId: 'ev-t2-2' },
        { kind: 'event', eventId: 'ev-t2-3' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T3 — [100, 300, 200] reorder
  // Display order: item[0]=sf(100), item[1]=sf(300), item[2]=sf(200)
  // i=0: s=100, lastKept=-∞ → ok. minSuffix[1]=min(300,200)=200 > 100 → ok. k=1.
  // i=1: s=300, lastKept=100 → ok. minSuffix[2]=200 ≤ 300 → break.
  // k=1 → keep item[0]=sf(100); recreate item[1],item[2].
  // -------------------------------------------------------------------------
  it('T3: [100,300,200] snowflakes — keep first, recreate last two', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t3-1', snowflake: sf(100) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t3-2', snowflake: sf(300) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t3-3', snowflake: sf(200) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t3-1', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t3-2', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t3-3', channelId: CHANNEL_ID });

    const entries = [e1, e2, e3];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // item[0] kept in place — 1 edit (content refresh), 0 deletes for it
    // item[1] and item[2] recreated — 2 deletes + 2 creates
    expect(restCalls.deleteMessage, '2 old messages deleted').toBe(2);
    expect(restCalls.createMessage, '2 new messages created').toBe(2);

    // sf(100) must still be present (kept)
    expect(store.get(sf(100))).toBeDefined();

    // sf(300) and sf(200) must be gone
    expect(store.get(sf(300))).toBeUndefined();
    expect(store.get(sf(200))).toBeUndefined();

    // Final channel state: correct content at each snowflake position (top→bottom)
    // Display order: ev-t3-1 (FUTURE_3, kept at sf100), ev-t3-2 (FUTURE_2), ev-t3-3 (FUTURE_1)
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t3-1' },
        { kind: 'event', eventId: 'ev-t3-2' },
        { kind: 'event', eventId: 'ev-t3-3' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T4 — [100, 150, 99] snowflakes
  // Display order: item[0]=sf(100), item[1]=sf(150), item[2]=sf(99)
  // i=0: s=100. minSuffix[1]=min(150,99)=99 ≤ 100 → break immediately.
  // k=0 → ALL three recreated.
  // -------------------------------------------------------------------------
  it('T4: [100,150,99] snowflakes — suffix min violates at i=0, k=0, all recreated', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t4-1', snowflake: sf(100) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t4-2', snowflake: sf(150) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t4-3', snowflake: sf(99) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t4-1', channelId: CHANNEL_ID });
    store.seed(sf(150), { kind: 'event', eventId: 'ev-t4-2', channelId: CHANNEL_ID });
    store.seed(sf(99), { kind: 'event', eventId: 'ev-t4-3', channelId: CHANNEL_ID });

    const entries = [e1, e2, e3];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    expect(restCalls.deleteMessage, 'all 3 old messages deleted').toBe(3);
    expect(restCalls.createMessage, 'all 3 new messages created').toBe(3);

    // Old IDs gone
    expect(store.get(sf(100))).toBeUndefined();
    expect(store.get(sf(150))).toBeUndefined();
    expect(store.get(sf(99))).toBeUndefined();

    // Final channel state: correct content at each snowflake position (top→bottom)
    // Display order: ev-t4-1 (FUTURE_3), ev-t4-2 (FUTURE_2), ev-t4-3 (FUTURE_1)
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t4-1' },
        { kind: 'event', eventId: 'ev-t4-2' },
        { kind: 'event', eventId: 'ev-t4-3' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T5 — Divider in kept prefix
  // Mixed past+future. Divider snowflake sits within kept prefix.
  // Expected: divider message edited in-place, NOT deleted and recreated.
  // -------------------------------------------------------------------------
  it('T5: divider fits in kept prefix — edited in-place, not recreated', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Display order: past(sf100) | divider(sf200) | future(sf300)
    // Snowflake order: 100 < 200 < 300 — already correct, k=3 (all kept)
    const ePast = makeEntry(PAST_1, { eventId: 'ev-t5-past', snowflake: sf(100) });
    const eFuture = makeEntry(FUTURE_1, { eventId: 'ev-t5-future', snowflake: sf(300) });
    const dividerId = sf(200);

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t5-past', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'divider', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t5-future', channelId: CHANNEL_ID });

    const entries = [ePast, eFuture];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.some(dividerId), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // Divider must NOT have been deleted
    expect(store.get(sf(200))).toBeDefined();
    expect(store.get(sf(200))?.kind).toBe('divider');
    expect(restCalls.deleteMessage, 'divider not deleted').toBe(0);

    // Divider was edited in-place (updateMessage called)
    // (At minimum 1 updateMessage for the divider, possibly more for event content refresh)
    expect(restCalls.createMessage, 'no new divider created').toBe(0);
  });

  // -------------------------------------------------------------------------
  // T6 — Divider needs recreating (snowflake violates prefix)
  // Divider snowflake sits in recreate suffix → must delete + create anew.
  // -------------------------------------------------------------------------
  it('T6: divider snowflake violates prefix — deleted and recreated', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Display order: past(sf100) | divider(sf50) | future(sf300)
    // Prefix walk: i=0 s=100, minSuffix[1]=min(50,300)=50 ≤ 100 → break at k=0.
    // Entire set (including divider) recreated.
    const ePast = makeEntry(PAST_1, { eventId: 'ev-t6-past', snowflake: sf(100) });
    const eFuture = makeEntry(FUTURE_1, { eventId: 'ev-t6-future', snowflake: sf(300) });
    const dividerId = sf(50);

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t6-past', channelId: CHANNEL_ID });
    store.seed(sf(50), { kind: 'divider', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t6-future', channelId: CHANNEL_ID });

    const entries = [ePast, eFuture];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.some(dividerId), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // Old divider must be deleted
    expect(store.get(sf(50))).toBeUndefined();
    expect(restCalls.deleteMessage, 'old divider deleted').toBeGreaterThanOrEqual(1);

    // New divider must exist
    expect(rpcCalls.saveChannelDivider).toHaveLength(1);

    // SaveChannelDivider called once with new ID
    const newDividerId = rpcCalls.saveChannelDivider[0];
    expect(sfNum(newDividerId)).toBeGreaterThan(50n);

    // Final channel state: past | divider | future in correct order with correct content
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t6-past' },
        { kind: 'divider' },
        { kind: 'event', eventId: 'ev-t6-future' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T7 — Divider needs creating (none existed)
  // Mix of past + future → needsDivider=true, existingDivider=None.
  // Expect: createMessage(divider embed) + SaveChannelDivider once.
  // -------------------------------------------------------------------------
  it('T7: divider needed but none existed — createMessage(divider) + SaveChannelDivider', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const ePast = makeEntry(PAST_1, { eventId: 'ev-t7-past', snowflake: sf(100) });
    const eFuture = makeEntry(FUTURE_1, { eventId: 'ev-t7-future', snowflake: sf(200) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t7-past', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t7-future', channelId: CHANNEL_ID });

    const entries = [ePast, eFuture];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // SaveChannelDivider called exactly once
    expect(rpcCalls.saveChannelDivider).toHaveLength(1);
    expect(rpcCalls.deleteChannelDivider, 'no delete of non-existent divider').toBe(0);

    // Final channel state: past | divider | future in correct order with correct content
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t7-past' },
        { kind: 'divider' },
        { kind: 'event', eventId: 'ev-t7-future' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T8 — Divider needs deleting (only future events remain)
  // existingDivider=Some, needsDivider=false.
  // Expect: deleteMessage(dividerId) + DeleteChannelDivider before reorder.
  // -------------------------------------------------------------------------
  it('T8: divider exists but not needed — deleteMessage + DeleteChannelDivider', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const dividerId = sf(150);
    const eFuture1 = makeEntry(FUTURE_1, { eventId: 'ev-t8-1', snowflake: sf(100) });
    const eFuture2 = makeEntry(FUTURE_2, { eventId: 'ev-t8-2', snowflake: sf(200) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t8-1', channelId: CHANNEL_ID });
    store.seed(sf(150), { kind: 'divider', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t8-2', channelId: CHANNEL_ID });

    const entries = [eFuture1, eFuture2];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.some(dividerId), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // Old divider deleted
    expect(store.get(sf(150))).toBeUndefined();
    expect(restCalls.deleteMessage, 'divider deleted once').toBeGreaterThanOrEqual(1);
    expect(rpcCalls.deleteChannelDivider, 'DeleteChannelDivider RPC called').toBe(1);

    // No new divider
    expect(rpcCalls.saveChannelDivider, 'no SaveChannelDivider').toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // T9 — editMessage returns 10008 (Unknown Message) for a kept-prefix entry
  // The kept entry disappears while we try to edit it → fold it into recreate.
  // Final invariant must hold. Only ONE recreate cycle (no second pass).
  // -------------------------------------------------------------------------
  it('T9: 10008 on kept-prefix edit — entry folded into recreate, final invariant holds', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Display order: ev-t9-1(sf100), ev-t9-2(sf200), ev-t9-3(sf300) — prefix k=3
    // But updateMessage for sf(100) returns 10008 → must be recreated
    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t9-1', snowflake: sf(100) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t9-2', snowflake: sf(200) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t9-3', snowflake: sf(300) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t9-1', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t9-2', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t9-3', channelId: CHANNEL_ID });

    // Simulate the message at sf(100) already being gone from Discord
    const errorResponse = {
      _tag: 'ErrorResponse' as const,
      data: { code: 10008, message: 'Unknown Message' },
    };

    const entries = [e1, e2, e3];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls, {
      updateMessage: (
        _chId: unknown,
        msgId: unknown,
        _options: unknown,
      ): Effect.Effect<unknown, unknown, unknown> => {
        restCalls.updateMessage++;
        if (msgId === sf(100)) {
          // Simulate message already deleted from Discord
          store.delete(sf(100));
          return Effect.fail(errorResponse);
        }
        return Effect.succeed({});
      },
    });

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // sf(100) must no longer be in store (was already gone from Discord)
    expect(store.get(sf(100))).toBeUndefined();

    // ev-t9-1 must have been recreated (SaveDiscordMessageId called for it)
    const savedForE1 = rpcCalls.saveMessageId.find((c) => c.eventId === 'ev-t9-1');
    expect(savedForE1, 'ev-t9-1 re-persisted with new id').toBeDefined();

    // Final channel state: all three events in correct display order with correct content
    // Display order: ev-t9-1 (FUTURE_3), ev-t9-2 (FUTURE_2), ev-t9-3 (FUTURE_1)
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t9-1' },
        { kind: 'event', eventId: 'ev-t9-2' },
        { kind: 'event', eventId: 'ev-t9-3' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T10 — Concurrency lock: two parallel reorders on same channelId serialize.
  // NOTE: This test requires ChannelReorderSemaphore to actually lock.
  // With the NoOp stub it cannot verify serialization.
  // Full serialization will be tested once the real semaphore layer is wired up.
  // -------------------------------------------------------------------------
  it.todo(
    'T10: same-channel concurrent calls serialize; different-channel calls run in parallel (requires real Effect.Semaphore per channelId)',
  );

  // -------------------------------------------------------------------------
  // T11 — Cap = 10: 15 entries → only last 10 processed
  //
  // With all-future entries sorted farthest-first (display order):
  //   indices 0–4  = entries 1–5  (farthest future, ev-t11-1 to ev-t11-5) → dropped
  //   indices 5–14 = entries 6–15 (nearest  future, ev-t11-6 to ev-t11-15) → kept
  // -------------------------------------------------------------------------
  it('T11: 15 entries capped to MAX_CHANNEL_EVENTS (10) — correct 5 dropped, correct 10 kept', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // 15 future entries, snowflakes 100..1500 (step 100) in correct display order
    // (farthest future first → nearest future last)
    const futureDates = [
      '2030-03-01T00:00:00Z', // index 0, ev-t11-1, sf(100)  — farthest → dropped
      '2030-02-28T00:00:00Z', // index 1, ev-t11-2, sf(200)  — dropped
      '2030-02-27T00:00:00Z', // index 2, ev-t11-3, sf(300)  — dropped
      '2030-02-26T00:00:00Z', // index 3, ev-t11-4, sf(400)  — dropped
      '2030-02-25T00:00:00Z', // index 4, ev-t11-5, sf(500)  — dropped
      '2030-02-24T00:00:00Z', // index 5, ev-t11-6, sf(600)  — kept
      '2030-02-23T00:00:00Z',
      '2030-02-22T00:00:00Z',
      '2030-02-21T00:00:00Z',
      '2030-02-20T00:00:00Z',
      '2030-02-19T00:00:00Z',
      '2030-02-18T00:00:00Z',
      '2030-02-17T00:00:00Z',
      '2030-02-16T00:00:00Z',
      '2030-02-15T00:00:00Z', // index 14, ev-t11-15, sf(1500) — nearest → kept
    ];

    const entries = futureDates.map((d, i) => {
      const id = (i + 1) * 100;
      const e = makeEntry(d, { eventId: `ev-t11-${i + 1}`, snowflake: sf(id) });
      store.seed(sf(id), { kind: 'event', eventId: `ev-t11-${i + 1}`, channelId: CHANNEL_ID });
      return e;
    });

    // The 5 dropped entries are the farthest future (indices 0–4 in display order)
    const droppedEventIds = entries.slice(0, 5).map((e) => e.event_id);
    // The 10 kept entries are the nearest future (indices 5–14 in display order)
    const keptEventIds = entries.slice(5).map((e) => e.event_id);

    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    // SaveDiscordMessageId must NOT have been called for any dropped entry
    for (const droppedId of droppedEventIds) {
      const saved = rpcCalls.saveMessageId.find((c) => c.eventId === droppedId);
      expect(saved, `dropped entry ${droppedId} must not be saved`).toBeUndefined();
    }

    // SaveDiscordMessageId must have been called (or messages kept) for all 10 kept entries
    // We verify by confirming the final channel contains exactly the kept event IDs
    const finalIds = store.sortedIds(CHANNEL_ID);
    expect(finalIds.length, 'at most MAX_CHANNEL_EVENTS messages in channel').toBeLessThanOrEqual(
      MAX_CHANNEL_EVENTS,
    );

    // The kept entries should all be present in the final channel
    const finalEventIds = finalIds
      .map((id) => store.get(id))
      .filter((r): r is Extract<MessageRecord, { kind: 'event' }> => r?.kind === 'event')
      .map((r) => r.eventId);

    for (const keptId of keptEventIds) {
      expect(finalEventIds, `kept entry ${keptId} should be in the channel`).toContain(keptId);
    }
  });

  // -------------------------------------------------------------------------
  // T12 — Empty entries with divider present
  // entries=[], existingDivider=Some → delete divider + DeleteChannelDivider
  // -------------------------------------------------------------------------
  it('T12: empty entries with divider — deleteMessage + DeleteChannelDivider, nothing else', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const dividerId = sf(500);
    store.seed(sf(500), { kind: 'divider', channelId: CHANNEL_ID });

    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, [], Option.some(dividerId), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    expect(restCalls.deleteMessage, 'divider deleted').toBe(1);
    expect(rpcCalls.deleteChannelDivider, 'DeleteChannelDivider RPC called').toBe(1);
    expect(restCalls.createMessage, 'no creates').toBe(0);
    expect(restCalls.updateMessage, 'no updates').toBe(0);
    expect(store.size(), 'channel empty after divider deletion').toBe(0);
  });

  // -------------------------------------------------------------------------
  // T13 — Empty entries, no divider — absolute no-op
  // -------------------------------------------------------------------------
  it('T13: empty entries, no divider — zero REST calls and zero RPC mutations', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, [], Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    expect(restCalls.createMessage, 'zero creates').toBe(0);
    expect(restCalls.deleteMessage, 'zero deletes').toBe(0);
    expect(restCalls.updateMessage, 'zero updates').toBe(0);
    expect(rpcCalls.saveMessageId, 'zero SaveDiscordMessageId').toHaveLength(0);
    expect(rpcCalls.saveChannelDivider, 'zero SaveChannelDivider').toHaveLength(0);
    expect(rpcCalls.deleteChannelDivider, 'zero DeleteChannelDivider').toBe(0);
  });

  // -------------------------------------------------------------------------
  // T14 — Healing pass: snowflakeOverrides forces entry into recreate set
  // Even if entry's stored snowflake would sit in the kept prefix, passing
  // Option.none() as its override forces it into recreate.
  // -------------------------------------------------------------------------
  it('T14: snowflakeOverride Option.none() forces entry into recreate even if prefix would keep it', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    // Display order: ev-t14-1(sf100) ev-t14-2(sf200) ev-t14-3(sf300) — naturally ordered, k=3
    const e1 = makeEntry(FUTURE_3, { eventId: 'ev-t14-1', snowflake: sf(100) });
    const e2 = makeEntry(FUTURE_2, { eventId: 'ev-t14-2', snowflake: sf(200) });
    const e3 = makeEntry(FUTURE_1, { eventId: 'ev-t14-3', snowflake: sf(300) });

    store.seed(sf(100), { kind: 'event', eventId: 'ev-t14-1', channelId: CHANNEL_ID });
    store.seed(sf(200), { kind: 'event', eventId: 'ev-t14-2', channelId: CHANNEL_ID });
    store.seed(sf(300), { kind: 'event', eventId: 'ev-t14-3', channelId: CHANNEL_ID });

    const entries = [e1, e2, e3];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    // Pass override: ev-t14-2's message is missing from Discord (bulk-fetch didn't find it)
    const snowflakeOverrides = new Map<string, Option.Option<DomainDiscord.Snowflake>>([
      ['ev-t14-2', Option.none()],
    ]);

    await run(
      reorderChannelMessages(CHANNEL_ID, 'en', snowflakeOverrides),
      buildLayers(syncLayer, restLayer),
    );

    // ev-t14-2 must have been recreated (SaveDiscordMessageId called)
    const savedForE2 = rpcCalls.saveMessageId.find((c) => c.eventId === 'ev-t14-2');
    expect(savedForE2, 'ev-t14-2 re-persisted').toBeDefined();

    // ev-t14-2 must have a new snowflake greater than any original snowflake
    if (savedForE2 !== undefined) {
      expect(sfNum(savedForE2.newId)).toBeGreaterThan(300n);
    }

    // Final channel state: all three events in correct display order with correct content
    // ev-t14-1 kept at sf100 (or moved), ev-t14-2 recreated, ev-t14-3 kept or recreated
    assertChannelOrderMatches(
      [
        { kind: 'event', eventId: 'ev-t14-1' },
        { kind: 'event', eventId: 'ev-t14-2' },
        { kind: 'event', eventId: 'ev-t14-3' },
      ],
      store,
      CHANNEL_ID,
    );
  });

  // -------------------------------------------------------------------------
  // T15 — handleUpdated does NOT trigger getChannelMessages (no verification pass)
  // NOTE: handleUpdated calls reorderChannelMessages internally. The new
  // reorderChannelMessages must NOT call rest.getChannelMessages (that is only
  // done inside recoverDeletedMessages). This test is placed here because
  // handleUpdated.test.ts does not yet exist; move it there once created.
  // -------------------------------------------------------------------------
  it('T15: reorderChannelMessages never calls getChannelMessages (verification is startup-only)', async () => {
    const store = new MessageStore();
    const rpcCalls = {
      saveMessageId: [] as Array<{ eventId: string; newId: DomainDiscord.Snowflake }>,
      saveChannelDivider: [] as Array<DomainDiscord.Snowflake>,
      deleteChannelDivider: 0,
    };
    const restCalls = {
      createMessage: 0,
      deleteMessage: 0,
      updateMessage: 0,
      listMessages: 0,
    };

    const e1 = makeEntry(FUTURE_1, { eventId: 'ev-t15-1', snowflake: sf(100) });
    store.seed(sf(100), { kind: 'event', eventId: 'ev-t15-1', channelId: CHANNEL_ID });

    const entries = [e1];
    const syncLayer = makeSyncRpcLayer(CHANNEL_ID, entries, Option.none(), rpcCalls);
    const restLayer = makeRestLayer(store, CHANNEL_ID, restCalls);

    await run(reorderChannelMessages(CHANNEL_ID, 'en'), buildLayers(syncLayer, restLayer));

    expect(restCalls.listMessages, 'listMessages must not be called during normal reorder').toBe(0);
  });
});
