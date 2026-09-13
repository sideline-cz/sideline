// NOTE: The shared events board (and its in-place "started" embed edit +
// recreate-on-10008 recovery) has been removed (remove-global-events-board,
// Release A). The "Starting now" post itself is ALSO removed (Task 3 of the
// training-notifications-fix plan, 2026-09) — `handleStarted` now only deletes
// the training claim message (`deleteClaim`) and posts nothing to Discord.
// Tests below cover only that remaining behavior, plus regression coverage
// that no post-related REST/RPC calls happen anymore.

import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';

type CreateMessageCall = [string, MessageCreateRequest];

import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { handleStarted } from '~/rcp/event/handleStarted.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const CHANNEL_ID = '222222222222222222';
const SYSTEM_CHANNEL_ID = '333333333333333333';

// Claim constants
const CLAIM_THREAD_ID = '888888888888888888';
const CLAIM_MSG_ID = '999999999999999999';

const makeEvent = (
  overrides: Partial<EventRpcEvents.EventStartedEvent> = {},
): EventRpcEvents.EventStartedEvent =>
  ({
    _tag: 'event_started' as const,
    id: 'sync-1',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Saturday Match',
    start_at: DateTime.makeUnsafe('2026-05-01T16:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    event_type: 'match',
    all_day: false,
    member_group_id: Option.none(),
    discord_channel_id: Option.some(CHANNEL_ID as any),
    discord_role_id: Option.none(),
    claimed_by_discord_id: Option.none(),
    start_date: Option.none(),
    end_date: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type SyncRpcCalls = {
  GetYesAttendeesForEmbed: unknown[];
  GetClaimInfo: unknown[];
};

const makeRecordingSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: SyncRpcCalls = {
    GetYesAttendeesForEmbed: [],
    GetClaimInfo: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/GetYesAttendeesForEmbed': (_args: any) => {
      calls.GetYesAttendeesForEmbed.push(_args);
      return Effect.succeed([]);
    },
    // Default: no stored claim info (no claim to delete)
    'Event/GetClaimInfo': (_args: any) => {
      calls.GetClaimInfo.push(_args);
      return Effect.succeed(
        Option.some({
          event_id: EVENT_ID,
          event_type: 'training',
          status: 'active',
          claimed_by_member_id: Option.none(),
          claimed_by_display_name: Option.none(),
          claim_discord_channel_id: Option.none(),
          claim_discord_message_id: Option.none(),
          claim_thread_id: Option.none(),
        }),
      );
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        const fn = overrides[method] ?? defaults[method];
        return fn ?? (() => Effect.succeed(null));
      },
    }),
  );

  return { calls, layer };
};

type RestCalls = {
  createMessage: CreateMessageCall[];
  deleteMessage: unknown[][];
  getGuild: unknown[][];
};

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: RestCalls = { createMessage: [], deleteMessage: [], getGuild: [] };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args as CreateMessageCall);
      return Effect.succeed({ id: 'new-msg-id' });
    },
    deleteMessage: (...args: any[]) => {
      calls.deleteMessage.push(args);
      return Effect.succeed(undefined);
    },
    getGuild: (...args: any[]) => {
      calls.getGuild.push(args);
      return Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: SYSTEM_CHANNEL_ID,
      });
    },
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

  return { calls, layer };
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

