// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They assert that the event ProcessorService routes the 'coaching_status' tag
// to handleCoachingStatus.
//
// ASSUMPTION: The production ProcessorService (applications/bot/src/rcp/event/ProcessorService.ts)
//   has a Match.tag('coaching_status', handleCoachingStatus) branch. These tests verify
//   that routing by running a minimal processTick with a coaching_status event and
//   asserting that the handler was invoked (no unhandled-tag error is thrown and
//   the RPC MarkEventProcessed is called).
//
// The ProcessorService is an Effect service. We test it by providing mock RPC + REST
// layers and verifying the dispatch contract.

import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { ProcessorService } from '~/rcp/event/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const TRAINING_CHANNEL = '444444444444444444';
const SYNC_EVENT_ID = 'sync-coaching-routing-1';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeCoachingStatusEvent = (): EventRpcEvents.CoachingStatusEvent =>
  ({
    _tag: 'coaching_status' as const,
    id: SYNC_EVENT_ID,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Routing Test Training',
    start_at: DateTime.makeUnsafe('2026-06-01T14:00:00Z'),
    discord_target_channel_id: Option.some(TRAINING_CHANNEL as any),
    claimed_by_display_name: Option.some('Test Coach'),
    claimed_by_discord_id: Option.none(),
    location: Option.none(),
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const makeRpc = (events: EventRpcEvents.UnprocessedEventSyncEvent[]) => {
  const markedProcessed: string[] = [];
  const markedFailed: string[] = [];

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;

        if (method === 'Event/GetUnprocessedEvents') {
          return (_args: any) => Effect.succeed(events);
        }
        if (method === 'Event/MarkEventProcessed') {
          return (args: any) => {
            markedProcessed.push(args.id);
            return Effect.void;
          };
        }
        if (method === 'Event/MarkEventFailed') {
          return (args: any) => {
            markedFailed.push(args.id);
            return Effect.void;
          };
        }
        // Return null for anything else
        return () => Effect.succeed(null);
      },
    }),
  );

  return { markedProcessed, markedFailed, layer };
};

const makeRest = () =>
  Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;
        // Return a no-op for all REST calls
        return () =>
          Effect.succeed({ id: 'mock-id', preferred_locale: 'en-US', system_channel_id: null });
      },
    }),
  );

