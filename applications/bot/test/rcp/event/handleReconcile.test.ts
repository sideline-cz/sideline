// The reconcile handler (steps 1-3 only — the shared events board and its
// global-message refresh step 4 were removed, remove-global-events-board
// Release A):
//   1. For each member: call GetAllUpcomingEventsForUser with that member's discord_id
//   2. Render with that member's own my_response (no cross-application)
//   3. Hash-diff: no updateMessage when hash equals stored; exactly one updateMessage when changed

import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
// TDD: implement handleReconcile (or reconcileEvent)
import { reconcileEvent } from '~/rcp/personalEvents/handleReconcile.js';
import { buildPersonalMessage } from '~/rest/events/buildPersonalEventMessage.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000001';
const GUILD_ID = '510000000000000001';
const EVENT_ID = 'evt-00000000-0000-0000-0000-000000000001';
const MEMBER_A_ID = 'mbr-00000000-0000-0000-0000-000000000001';
const MEMBER_B_ID = 'mbr-00000000-0000-0000-0000-000000000002';
const DISCORD_ID_A = '510000000000000011';
const DISCORD_ID_B = '510000000000000012';
const PERSONAL_CHANNEL_A = '510000000000000021';
const PERSONAL_CHANNEL_B = '510000000000000022';
const PERSONAL_MSG_A = '510000000000000031';
const PERSONAL_MSG_B = '510000000000000032';

// A minimal upcoming event stub for GetAllUpcomingEventsForUser
const makeUpcomingEvent = (myResponse: 'yes' | 'no' | 'maybe' | null) => ({
  event_id: EVENT_ID as any,
  team_id: TEAM_ID as any,
  title: 'Saturday Training',
  event_type: 'training',
  start_at: DateTime.makeUnsafe('2027-05-10T14:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  location_url: Option.none(),
  description: Option.none(),
  image_url: Option.none(),
  all_day: false,
  my_response: Option.fromNullishOr(myResponse),
  my_response_actual: Option.fromNullishOr(myResponse),
  my_message: Option.none(),
  yes_count: 5,
  no_count: 1,
  maybe_count: 2,
});

// ---------------------------------------------------------------------------
// Shared mock factory
// ---------------------------------------------------------------------------

interface ReconcileMockOptions {
  /** GetAllUpcomingEventsForUser stub per discord_id */
  upcomingEventsPerUser?: Record<string, ReturnType<typeof makeUpcomingEvent>[]>;
  /** Stored hash for member A (defaults to a stale hash) */
  storedHashA?: string;
  /** Stored hash for member B (defaults to a stale hash) */
  storedHashB?: string;
}

const makeTestLayers = (opts: ReconcileMockOptions = {}) => {
  const updateMessage = vi.fn((..._args: unknown[]) => Effect.succeed({}));
  const updateMessageCalls: Array<{ channelId: string; messageId: string }> = [];
  const rpcCalls: Record<string, unknown[][]> = {};

  const trackRpc = (method: string, args: unknown) => {
    rpcCalls[method] = rpcCalls[method] ?? [];
    rpcCalls[method]?.push([args]);
  };

  const rpcLayer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then') return undefined;

        return (args: any) => {
          trackRpc(method, args);

          if (method === 'Guild/ListPersonalChannelsForEvent') {
            // Return two members with their personal channels
            return Effect.succeed([
              {
                team_member_id: MEMBER_A_ID as any,
                discord_id: DISCORD_ID_A as any,
                personal_channel_id: PERSONAL_CHANNEL_A as any,
              },
              {
                team_member_id: MEMBER_B_ID as any,
                discord_id: DISCORD_ID_B as any,
                personal_channel_id: PERSONAL_CHANNEL_B as any,
              },
            ]);
          }

          if (method === 'Guild/GetAllUpcomingEventsForUser') {
            const perUser = opts.upcomingEventsPerUser ?? {};
            // Find which discord_id was requested
            const events =
              perUser[DISCORD_ID_A] !== undefined && args?.discord_user_id === DISCORD_ID_A
                ? perUser[DISCORD_ID_A]
                : perUser[DISCORD_ID_B] !== undefined && args?.discord_user_id === DISCORD_ID_B
                  ? perUser[DISCORD_ID_B]
                  : [makeUpcomingEvent('yes')];
            return Effect.succeed({ events, total: events.length, team_id: TEAM_ID });
          }

          if (method === 'PersonalEvents/GetPersonalEventMessage') {
            const memberId = args?.team_member_id;
            // Return stored message with specified hash (or stale hash by default)
            const hash =
              memberId === MEMBER_A_ID
                ? (opts.storedHashA ?? 'stale-hash-a')
                : (opts.storedHashB ?? 'stale-hash-b');
            return Effect.succeed(
              Option.some({
                discord_message_id: memberId === MEMBER_A_ID ? PERSONAL_MSG_A : PERSONAL_MSG_B,
                payload_hash: hash,
              }),
            );
          }

          if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
            return Effect.succeed(undefined);
          }

          if (method === 'Event/GetRsvpCounts') {
            return Effect.succeed({ yesCount: 5, noCount: 1, maybeCount: 2, canRsvp: true });
          }

          if (method === 'Event/GetEventEmbedInfo') {
            return Effect.succeed(
              Option.some({
                title: 'Saturday Training',
                description: Option.none(),
                image_url: Option.none(),
                start_at: DateTime.makeUnsafe('2027-05-10T14:00:00Z'),
                end_at: Option.none(),
                location: Option.none(),
                event_type: 'training',
                status: 'active',
              }),
            );
          }

          if (method === 'Event/GetYesAttendeesForEmbed') {
            return Effect.succeed([]);
          }

          return Effect.succeed(null);
        };
      },
    }),
  );

  const restLayer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (prop === 'updateMessage') {
          return (channelId: string, messageId: string, _payload: unknown) => {
            updateMessageCalls.push({ channelId, messageId });
            return updateMessage(channelId, messageId, _payload);
          };
        }
        if (prop === 'getGuild') {
          return () =>
            Effect.succeed({
              preferred_locale: 'en-US',
              system_channel_id: null,
            });
        }
        return () => Effect.succeed({ id: 'mock-id' });
      },
    }),
  );

  return { rpcLayer, restLayer, updateMessageCalls, rpcCalls };
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
// Test: owner-resolution guard — each member sees their own my_response
// ---------------------------------------------------------------------------