describe('handleStarted', () => {
  // -------------------------------------------------------------------------
  // T12.B — delete-on-start (safeDeleteClaim branch)
  // -------------------------------------------------------------------------

  // T12.B.1 — Training with claim stored → deleteMessage called once with correct ids
  it('T12.B.1: training with stored claim → deleteMessage called once', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(1);
    const [threadId, msgId] = restCalls.deleteMessage[0] as [string, string];
    expect(threadId).toBe(CLAIM_THREAD_ID);
    expect(msgId).toBe(CLAIM_MSG_ID);
  });

  // T12.B.2 — Training with no stored claim → deleteMessage NOT called
  it('T12.B.2: training with no stored claim → deleteMessage not called', async () => {
    // Default mock returns claim_discord_channel_id: Option.none()
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(0);
  });

  // T12.B.3 — deleteMessage returns 10008 Unknown Message → swallowed, handler resolves
  it('T12.B.3: deleteMessage returns 10008 → error swallowed, handler succeeds', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { layer: restLayer } = makeRecordingDiscordREST({
      deleteMessage: (..._args: any[]) =>
        // Simulate Discord "Unknown Message" error
        Effect.fail({
          _tag: 'ErrorResponse',
          data: { code: 10008 },
        }) as unknown as Effect.Effect<any>,
    });

    // Must resolve without throwing
    await expect(
      run(handleStarted(makeEvent({ event_type: 'training' })), Layer.merge(rpcLayer, restLayer)),
    ).resolves.not.toThrow();
  });

  // T12.B.4 — Non-training → GetClaimInfo and deleteMessage NOT called
  it('T12.B.4: non-training (match) → GetClaimInfo not called, deleteMessage not called', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ event_type: 'match' })), Layer.merge(rpcLayer, restLayer));

    expect(rpcCalls.GetClaimInfo).toHaveLength(0);
    expect(restCalls.deleteMessage).toHaveLength(0);
  });

  // T12.B.5 — Training, all-day → claim deletion still runs (deleteClaim does not
  // care about all_day; folded in here from the now-removed all-day-rendering
  // describe block, which otherwise had nothing left in it).
  it('T12.B.5: training all-day event with stored claim → deleteMessage called once', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc({
      'Event/GetClaimInfo': (_args: any) =>
        Effect.succeed(
          Option.some({
            event_id: EVENT_ID,
            event_type: 'training',
            status: 'active',
            claimed_by_member_id: Option.none(),
            claimed_by_display_name: Option.none(),
            claim_discord_channel_id: Option.some(CLAIM_THREAD_ID as any),
            claim_discord_message_id: Option.some(CLAIM_MSG_ID as any),
            claim_thread_id: Option.none(),
          }),
        ),
    });
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ all_day: true, event_type: 'training' })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.deleteMessage).toHaveLength(1);
    const [threadId, msgId] = restCalls.deleteMessage[0] as [string, string];
    expect(threadId).toBe(CLAIM_THREAD_ID);
    expect(msgId).toBe(CLAIM_MSG_ID);
  });
});

// ---------------------------------------------------------------------------
// The "Starting now" post is gone (Task 3 of the training-notifications-fix
// plan): `handleStarted` must not post anything to Discord, must not fetch
// the guild (it only needed that to resolve the removed post's channel /
// locale), and must not fetch yes-attendees (only the removed post's embed
// consumed them).
// ---------------------------------------------------------------------------

describe('handleStarted — no "Starting now" post', () => {
  it('makes zero createMessage calls for a timed event', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent({ all_day: false })), Layer.merge(rpcLayer, restLayer));

    expect(restCalls.createMessage).toHaveLength(0);
  });

  it('makes zero createMessage calls for an all-day event', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(
        makeEvent({
          all_day: true,
          start_at: DateTime.makeUnsafe('2026-07-14T22:00:00Z'),
          start_date: Option.some('2026-07-15'),
        }),
      ),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(0);
  });

  // Seeds `discord_channel_id: None` deliberately: the deleted `newPost` only fetched the
  // guild to resolve a system-channel fallback when no channel was configured. Against the
  // default event (channel present) this assertion would pass on the pre-change code too.
  it('never calls rest.getGuild, even with no channel configured', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.getGuild).toHaveLength(0);
  });

  it('never calls Event/GetYesAttendeesForEmbed', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingSyncRpc();
    const { layer: restLayer } = makeRecordingDiscordREST();

    await run(handleStarted(makeEvent()), Layer.merge(rpcLayer, restLayer));

    expect(rpcCalls.GetYesAttendeesForEmbed).toHaveLength(0);
  });
});
