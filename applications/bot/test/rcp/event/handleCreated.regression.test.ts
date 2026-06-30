// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They cover the regression for Part E.2 of the plan:
//
//   - handleCreated MUST NOT post to guild.system_channel_id as fallback.
//     When event.discord_channel_id is None (no global events channel configured),
//     it should log + skip rather than post to the system channel.
//   - When event.discord_channel_id IS Some (global channel configured), it
//     posts the event embed to that channel.
//
// The existing handleCreated.ts uses `guild.system_channel_id` as fallback
// (line ~29). This regression test verifies the NEW behavior after the
// system-channel fallback is removed.
//
// These tests WILL FAIL until the developer implements the E.2 change in handleCreated.ts.

import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { handleCreated } from '~/rcp/event/handleCreated.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000050';
const GUILD_ID = '520000000000000001';
const EVENT_ID = 'evt-00000000-0000-0000-0000-000000000050';
const GLOBAL_CHANNEL_ID = '520000000000000010';
const SYSTEM_CHANNEL_ID = '520000000000000099'; // Must NOT be posted to

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeCreatedEvent = (
  overrides: Partial<EventRpcEvents.EventCreatedEvent> = {},
): EventRpcEvents.EventCreatedEvent =>
  ({
    _tag: 'event_created' as const,
    id: 'sync-created-1',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Test Event',
    description: Option.none(),
    image_url: Option.none(),
    start_at: DateTime.makeUnsafe('2027-06-01T14:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    event_type: 'training',
    all_day: false,
    discord_channel_id: Option.none(), // default: no channel configured
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/GetRsvpCounts': () =>
      Effect.succeed({ yesCount: 3, noCount: 1, maybeCount: 0, canRsvp: true }),
    'Event/GetYesAttendeesForEmbed': () => Effect.succeed([]),
    'Event/SaveDiscordMessageId': () => Effect.succeed(undefined),
    'Event/GetChannelEvents': () => Effect.succeed([]),
    'Event/GetChannelDivider': () => Effect.succeed(Option.none()),
    'Event/GetChannelDividerSave': () => Effect.succeed(undefined),
  };

  return Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls = {
    createMessage: [] as Array<[string, unknown]>,
    updateMessage: [] as Array<[string, string, unknown]>,
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (channelId: string, payload: unknown) => {
      calls.createMessage.push([channelId, payload]);
      return Effect.succeed({ id: 'new-msg-id' });
    },
    updateMessage: (channelId: string, msgId: string, payload: unknown) => {
      calls.updateMessage.push([channelId, msgId, payload]);
      return Effect.succeed({});
    },
    getGuild: () =>
      Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: SYSTEM_CHANNEL_ID, // system channel IS set but must NOT be used
      }),
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        const fn = overrides[prop] ?? defaults[prop];
        return fn ?? (() => Effect.succeed({ id: 'mock' }));
      },
    }),
  );

  return { layer, calls };
};

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(layers, ChannelReorderSemaphore.Live))) as Effect.Effect<
      void,
      never,
      never
    >,
  );

// ---------------------------------------------------------------------------
// Regression tests
// ---------------------------------------------------------------------------

describe('handleCreated regression — no system_channel fallback (Part E.2)', () => {
  it('when discord_channel_id is None (no global events channel), does NOT createMessage to the system channel', async () => {
    const rpcLayer = makeRpc();
    const { layer: restLayer, calls } = makeRest();

    await run(
      handleCreated(makeCreatedEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    // The system channel must NOT receive a createMessage call
    const systemChannelCalls = calls.createMessage.filter(([ch]) => ch === SYSTEM_CHANNEL_ID);
    expect(systemChannelCalls).toHaveLength(0);

    // No message created at all (skip, not fallback)
    expect(calls.createMessage).toHaveLength(0);
  });

  it('when discord_channel_id is Some (global events channel configured), posts to that channel', async () => {
    const rpcLayer = makeRpc();
    const { layer: restLayer, calls } = makeRest();

    await run(
      handleCreated(
        makeCreatedEvent({ discord_channel_id: Option.some(GLOBAL_CHANNEL_ID as any) }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    // Must post to the global events channel
    expect(calls.createMessage).toHaveLength(1);
    const call = calls.createMessage[0];
    if (!call) throw new Error('expected a createMessage call');
    const [channelId] = call;
    expect(channelId).toBe(GLOBAL_CHANNEL_ID);
  });

  it('when discord_channel_id is None, handler returns void (no error, no crash)', async () => {
    const rpcLayer = makeRpc();
    const { layer: restLayer } = makeRest();

    await expect(
      run(
        handleCreated(makeCreatedEvent({ discord_channel_id: Option.none() })),
        Layer.merge(rpcLayer, restLayer),
      ),
    ).resolves.toBeUndefined();
  });
});