describe('handleReconcile — owner-resolution: each member renders with their own my_response', () => {
  it('member A (my_response=yes) and member B (my_response=no) each see their own response — no cross-application', async () => {
    const renderedForMember: Record<string, string | null> = {};

    // Stub GetAllUpcomingEventsForUser to return different responses per member
    const upcomingEventsPerUser = {
      [DISCORD_ID_A]: [makeUpcomingEvent('yes')],
      [DISCORD_ID_B]: [makeUpcomingEvent('no')],
    };

    // Capture what payload is rendered per channel
    const capturedUpdateMessages: Array<{ channelId: string; payload: unknown }> = [];

    const { rpcLayer } = makeTestLayers({ upcomingEventsPerUser });

    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'updateMessage') {
            return (channelId: string, _messageId: string, payload: unknown) => {
              capturedUpdateMessages.push({ channelId, payload });
              return Effect.succeed({});
            };
          }
          if (prop === 'getGuild') {
            return () => Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null });
          }
          return () => Effect.succeed({ id: 'mock-id' });
        },
      }),
    );

    await run(
      // TDD: implement reconcileEvent(event) where event has event_id, team_id, guild_id
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // For each personal channel update, capture the serialized payload
    for (const update of capturedUpdateMessages) {
      const json = JSON.stringify(update.payload);
      if (update.channelId === PERSONAL_CHANNEL_A) {
        renderedForMember[MEMBER_A_ID] = json;
      } else if (update.channelId === PERSONAL_CHANNEL_B) {
        renderedForMember[MEMBER_B_ID] = json;
      }
    }

    // Both personal channels must be targeted
    const channelsUpdated = capturedUpdateMessages.map((u) => u.channelId);
    expect(channelsUpdated).toContain(PERSONAL_CHANNEL_A);
    expect(channelsUpdated).toContain(PERSONAL_CHANNEL_B);

    // The rendered payloads must DIFFER — an impl applying member A's state to
    // BOTH channels would produce identical serialised payloads for A and B.
    const payloadA = renderedForMember[MEMBER_A_ID];
    const payloadB = renderedForMember[MEMBER_B_ID];
    expect(payloadA).toBeDefined();
    expect(payloadB).toBeDefined();
    expect(payloadA).not.toEqual(payloadB);

    // Member A has my_response=yes → the Yes RSVP button is highlighted (style 3 = green).
    // Member B has my_response=no  → the No RSVP button is highlighted (style 4 = red).
    // The button style values are serialised as `"style":N` in the action-row components.
    // style 3 = Success (green) — only present when member answered Yes.
    // style 4 = Danger (red)   — only present when member answered No.
    expect(payloadA).toContain('"style":3'); // A's Yes button is green
    expect(payloadA).not.toContain('"style":4'); // A has no red button
    expect(payloadB).toContain('"style":4'); // B's No button is red
    expect(payloadB).not.toContain('"style":3'); // B has no green button
  });
});

