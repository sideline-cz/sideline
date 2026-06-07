// NOTE: These tests are written in TDD mode BEFORE the implementation.
// The current handleTrainingClaimRequest only posts the initial claim message.
// These NEW tests cover thread creation (not yet implemented):
//
// New behavior expected (to be implemented):
//   1. Starter message is posted to owner channel with buttons (already exists).
//   2. A thread is created from that message (createThread or startThreadFromMessage).
//   3. Event/SaveClaimThreadId is called with the new thread id.
//   4. Double-create guard: when GetClaimInfo.claim_thread_id is already set,
//      thread creation is skipped entirely.
//   5. Thread-create failure does NOT fail the handler (best-effort).
//
// ASSUMPTION: After posting the claim message, the handler calls
//   rest.createThreadFromMessage(channelId, messageId, { name: truncatedTitle, ... }).
//   The thread name is the event title truncated to 100 chars.
//
// ASSUMPTION: Before creating the thread, the handler calls
//   rpc['Event/GetClaimInfo']({ event_id }) to check if claim_thread_id is already set.
//   If Some(threadId) → skip thread creation (idempotency guard).
//
// ASSUMPTION: The RPC to persist the thread id is rpc['Event/SaveClaimThreadId'].
//
// Tests 1-3 extend coverage of the existing handler.
// Tests 4-5 are the new thread-creation tests.

import type { EventRpcEvents, EventRpcModels } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleTrainingClaimRequest } from '~/rcp/event/handleTrainingClaimRequest.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const OWNER_CHANNEL = '222222222222222222';
const MSG_ID = '333333333333333333';
const THREAD_ID = '444444444444444444';
const EXISTING_THREAD_ID = '555555555555555555';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<EventRpcEvents.TrainingClaimRequestEvent> = {},
): EventRpcEvents.TrainingClaimRequestEvent =>
  ({
    _tag: 'training_claim_request' as const,
    id: 'sync-claim-1',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Monday Training',
    start_at: DateTime.makeUnsafe('2026-06-01T10:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    location_url: Option.none(),
    description: Option.none(),
    discord_target_channel_id: Option.some(OWNER_CHANNEL as any),
    discord_role_id: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type CreateMessageCall = [string, MessageCreateRequest];
type CreateThreadCall = [string, string, unknown]; // [channelId, messageId, body]
type SaveClaimThreadCall = { event_id: string; thread_id: string };
type SaveClaimMessageCall = { event_id: string; channel_id: string; message_id: string };

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const createMessageCalls: CreateMessageCall[] = [];
  const startThreadCalls: CreateThreadCall[] = [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      createMessageCalls.push(args as CreateMessageCall);
      return Effect.succeed({ id: MSG_ID });
    },
    // ASSUMPTION: createThreadFromMessage(channelId, messageId, body) is the thread creation call
    createThreadFromMessage: (...args: any[]) => {
      startThreadCalls.push(args as CreateThreadCall);
      return Effect.succeed({ id: THREAD_ID });
    },
    getGuild: (_guildId: any) =>
      Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null }),
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );

  return { createMessageCalls, startThreadCalls, layer };
};

const makeRecordingSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const saveClaimMessageCalls: SaveClaimMessageCall[] = [];
  const saveClaimThreadCalls: SaveClaimThreadCall[] = [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/SaveClaimDiscordMessageId': (args: any) => {
      saveClaimMessageCalls.push(args);
      return Effect.void;
    },
    'Event/SaveClaimThreadId': (args: any) => {
      saveClaimThreadCalls.push(args);
      return Effect.void;
    },
    // Default: no existing thread
    'Event/GetClaimInfo': (_args: any) =>
      Effect.succeed(
        Option.some({
          event_id: EVENT_ID,
          event_type: 'training',
          status: 'active',
          claimed_by_member_id: Option.none(),
          claimed_by_display_name: Option.none(),
          claim_discord_channel_id: Option.none(),
          claim_discord_message_id: Option.none(),
          claim_thread_id: Option.none(),
        } as EventRpcModels.EventClaimInfo),
      ),
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );

  return { saveClaimMessageCalls, saveClaimThreadCalls, layer };
};

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTrainingClaimRequest', () => {
  it('starter message is posted to owner channel with components (buttons)', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(createMessageCalls).toHaveLength(1);
    const [channelId, payload] = createMessageCalls[0];
    expect(channelId).toBe(OWNER_CHANNEL);
    // Should have embed + components (buttons)
    expect(Array.isArray(payload.embeds) && payload.embeds?.length > 0).toBe(true);
    expect(Array.isArray(payload.components) && payload.components?.length > 0).toBe(true);
  });

  it('thread is created (createThreadFromMessage called) with truncated event title', async () => {
    const { startThreadCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    const longTitle = 'A'.repeat(200);

    await run(
      handleTrainingClaimRequest(makeEvent({ title: longTitle })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(startThreadCalls).toHaveLength(1);
    const [channelArg, messageArg, bodyArg] = startThreadCalls[0];
    expect(channelArg).toBe(OWNER_CHANNEL);
    expect(messageArg).toBe(MSG_ID);
    // Thread name must be truncated to 100 chars
    const threadName = (bodyArg as any)?.name ?? '';
    expect(threadName.length).toBeLessThanOrEqual(100);
  });

  it('Event/SaveClaimThreadId is called with the thread id after creation', async () => {
    const { layer: restLayer } = makeRecordingDiscordREST();
    const { saveClaimThreadCalls, layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(saveClaimThreadCalls).toHaveLength(1);
    expect(saveClaimThreadCalls[0].event_id).toBe(EVENT_ID);
    expect(saveClaimThreadCalls[0].thread_id).toBe(THREAD_ID);
  });

  it('double-create guard: when GetClaimInfo.claim_thread_id is already set, thread creation is skipped', async () => {
    const { startThreadCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { saveClaimThreadCalls, layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.none(),
            claim_discord_message_id: Option.none(),
            // Thread already exists
            claim_thread_id: Option.some(EXISTING_THREAD_ID as any),
          } as EventRpcModels.EventClaimInfo),
        ),
    });

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // Thread must NOT be created again
    expect(startThreadCalls).toHaveLength(0);
    expect(saveClaimThreadCalls).toHaveLength(0);
  });

  it('thread-create failure does NOT fail the handler (best-effort)', async () => {
    const { layer: restLayer } = makeRecordingDiscordREST({
      createThreadFromMessage: () => Effect.die(new Error('thread creation failed')),
    });
    const { saveClaimMessageCalls, layer: rpcLayer } = makeRecordingSyncRpc();

    // Should resolve without throwing
    await expect(
      run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer)),
    ).resolves.not.toThrow();

    // The initial claim message must still have been saved
    expect(saveClaimMessageCalls).toHaveLength(1);
  });

  it('discord_target_channel_id None → logs warning, no createMessage, no thread', async () => {
    const { createMessageCalls, startThreadCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(
      handleTrainingClaimRequest(makeEvent({ discord_target_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(createMessageCalls).toHaveLength(0);
    expect(startThreadCalls).toHaveLength(0);
  });
});
