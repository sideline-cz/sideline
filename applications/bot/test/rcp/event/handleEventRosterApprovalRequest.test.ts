// NOTE: TDD mode — tests will FAIL until handleEventRosterApprovalRequest
// and handleEventRosterApprovalCancel are implemented.

import type {
  Discord,
  Event,
  EventRosterModel,
  EventRpcEvents,
  RosterModel,
  TeamMember,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleEventRosterApprovalCancel } from '~/rcp/event/handleEventRosterApprovalCancel.js';
import { handleEventRosterApprovalRequest } from '~/rcp/event/handleEventRosterApprovalRequest.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as any;
const EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const EVENT_ROSTER_ID = 'event-roster-001' as EventRosterModel.EventRosterId;
const MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const OWNER_CHANNEL_ID = '222222222222222222' as Discord.Snowflake;
const THREAD_ID = '333333333333333333' as Discord.Snowflake;
const EXISTING_THREAD_ID = '444444444444444444' as Discord.Snowflake;
const MSG_ID = '555555555555555555' as Discord.Snowflake;
const WINNER_THREAD_ID = '666666666666666666' as Discord.Snowflake;
const DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factories
// ---------------------------------------------------------------------------

const makeApprovalRequestEvent = (
  overrides: Partial<EventRpcEvents.EventRosterApprovalRequestEvent> = {},
): EventRpcEvents.EventRosterApprovalRequestEvent =>
  ({
    _tag: 'event_roster_approval_request' as const,
    id: 'sync-001',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    event_id: EVENT_ID,
    event_roster_id: EVENT_ROSTER_ID,
    roster_id: ROSTER_ID,
    team_member_id: MEMBER_ID,
    candidate_discord_id: Option.some(DISCORD_USER_ID),
    candidate_display_name: Option.some('Alice'),
    title: 'Summer Tournament',
    start_at: DateTime.makeUnsafe('2099-07-01T10:00:00Z'),
    owners_thread_id: Option.none(),
    owner_channel_id: Option.some(OWNER_CHANNEL_ID),
    roster_name: Option.some('Tournament Squad'),
    ...overrides,
  }) as any;

