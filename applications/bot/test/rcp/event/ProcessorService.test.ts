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