const runProcessTick = (rpcLayer: Layer.Layer<SyncRpc>, restLayer: Layer.Layer<DiscordREST>) =>
  Effect.runPromise(
    ProcessorService.pipe(
      Effect.flatMap((svc: any): Effect.Effect<void> => svc.processTick),
      Effect.provide(Layer.mergeAll(rpcLayer, restLayer, ChannelReorderSemaphore.Live)),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EventProcessorService — coaching_status routing', () => {
  it("'coaching_status' tag routes to handleCoachingStatus (MarkEventProcessed is called)", async () => {
    const {
      markedProcessed,
      markedFailed,
      layer: rpcLayer,
    } = makeRpc([makeCoachingStatusEvent() as any]);
    const restLayer = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    // The event was dispatched and processed (not failed)
    expect(markedProcessed).toContain(SYNC_EVENT_ID);
    expect(markedFailed).toHaveLength(0);
  });

  it("'coaching_status' with None channel does NOT throw — handler logs and succeeds", async () => {
    const noneChannelEvent: EventRpcEvents.CoachingStatusEvent = {
      ...makeCoachingStatusEvent(),
      discord_target_channel_id: Option.none(),
    } as any;

    const { markedProcessed, markedFailed, layer: rpcLayer } = makeRpc([noneChannelEvent as any]);
    const restLayer = makeRest();

    await expect(runProcessTick(rpcLayer, restLayer)).resolves.not.toThrow();

    // Even with no channel, event is processed (warning logged, not failed)
    expect(markedProcessed).toContain(SYNC_EVENT_ID);
    expect(markedFailed).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The shared events board is removed (remove-global-events-board, Release A).
// 'event_created' / 'event_updated' / 'event_cancelled' / 'event_channel_moved'
// stay in the union for batch-decode safety (pre-existing rows during rollout
// skew), but now no-op instead of acting on the board. A mixed batch
// containing all four must decode and drain (marked processed) without error,
// and must never touch Discord REST.
// ---------------------------------------------------------------------------

const makeEventCreatedEvent = (id: string): EventRpcEvents.EventCreatedEvent =>
  ({
    _tag: 'event_created' as const,
    id,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Board-removed created event',
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2026-06-01T14:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'match',
    all_day: false,
    discord_channel_id: Option.none(),
  }) as any;

const makeEventUpdatedEvent = (id: string): EventRpcEvents.EventUpdatedEvent =>
  ({
    ...makeEventCreatedEvent(id),
    _tag: 'event_updated' as const,
  }) as any;

const makeEventCancelledEvent = (id: string): EventRpcEvents.EventCancelledEvent =>
  ({
    _tag: 'event_cancelled' as const,
    id,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
  }) as any;

const makeEventChannelMovedEvent = (id: string): EventRpcEvents.EventChannelMovedEvent =>
  ({
    _tag: 'event_channel_moved' as const,
    id,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    old_channel_id: Option.some(TRAINING_CHANNEL as any),
    new_channel_id: Option.some(TRAINING_CHANNEL as any),
  }) as any;

describe('EventProcessorService — removed-board tags are explicit no-ops', () => {
  it('a mixed batch with the four removed-board tags decodes and drains without failure, no REST calls', async () => {
    const restCalls: string[] = [];
    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then' || method === 'catch') {
            return undefined;
          }
          return (..._args: any[]) => {
            restCalls.push(method);
            return Effect.succeed({ id: 'mock-id' });
          };
        },
      }),
    );

    const events: EventRpcEvents.UnprocessedEventSyncEvent[] = [
      makeEventCreatedEvent('sync-created-1') as any,
      makeEventUpdatedEvent('sync-updated-1') as any,
      makeEventCancelledEvent('sync-cancelled-1') as any,
      makeEventChannelMovedEvent('sync-moved-1') as any,
    ];

    const { markedProcessed, markedFailed, layer: rpcLayer } = makeRpc(events);

    await runProcessTick(rpcLayer, restLayer);

    expect(markedProcessed).toEqual(
      expect.arrayContaining([
        'sync-created-1',
        'sync-updated-1',
        'sync-cancelled-1',
        'sync-moved-1',
      ]),
    );
    expect(markedFailed).toHaveLength(0);
    expect(restCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR 1 §7.3 case 7 — an all-day `event_started` row is still marked processed
// (never failed) when the render succeeds. Without this, a throwing all-day
// render would retry forever.
// Plan: all-day-discord-start-time-plan.md §7.3 (Part I spec, case 7).
// ---------------------------------------------------------------------------

const makeAllDayEventStartedEvent = (id: string): EventRpcEvents.EventStartedEvent =>
  ({
    _tag: 'event_started' as const,
    id,
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'All-day PR1 routing test',
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2026-05-01T12:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'match',
    all_day: true,
    member_group_id: Option.none(),
    discord_channel_id: Option.some(TRAINING_CHANNEL as any),
    discord_role_id: Option.none(),
    claimed_by_discord_id: Option.none(),
  }) as any;

describe('EventProcessorService — event_started routing for all-day events (PR 1)', () => {
  it('an all-day event_started row is marked processed, never failed', async () => {
    const SYNC_ID = 'sync-all-day-started-1';
    const {
      markedProcessed,
      markedFailed,
      layer: rpcLayer,
    } = makeRpc([makeAllDayEventStartedEvent(SYNC_ID) as any]);
    const restLayer = makeRest();

    await runProcessTick(rpcLayer, restLayer);

    expect(markedProcessed).toContain(SYNC_ID);
    expect(markedFailed).toHaveLength(0);
  });
});