const makeApprovalCancelEvent = (
  overrides: Partial<EventRpcEvents.EventRosterApprovalCancelEvent> = {},
): EventRpcEvents.EventRosterApprovalCancelEvent =>
  ({
    _tag: 'event_roster_approval_cancel' as const,
    id: 'sync-002',
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    event_id: EVENT_ID,
    owners_thread_id: Option.some(EXISTING_THREAD_ID),
    discord_message_id: Option.some(MSG_ID),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// REST mock builder
// ---------------------------------------------------------------------------

type RestCalls = {
  createThread: unknown[][];
  createMessage: unknown[][];
  deleteMessage: unknown[][];
  deleteChannel: unknown[][];
  editMessage: unknown[][];
};

const makeRecordingRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
) => {
  const calls: RestCalls = {
    createThread: [],
    createMessage: [],
    deleteMessage: [],
    deleteChannel: [],
    editMessage: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createThread: (...args: any[]) => {
      calls.createThread.push(args);
      return Effect.succeed({ id: THREAD_ID });
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: MSG_ID });
    },
    deleteMessage: (...args: any[]) => {
      calls.deleteMessage.push(args);
      return Effect.void;
    },
    deleteChannel: (...args: any[]) => {
      calls.deleteChannel.push(args);
      return Effect.void;
    },
    editMessage: (...args: any[]) => {
      calls.editMessage.push(args);
      return Effect.succeed({ id: MSG_ID });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        return fn ?? (() => Effect.void);
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// RPC mock builder
// ---------------------------------------------------------------------------

type RpcCalls = {
  SaveEventRosterThreadIfAbsent: unknown[][];
  SaveApprovalRequestMessageId: unknown[][];
  ClearEventRosterThread: unknown[][];
  MarkEventProcessed: unknown[][];
};

const makeRecordingRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: RpcCalls = {
    SaveEventRosterThreadIfAbsent: [],
    SaveApprovalRequestMessageId: [],
    ClearEventRosterThread: [],
    MarkEventProcessed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/SaveEventRosterThreadIfAbsent': (...args: any[]) => {
      calls.SaveEventRosterThreadIfAbsent.push(args);
      // Return None → this caller wins (no prior thread)
      return Effect.succeed(Option.none());
    },
    'Event/SaveApprovalRequestMessageId': (...args: any[]) => {
      calls.SaveApprovalRequestMessageId.push(args);
      return Effect.void;
    },
    'Event/ClearEventRosterThread': (...args: any[]) => {
      calls.ClearEventRosterThread.push(args);
      return Effect.void;
    },
    'Event/MarkEventProcessed': (...args: any[]) => {
      calls.MarkEventProcessed.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        return fn ?? (() => Effect.void);
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// handleEventRosterApprovalRequest tests
// ---------------------------------------------------------------------------

describe('handleEventRosterApprovalRequest', () => {
  it('no existing thread → createThread + SaveEventRosterThreadIfAbsent + createMessage + SaveApprovalRequestMessageId', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalRequestEvent({ owners_thread_id: Option.none() });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    expect(restCalls.createThread).toHaveLength(1);
    expect(rpcCalls.SaveEventRosterThreadIfAbsent).toHaveLength(1);
    expect(restCalls.createMessage).toHaveLength(1);
    expect(rpcCalls.SaveApprovalRequestMessageId).toHaveLength(1);
  });

  it('createMessage payload has allowed_mentions with parse:[]', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalRequestEvent({ owners_thread_id: Option.none() });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    expect(restCalls.createMessage.length).toBeGreaterThan(0);
    const [, payload] = restCalls.createMessage[0] as [string, any];
    // allowed_mentions.parse should be [] (suppress all mentions)
    const allowedMentions = payload?.allowed_mentions ?? payload?.payload?.allowed_mentions;
    if (allowedMentions) {
      expect(allowedMentions.parse).toEqual([]);
    }
  });

  it('existing thread → post to thread, no createThread call', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingRpc({
      // Return existing thread — SaveEventRosterThreadIfAbsent returns Some
      'Event/SaveEventRosterThreadIfAbsent': (...args: any[]) => {
        rpcCalls.SaveEventRosterThreadIfAbsent.push(args);
        return Effect.succeed(Option.some(EXISTING_THREAD_ID));
      },
    });

    const event = makeApprovalRequestEvent({
      owners_thread_id: Option.some(EXISTING_THREAD_ID),
    });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    expect(restCalls.createThread).toHaveLength(0);
    expect(restCalls.createMessage).toHaveLength(1);
  });

  it('lost save race → delete orphan thread, use winner thread id', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();

    // Simulate: we create thread THREAD_ID, but SaveEventRosterThreadIfAbsent
    // returns WINNER_THREAD_ID → we lost the race, must delete our orphan
    const rpcCalls: RpcCalls = {
      SaveEventRosterThreadIfAbsent: [],
      SaveApprovalRequestMessageId: [],
      ClearEventRosterThread: [],
      MarkEventProcessed: [],
    };

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'Event/SaveEventRosterThreadIfAbsent') {
            return (...args: any[]) => {
              rpcCalls.SaveEventRosterThreadIfAbsent.push(args);
              // Returns a different (winning) thread id
              return Effect.succeed(Option.some(WINNER_THREAD_ID));
            };
          }
          if (prop === 'Event/SaveApprovalRequestMessageId') {
            return (...args: any[]) => {
              rpcCalls.SaveApprovalRequestMessageId.push(args);
              return Effect.void;
            };
          }
          return () => Effect.void;
        },
      }),
    );

    const event = makeApprovalRequestEvent({ owners_thread_id: Option.none() });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    // Orphan (THREAD_ID) should be deleted
    expect(restCalls.deleteChannel).toHaveLength(1);
    // Message should be posted in the winner thread
    expect(restCalls.createMessage).toHaveLength(1);
    const [channelArg] = restCalls.createMessage[0] as [string, ...unknown[]];
    expect(channelArg).toBe(WINNER_THREAD_ID);
  });

  it('10003 (Unknown Channel) on createMessage → ClearEventRosterThread + recreate thread + retry once', async () => {
    let createMessageCallCount = 0;
    const { calls: restCalls, layer: restLayer } = makeRecordingRest({
      createThread: (...args: any[]) => {
        restCalls.createThread.push(args);
        return Effect.succeed({ id: THREAD_ID });
      },
      createMessage: (...args: any[]) => {
        createMessageCallCount++;
        restCalls.createMessage.push(args);
        if (createMessageCallCount === 1) {
          // First attempt: Unknown Channel (10003)
          return Effect.fail({
            _tag: 'ErrorResponse',
            response: { status: 404 },
            error: { code: 10003 },
          } as any);
        }
        return Effect.succeed({ id: MSG_ID });
      },
    });

    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalRequestEvent({ owners_thread_id: Option.none() });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    // Should have cleared thread and tried again
    expect(rpcCalls.ClearEventRosterThread).toHaveLength(1);
    // Second createThread for the retry
    expect(restCalls.createThread.length).toBeGreaterThanOrEqual(2);
    // createMessage should have been called twice (once failed, once succeeded)
    expect(restCalls.createMessage.length).toBeGreaterThanOrEqual(2);
  });

  it('no owner channel → skip (no createThread, no createMessage)', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalRequestEvent({
      owner_channel_id: Option.none(),
    });

    await Effect.runPromise(
      handleEventRosterApprovalRequest(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ),
    );

    expect(restCalls.createThread).toHaveLength(0);
    expect(restCalls.createMessage).toHaveLength(0);
    expect(rpcCalls.SaveEventRosterThreadIfAbsent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleEventRosterApprovalCancel tests
// ---------------------------------------------------------------------------

describe('handleEventRosterApprovalCancel', () => {
  it('message + thread present → deleteMessage called', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalCancelEvent({
      owners_thread_id: Option.some(EXISTING_THREAD_ID),
      discord_message_id: Option.some(MSG_ID),
    });

    await Effect.runPromise(
      handleEventRosterApprovalCancel(event).pipe(Effect.provide(Layer.merge(restLayer, rpcLayer))),
    );

    expect(restCalls.deleteMessage).toHaveLength(1);
  });

  it('10008 (Unknown Message) on deleteMessage → swallowed, no throw', async () => {
    const { layer: restLayer } = makeRecordingRest({
      deleteMessage: (..._args: any[]) =>
        Effect.fail({
          _tag: 'ErrorResponse',
          response: { status: 404 },
          error: { code: 10008 },
        } as any),
    });
    const { layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalCancelEvent({
      owners_thread_id: Option.some(EXISTING_THREAD_ID),
      discord_message_id: Option.some(MSG_ID),
    });

    // Should not throw
    await expect(
      Effect.runPromise(
        handleEventRosterApprovalCancel(event).pipe(
          Effect.provide(Layer.merge(restLayer, rpcLayer)),
        ),
      ),
    ).resolves.toBeUndefined();
  });

  it('missing thread_id → no-op (no deleteMessage)', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalCancelEvent({
      owners_thread_id: Option.none(),
      discord_message_id: Option.some(MSG_ID),
    });

    await Effect.runPromise(
      handleEventRosterApprovalCancel(event).pipe(Effect.provide(Layer.merge(restLayer, rpcLayer))),
    );

    expect(restCalls.deleteMessage).toHaveLength(0);
  });

  it('missing message_id → no-op (no deleteMessage)', async () => {
    const { calls: restCalls, layer: restLayer } = makeRecordingRest();
    const { layer: rpcLayer } = makeRecordingRpc();

    const event = makeApprovalCancelEvent({
      owners_thread_id: Option.some(EXISTING_THREAD_ID),
      discord_message_id: Option.none(),
    });

    await Effect.runPromise(
      handleEventRosterApprovalCancel(event).pipe(Effect.provide(Layer.merge(restLayer, rpcLayer))),
    );

    expect(restCalls.deleteMessage).toHaveLength(0);
  });
});
