// NOTE: These tests are written in TDD mode BEFORE the implementation.
// Tests 1-5 (legacy) cover the old per-training thread behavior.
// Tests T12.B.5 – T12.B.9 cover the NEW Change B behavior:
//   - ONE persistent owners claim thread per owner group (not per-training).
//   - Uses Event/GetOwnerClaimThread, Event/SaveOwnerClaimThread,
//     Event/ClearOwnerClaimThread RPCs instead of per-event thread.
//   - rest.createThread(channelId, body) for creating new public threads.
//
// These new tests will FAIL until the developer rewrites handleTrainingClaimRequest.

import type { EventRpcEvents, EventRpcModels } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
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
const OWNER_GROUP_ID = '00000000-0000-0000-0000-000000000030';
const WINNER_THREAD_ID = '123456789012345678'; // different from THREAD_ID — used for lost-race test

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
    owner_group_id: Option.some(OWNER_GROUP_ID as any),
    all_day: false,
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type CreateMessageCall = [string, MessageCreateRequest];
type CreateThreadCall = [string, unknown]; // [channelId, body]  — new persistent-thread API
type CreateThreadFromMessageCall = [string, string, unknown]; // [channelId, messageId, body]
type DeleteMessageCall = [string, string]; // [channelId, messageId]
type DeleteChannelCall = [string]; // [channelId/threadId]
type SaveClaimThreadCall = { event_id: string; thread_id: string };
type SaveClaimMessageCall = { event_id: string; channel_id: string; message_id: string };

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const createMessageCalls: CreateMessageCall[] = [];
  const createThreadCalls: CreateThreadCall[] = [];
  const startThreadCalls: CreateThreadFromMessageCall[] = [];
  const deleteMessageCalls: DeleteMessageCall[] = [];
  const deleteChannelCalls: DeleteChannelCall[] = [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      createMessageCalls.push(args as CreateMessageCall);
      return Effect.succeed({ id: MSG_ID });
    },
    // New persistent-thread API: createThread(channelId, body)
    createThread: (...args: any[]) => {
      createThreadCalls.push(args as CreateThreadCall);
      return Effect.succeed({ id: THREAD_ID });
    },
    // Legacy per-training thread API (kept for old tests)
    createThreadFromMessage: (...args: any[]) => {
      startThreadCalls.push(args as CreateThreadFromMessageCall);
      return Effect.succeed({ id: THREAD_ID });
    },
    deleteMessage: (...args: any[]) => {
      deleteMessageCalls.push(args as DeleteMessageCall);
      return Effect.succeed(undefined);
    },
    deleteChannel: (...args: any[]) => {
      deleteChannelCalls.push(args as DeleteChannelCall);
      return Effect.succeed(undefined);
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

  return {
    createMessageCalls,
    createThreadCalls,
    startThreadCalls,
    deleteMessageCalls,
    deleteChannelCalls,
    layer,
  };
};

type SaveOwnerClaimThreadCall = { team_id: string; owner_group_id: string; thread_id: string };
type ClearOwnerClaimThreadCall = { team_id: string; owner_group_id: string };

const makeRecordingSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const saveClaimMessageCalls: SaveClaimMessageCall[] = [];
  const saveClaimThreadCalls: SaveClaimThreadCall[] = [];
  const saveOwnerClaimThreadCalls: SaveOwnerClaimThreadCall[] = [];
  const clearOwnerClaimThreadCalls: ClearOwnerClaimThreadCall[] = [];

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
    // New persistent-thread RPCs: default = no existing owners thread
    'Event/GetOwnerClaimThread': (_args: any) => Effect.succeed(Option.none()),
    'Event/SaveOwnerClaimThread': (args: any) => {
      saveOwnerClaimThreadCalls.push(args);
      // Default: the thread we just created "wins" (no race)
      return Effect.succeed(Option.some(args.thread_id));
    },
    'Event/ClearOwnerClaimThread': (args: any) => {
      clearOwnerClaimThreadCalls.push(args);
      return Effect.void;
    },
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

  return {
    saveClaimMessageCalls,
    saveClaimThreadCalls,
    saveOwnerClaimThreadCalls,
    clearOwnerClaimThreadCalls,
    layer,
  };
};

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleTrainingClaimRequest', () => {
  it('claim embed is posted into the owners thread with embeds and components (buttons)', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // The embed must be posted into the thread, not directly into the owner channel
    expect(createMessageCalls).toHaveLength(1);
    const [channelId, payload] = createMessageCalls[0];
    expect(channelId).toBe(THREAD_ID);
    // Should have embed + components (buttons)
    expect(Array.isArray(payload.embeds) && payload.embeds?.length > 0).toBe(true);
    expect(Array.isArray(payload.components) && payload.components?.length > 0).toBe(true);
  });

  it('owners claim thread is created via createThread on the owner channel with a name ≤ 100 chars', async () => {
    const { createThreadCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // createThread must be called on the owner channel (not createThreadFromMessage)
    expect(createThreadCalls).toHaveLength(1);
    const [channelArg, bodyArg] = createThreadCalls[0] as [string, unknown];
    expect(channelArg).toBe(OWNER_CHANNEL);
    // Thread name must not exceed Discord's 100-char limit
    const threadName = (bodyArg as any)?.name ?? '';
    expect(threadName.length).toBeGreaterThan(0);
    expect(threadName.length).toBeLessThanOrEqual(100);
  });

  it('Event/SaveClaimDiscordMessageId is called with event_id and channel_id = thread id', async () => {
    const { layer: restLayer } = makeRecordingDiscordREST();
    const { saveClaimMessageCalls, saveClaimThreadCalls, layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // Old per-event SaveClaimThreadId must NOT be called (removed in Change B)
    expect(saveClaimThreadCalls).toHaveLength(0);

    // SaveClaimDiscordMessageId must be called with the thread id as channel_id
    expect(saveClaimMessageCalls).toHaveLength(1);
    expect(saveClaimMessageCalls[0].event_id).toBe(EVENT_ID);
    expect(saveClaimMessageCalls[0].channel_id).toBe(THREAD_ID);
    expect(saveClaimMessageCalls[0].message_id).toBe(MSG_ID);
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

  // -------------------------------------------------------------------------
  // T12.B.5 – T12.B.9: Change B — persistent owners claim thread
  // -------------------------------------------------------------------------

  // T12.B.5 — No existing owners thread → createThread called, SaveOwnerClaimThread called,
  //           claim embed posted into the new thread, SaveClaimDiscordMessageId channel = threadId
  it('T12.B.5: no existing owners thread → creates thread, saves it, posts embed into thread', async () => {
    const {
      saveOwnerClaimThreadCalls,
      saveClaimMessageCalls,
      layer: rpcLayer,
    } = makeRecordingSyncRpc();
    const {
      createMessageCalls: restCreateMessageCalls,
      createThreadCalls: restCreateThreadCalls,
      layer: restLayer,
    } = makeRecordingDiscordREST();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // createThread must have been called once on OWNER_CHANNEL
    expect(restCreateThreadCalls).toHaveLength(1);
    const [createThreadChannelId] = restCreateThreadCalls[0] as [string, unknown];
    expect(createThreadChannelId).toBe(OWNER_CHANNEL);

    // SaveOwnerClaimThread must have been called
    expect(saveOwnerClaimThreadCalls).toHaveLength(1);
    expect(saveOwnerClaimThreadCalls[0].team_id).toBe(TEAM_ID);
    expect(saveOwnerClaimThreadCalls[0].owner_group_id).toBe(OWNER_GROUP_ID);
    expect(saveOwnerClaimThreadCalls[0].thread_id).toBe(THREAD_ID);

    // createMessage (embed) must target the thread, not the channel
    const embedCalls = restCreateMessageCalls.filter(([ch]) => ch === THREAD_ID);
    expect(embedCalls).toHaveLength(1);

    // SaveClaimDiscordMessageId.channel_id must equal the thread id
    expect(saveClaimMessageCalls).toHaveLength(1);
    expect(saveClaimMessageCalls[0].channel_id).toBe(THREAD_ID);
  });

  // T12.B.6 — Existing owners thread → createThread NOT called, embed posted into stored thread
  it('T12.B.6: existing owners thread → no createThread, embed posted into stored thread', async () => {
    const {
      saveOwnerClaimThreadCalls,
      saveClaimMessageCalls,
      layer: rpcLayer,
    } = makeRecordingSyncRpc({
      'Event/GetOwnerClaimThread': (_args: any) =>
        Effect.succeed(Option.some(EXISTING_THREAD_ID as any)),
    });
    const {
      createMessageCalls: restCreateMessageCalls,
      createThreadCalls: restCreateThreadCalls,
      layer: restLayer,
    } = makeRecordingDiscordREST();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // No new thread should be created
    expect(restCreateThreadCalls).toHaveLength(0);
    expect(saveOwnerClaimThreadCalls).toHaveLength(0);

    // Embed must be posted into the existing thread
    const embedCalls = restCreateMessageCalls.filter(([ch]) => ch === EXISTING_THREAD_ID);
    expect(embedCalls).toHaveLength(1);

    // SaveClaimDiscordMessageId.channel_id must equal the existing thread
    expect(saveClaimMessageCalls).toHaveLength(1);
    expect(saveClaimMessageCalls[0].channel_id).toBe(EXISTING_THREAD_ID);
  });

  // T12.B.7 — Lost race: SaveOwnerClaimThread returns a different (winner) thread id →
  //           orphan thread deleted, winner thread used for embed post
  it('T12.B.7: lost race on SaveOwnerClaimThread → orphan deleted, embed posted to winner', async () => {
    const { saveClaimMessageCalls, layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetOwnerClaimThread': (_args: any) => Effect.succeed(Option.none()),
      // SaveOwnerClaimThread returns the WINNER_THREAD_ID (someone else won the race)
      'Event/SaveOwnerClaimThread': (_args: any) =>
        Effect.succeed(Option.some(WINNER_THREAD_ID as any)),
    });
    const {
      createMessageCalls: restCreateMessageCalls,
      createThreadCalls: restCreateThreadCalls,
      deleteChannelCalls,
      layer: restLayer,
    } = makeRecordingDiscordREST();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // Thread was created (we didn't know about the race yet)
    expect(restCreateThreadCalls).toHaveLength(1);

    // The orphan thread (THREAD_ID, the one we created) must be deleted via deleteChannel
    expect(deleteChannelCalls.length).toBeGreaterThan(0);

    // Embed must be posted into the winner thread, not the orphan
    const winnerEmbeds = restCreateMessageCalls.filter(([ch]) => ch === WINNER_THREAD_ID);
    expect(winnerEmbeds).toHaveLength(1);

    // SaveClaimDiscordMessageId.channel_id must use the winner thread
    expect(saveClaimMessageCalls).toHaveLength(1);
    expect(saveClaimMessageCalls[0].channel_id).toBe(WINNER_THREAD_ID);
  });

  // T12.B.8 — Thread deleted (10003 Unknown Channel): ClearOwnerClaimThread called, recreate + retry
  it('T12.B.8: createMessage into stored thread returns 10003 → ClearOwnerClaimThread, recreate, retry', async () => {
    let firstMessageAttempt = true;
    const {
      clearOwnerClaimThreadCalls,
      saveClaimMessageCalls,
      saveOwnerClaimThreadCalls,
      layer: rpcLayer,
    } = makeRecordingSyncRpc({
      'Event/GetOwnerClaimThread': (_args: any) =>
        Effect.succeed(Option.some(EXISTING_THREAD_ID as any)),
    });
    const {
      createMessageCalls: restCreateMessageCalls,
      createThreadCalls: restCreateThreadCalls,
      layer: restLayer,
    } = makeRecordingDiscordREST({
      createMessage: (...args: any[]) => {
        if (firstMessageAttempt && args[0] === EXISTING_THREAD_ID) {
          firstMessageAttempt = false;
          // Simulate thread deleted / not found
          return Effect.fail({
            _tag: 'ErrorResponse',
            data: { code: 10003 },
          }) as unknown as Effect.Effect<any>;
        }
        restCreateMessageCalls.push(args as CreateMessageCall);
        return Effect.succeed({ id: MSG_ID });
      },
    });

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // ClearOwnerClaimThread must have been called
    expect(clearOwnerClaimThreadCalls).toHaveLength(1);

    // A new thread must have been created (the recreate step)
    expect(restCreateThreadCalls).toHaveLength(1);
    expect(saveOwnerClaimThreadCalls).toHaveLength(1);

    // Retry message must have succeeded (posted into the new thread)
    expect(saveClaimMessageCalls).toHaveLength(1);
    expect(saveClaimMessageCalls[0].channel_id).toBe(THREAD_ID); // new thread from retry
  });

  // T12.B.9 — No owner channel (discord_target_channel_id = None) → skip all, no thread, no message
  it('T12.B.9: no owner channel → no createThread, no createMessage', async () => {
    const {
      createThreadCalls: restCreateThreadCalls,
      createMessageCalls: restCreateMessageCalls,
      layer: restLayer,
    } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(
      handleTrainingClaimRequest(makeEvent({ discord_target_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCreateThreadCalls).toHaveLength(0);
    expect(restCreateMessageCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// PR 2 — event.all_day must reach buildClaimMessage (handleTrainingClaimRequest.ts:45
// replaces the PR 1 literal `allDay: false` with `event.all_day`).
// ---------------------------------------------------------------------------

describe('handleTrainingClaimRequest — all_day forwarding (PR 2)', () => {
  it('all-day: claim embed "When" field is exactly <t:S:D> · All day', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    const event = makeEvent({
      all_day: true,
      start_at: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
    });
    await run(handleTrainingClaimRequest(event), Layer.merge(rpcLayer, restLayer));

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const whenField = payload.embeds?.[0]?.fields?.[0];
    const marker = m.bot_embed_all_day({}, { locale: 'en' });
    expect(whenField?.value).toBe(`<t:1784116800:D> · ${marker}`);
  });

  it('timed (default): claim embed "When" field is unchanged at <t:S:f>', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();
    const { layer: rpcLayer } = makeRecordingSyncRpc();

    await run(handleTrainingClaimRequest(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(createMessageCalls).toHaveLength(1);
    const [, payload] = createMessageCalls[0];
    const whenField = payload.embeds?.[0]?.fields?.[0];
    expect(whenField?.value).toBe('<t:1780308000:f>');
  });
});