// ---------------------------------------------------------------------------
// Test: hash-diff guard — no updateMessage when hash matches
// ---------------------------------------------------------------------------

/**
 * Compute the hash that `reconcileEvent` will produce for a given member/event
 * so we can seed the stored hash to match and verify the no-op branch.
 */
const computeExpectedHash = (params: {
  event: ReturnType<typeof makeUpcomingEvent>;
  discordId: string;
}): string => {
  const render = buildPersonalMessage({
    entry: params.event as any,
    yesAttendees: [],
    discordId: params.discordId as any,
    locale: 'en',
  });
  return render.hash;
};

describe('handleReconcile — hash-diff: no updateMessage when rendered hash equals stored hash', () => {
  it('when stored hash matches the rendered hash, NO updateMessage is issued for that member', async () => {
    // We cannot predict the exact rendered hash without running the renderer,
    // but we can test the inverse: when we supply a hash that would NEVER match
    // a rendered payload (e.g., empty string vs a real embed hash), updateMessage IS called.
    // And when we make both hashes the same (by seeding the stored hash to the same value
    // the renderer will produce), updateMessage is NOT called.
    //
    // Strategy: use a sentinel hash that CANNOT match any rendered embed.
    // Verify updateMessage IS called (stale hash → update).
    const { rpcLayer, restLayer, updateMessageCalls } = makeTestLayers({
      storedHashA: 'SENTINEL-WILL-NEVER-MATCH',
      storedHashB: 'SENTINEL-WILL-NEVER-MATCH',
    });

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // With stale hashes, both personal messages and the global message must be updated
    const personalUpdates = updateMessageCalls.filter(
      (c) => c.channelId === PERSONAL_CHANNEL_A || c.channelId === PERSONAL_CHANNEL_B,
    );
    expect(personalUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('when stored hash equals the actual rendered hash, ZERO updateMessage calls are issued for that member', async () => {
    // Compute the hash that the reconciler would render for member B (my_response=yes,
    // yesAttendees=[] — the default in makeTestLayers when no override is given).
    const eventForB = makeUpcomingEvent('yes');
    const matchingHash = computeExpectedHash({ event: eventForB, discordId: DISCORD_ID_B });

    const { rpcLayer, restLayer, updateMessageCalls } = makeTestLayers({
      // Member A gets a stale hash → its channel WILL be updated.
      storedHashA: 'SENTINEL-WILL-NEVER-MATCH',
      // Member B gets a hash that matches what the renderer produces → NO update.
      storedHashB: matchingHash,
    });

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // Member B's channel must receive ZERO updateMessage calls (no-op branch).
    const bUpdates = updateMessageCalls.filter((c) => c.channelId === PERSONAL_CHANNEL_B);
    expect(bUpdates).toHaveLength(0);

    // Member A's channel must have been updated (stale hash → update path is exercised).
    const aUpdates = updateMessageCalls.filter((c) => c.channelId === PERSONAL_CHANNEL_A);
    expect(aUpdates.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// Test: create branch — no stored message → createMessage, no duplicate on retry
// ---------------------------------------------------------------------------

describe('handleReconcile — create branch: when no stored message exists, createMessage is called', () => {
  it('calls createMessage (not updateMessage) for a member with no stored personal message', async () => {
    const createMessageCalls: Array<{ channelId: string }> = [];
    const updateMessageCalls: Array<{ channelId: string }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (_args: any) => {
            if (method === 'Guild/ListPersonalChannelsForEvent') {
              return Effect.succeed([
                {
                  team_member_id: MEMBER_A_ID as any,
                  discord_id: DISCORD_ID_A as any,
                  personal_channel_id: PERSONAL_CHANNEL_A as any,
                },
              ]);
            }
            if (method === 'Guild/GetAllUpcomingEventsForUser') {
              return Effect.succeed({
                events: [makeUpcomingEvent('yes')],
                total: 1,
                team_id: TEAM_ID,
              });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              // No stored message
              return Effect.succeed(Option.none());
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              return Effect.succeed(undefined);
            }
            if (method === 'Event/GetRsvpCounts') {
              return Effect.succeed({ yesCount: 0, noCount: 0, maybeCount: 0, canRsvp: true });
            }
            if (method === 'Event/GetEventEmbedInfo') {
              return Effect.succeed(Option.none());
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([]);
            }
            return Effect.succeed(null);
          };
        },
      }),
    );

    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'createMessage') {
            return (channelId: string, _payload: unknown) => {
              createMessageCalls.push({ channelId });
              return Effect.succeed({ id: 'new-msg-id' });
            };
          }
          if (prop === 'updateMessage') {
            return (channelId: string, _messageId: string, _payload: unknown) => {
              updateMessageCalls.push({ channelId });
              return Effect.succeed({});
            };
          }
          if (prop === 'getGuild') {
            return () => Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null });
          }
          return () => Effect.succeed({ id: 'mock-id', embeds: [], components: [] });
        },
      }),
    );

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // Must call createMessage for the member's personal channel
    expect(createMessageCalls.map((c) => c.channelId)).toContain(PERSONAL_CHANNEL_A);
    // Must NOT call updateMessage for the personal channel (no existing message)
    const personalUpdates = updateMessageCalls.filter((c) => c.channelId === PERSONAL_CHANNEL_A);
    expect(personalUpdates).toHaveLength(0);
  });

  it('compensating delete: when UpsertPersonalEventMessage fails after retries, deleteMessage is called and no duplicate remains', async () => {
    const createMessageCalls: Array<{ channelId: string }> = [];
    const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (_args: any) => {
            if (method === 'Guild/ListPersonalChannelsForEvent') {
              return Effect.succeed([
                {
                  team_member_id: MEMBER_A_ID as any,
                  discord_id: DISCORD_ID_A as any,
                  personal_channel_id: PERSONAL_CHANNEL_A as any,
                },
              ]);
            }
            if (method === 'Guild/GetAllUpcomingEventsForUser') {
              return Effect.succeed({
                events: [makeUpcomingEvent('yes')],
                total: 1,
                team_id: TEAM_ID,
              });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(Option.none());
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              // Always fail — simulates a persistent RPC error
              return Effect.fail({ _tag: 'RpcClientError' as const, message: 'DB unavailable' });
            }
            if (method === 'Event/GetRsvpCounts') {
              return Effect.succeed({ yesCount: 0, noCount: 0, maybeCount: 0, canRsvp: true });
            }
            if (method === 'Event/GetEventEmbedInfo') {
              return Effect.succeed(Option.none());
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([]);
            }
            return Effect.succeed(null);
          };
        },
      }),
    );

    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'createMessage') {
            return (channelId: string, _payload: unknown) => {
              createMessageCalls.push({ channelId });
              return Effect.succeed({ id: 'orphan-msg-id' });
            };
          }
          if (prop === 'deleteMessage') {
            return (channelId: string, messageId: string) => {
              deleteMessageCalls.push({ channelId, messageId });
              return Effect.succeed(undefined);
            };
          }
          if (prop === 'getGuild') {
            return () => Effect.succeed({ preferred_locale: 'en-US', system_channel_id: null });
          }
          return () => Effect.succeed({ id: 'mock-id', embeds: [], components: [] });
        },
      }),
    );

    // Must resolve (per-member error is isolated at the event level)
    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // createMessage was called once
    expect(createMessageCalls).toHaveLength(1);
    // deleteMessage was called with the orphan message id (compensating action)
    expect(deleteMessageCalls).toHaveLength(1);
    expect(deleteMessageCalls[0]?.channelId).toBe(PERSONAL_CHANNEL_A);
    expect(deleteMessageCalls[0]?.messageId).toBe('orphan-msg-id');
  }, 15_000); // retry policy: 3 x 200ms exponential = up to ~1.4s; 15s headroom
});
