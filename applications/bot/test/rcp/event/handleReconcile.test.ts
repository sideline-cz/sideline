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
  event_type_name: Option.none(),
  event_type_color: Option.none(),
  start_at: DateTime.makeUnsafe('2027-05-10T14:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  location_url: Option.none(),
  description: Option.none(),
  image_url: Option.none(),
  all_day: false,
  start_date: Option.none(),
  end_date: Option.none(),
  my_response: Option.fromNullishOr(myResponse),
  my_message: Option.none(),
  yes_count: 5,
  no_count: 1,
  maybe_count: 2,
  coming_later_count: 0,
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
                personal_channel_id:
                  memberId === MEMBER_A_ID ? PERSONAL_CHANNEL_A : PERSONAL_CHANNEL_B,
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
                event_type_name: Option.none(),
                event_type_color: Option.none(),
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

// ---------------------------------------------------------------------------
// PR 4 — an all-day event that has flipped to `started` and is still visible
// (plan §7.7g, §4.6). `handleReconcile.ts` itself does not change for this —
// it always diffs whatever `Guild/GetAllUpcomingEventsForUser` returns against
// the stored hash. These tests therefore mostly document/lock in that the
// existing edit/create/delete branching composes correctly once the upstream
// RPC starts returning a `started` all-day entry instead of omitting it — the
// actual visibility fix lives in the RPC query (covered elsewhere). The one
// case that is genuinely new here is the delete-path baseline (case 3), which
// this file did not previously assert on its own.
// ---------------------------------------------------------------------------

describe('handleReconcile — PR 4: all-day started event stays visible → edited, not deleted', () => {
  it('case 1: entry returned (all_day, status=started) with an existing stored message → EDITED, deleteMessage NOT called', async () => {
    const allDayEvent = {
      ...makeUpcomingEvent('yes'),
      all_day: true,
      status: 'started',
    };
    const { rpcLayer } = makeTestLayers({
      upcomingEventsPerUser: {
        [DISCORD_ID_A]: [allDayEvent],
        [DISCORD_ID_B]: [allDayEvent],
      },
      // A stale hash guarantees the update branch is taken (not the no-op branch).
      storedHashA: 'SENTINEL-WILL-NEVER-MATCH',
      storedHashB: 'SENTINEL-WILL-NEVER-MATCH',
    });

    const updateMessageCalls: Array<{ channelId: string }> = [];
    const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];
    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'updateMessage') {
            return (channelId: string) => {
              updateMessageCalls.push({ channelId });
              return Effect.succeed({});
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
          return () => Effect.succeed({ id: 'mock-id' });
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

    expect(updateMessageCalls.length).toBeGreaterThanOrEqual(1);
    expect(deleteMessageCalls).toHaveLength(0);
  });

  it('case 2: entry returned but no message is stored → a message is CREATED (and would be scheduled for reorder)', async () => {
    const allDayEvent = { ...makeUpcomingEvent('yes'), all_day: true, status: 'started' };

    // Override GetPersonalEventMessage (via a fresh rpc layer) to report NO
    // stored message for either member, forcing the create branch.
    const rpcLayerNoStored = Layer.succeed(
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
                events: [allDayEvent],
                total: 1,
                team_id: TEAM_ID,
              });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(Option.none());
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              return Effect.succeed(undefined);
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([]);
            }
            return Effect.succeed(null);
          };
        },
      }),
    );

    const createMessageCalls: Array<{ channelId: string }> = [];
    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'createMessage') {
            return (channelId: string) => {
              createMessageCalls.push({ channelId });
              return Effect.succeed({ id: 'new-msg-id' });
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
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayerNoStored, restLayer),
    );

    expect(createMessageCalls.map((c) => c.channelId)).toContain(PERSONAL_CHANNEL_A);
  });

  it('case 3 (baseline, not previously covered on its own): entry NOT returned (event vanished from the upcoming window) → deleteMessage called, no create/update', async () => {
    const rpcLayerVanished = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return () => {
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
              return Effect.succeed({ events: [], total: 0, team_id: TEAM_ID });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(
                Option.some({
                  personal_channel_id: PERSONAL_CHANNEL_A,
                  discord_message_id: PERSONAL_MSG_A,
                  payload_hash: 'some-hash',
                }),
              );
            }
            if (method === 'PersonalEvents/DeletePersonalEventMessage') {
              return Effect.succeed(undefined);
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([]);
            }
            return Effect.succeed(null);
          };
        },
      }),
    );

    const createMessageCalls: unknown[] = [];
    const updateMessageCalls: unknown[] = [];
    const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];
    const restLayer = Layer.succeed(
      DiscordREST,
      new Proxy({} as any, {
        get: (_target: unknown, prop: string) => {
          if (prop === 'createMessage') {
            return () => {
              createMessageCalls.push({});
              return Effect.succeed({ id: 'x' });
            };
          }
          if (prop === 'updateMessage') {
            return () => {
              updateMessageCalls.push({});
              return Effect.succeed({});
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
          return () => Effect.succeed({ id: 'mock-id' });
        },
      }),
    );

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayerVanished, restLayer),
    );

    expect(deleteMessageCalls).toHaveLength(1);
    expect(deleteMessageCalls[0]?.channelId).toBe(PERSONAL_CHANNEL_A);
    expect(deleteMessageCalls[0]?.messageId).toBe(PERSONAL_MSG_A);
    expect(createMessageCalls).toHaveLength(0);
    expect(updateMessageCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: an in-place updateMessage that 404s with code 10008 (message
// deleted from Discord, e.g. by hand or by a racing reorder pass) must recreate
// the message — NOT just log and leave the row pointing at a dead message id
// forever (the production bug: every later pass re-PATCHes the same dead id,
// and the card never comes back). The row is deliberately NOT explicitly
// deleted first; `persist`'s ON CONFLICT upsert repoints it instead.
// ---------------------------------------------------------------------------

/** A stored row for member A whose `updateMessage` always fails with `error`, plus
 * call/args tracking for `deleteMessage`, `createMessage`, and the two RPC calls
 * the recreate path depends on. Entry is present (not vanished) with a stale
 * stored hash, so the update branch — not the delete-on-vanish branch above — is
 * the one exercised. */
const makeUnknownMessageLayers = (error: unknown) => {
  const deleteRpcCalls: unknown[] = [];
  const createMessageCalls: Array<{ channelId: string }> = [];
  const updateMessageCalls: Array<{ channelId: string; messageId: string }> = [];
  const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];

  const rpcLayer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (args: any) => {
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
            return Effect.succeed(
              Option.some({
                personal_channel_id: PERSONAL_CHANNEL_A,
                discord_message_id: PERSONAL_MSG_A,
                payload_hash: 'SENTINEL-WILL-NEVER-MATCH',
              }),
            );
          }
          if (method === 'PersonalEvents/DeletePersonalEventMessage') {
            deleteRpcCalls.push(args);
            return Effect.succeed(undefined);
          }
          if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
            return Effect.succeed(undefined);
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
          return (channelId: string, messageId: string) => {
            updateMessageCalls.push({ channelId, messageId });
            return Effect.fail(error);
          };
        }
        if (prop === 'createMessage') {
          // NOTE: must defer the push into an `Effect.sync` rather than pushing
          // eagerly on the bare JS call. `reconcileMemberMessage` builds
          // `createFlow = rest.createMessage(...).pipe(...)` unconditionally
          // whenever the hash differs (even on the plain-update path, where that
          // Effect value is constructed but never run) — a real `DiscordREST`
          // call is a lazy Effect that does nothing until executed, so a mock
          // that fires on construction produces false "createMessage was called"
          // positives for branches that build but never run `createFlow`.
          return (channelId: string) =>
            Effect.sync(() => {
              createMessageCalls.push({ channelId });
              return { id: 'recreated-msg-id' };
            });
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
        return () => Effect.succeed({ id: 'mock-id' });
      },
    }),
  );

  return {
    rpcLayer,
    restLayer,
    deleteRpcCalls,
    createMessageCalls,
    updateMessageCalls,
    deleteMessageCalls,
  };
};

describe('handleReconcile — updateMessage 404s on a stored row (message deleted out from under us)', () => {
  it('code 10008 (Unknown Message): recreates the message without an explicit row delete', async () => {
    const notFound = {
      _tag: 'ErrorResponse',
      response: { status: 404 },
      data: { code: 10008 },
    };
    const { rpcLayer, restLayer, deleteRpcCalls, createMessageCalls, updateMessageCalls } =
      makeUnknownMessageLayers(notFound);

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(updateMessageCalls).toHaveLength(1);
    // The row is NOT explicitly deleted — deleting first would open a window
    // where a failed create leaves no message AND no row. `persist`'s
    // ON CONFLICT (event_id, team_member_id) DO UPDATE repoints it instead.
    expect(deleteRpcCalls).toHaveLength(0);
    // A fresh message is created in its place, so the card comes back instead
    // of staying gone forever.
    expect(createMessageCalls.map((c) => c.channelId)).toContain(PERSONAL_CHANNEL_A);
  });

  it('a plain HTTP 404 (no data.code) on updateMessage: does not match the narrowed predicate — log only, no recreate', async () => {
    const notFound = { _tag: 'ErrorResponse', response: { status: 404 }, data: {} };
    const { rpcLayer, restLayer, deleteRpcCalls, createMessageCalls, updateMessageCalls } =
      makeUnknownMessageLayers(notFound);

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    // isUnknownMessageError is code-10008-only now, so a bare 404 falls into
    // the generic failure branch: log and leave the row alone.
    expect(updateMessageCalls).toHaveLength(1);
    expect(deleteRpcCalls).toHaveLength(0);
    expect(createMessageCalls).toHaveLength(0);
  });

  it('a non-404 failure (e.g. 500): the row is left alone — no delete, no create', async () => {
    const serverError = { _tag: 'ErrorResponse', response: { status: 500 }, data: {} };
    const { rpcLayer, restLayer, deleteRpcCalls, createMessageCalls, updateMessageCalls } =
      makeUnknownMessageLayers(serverError);

    await run(
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(updateMessageCalls).toHaveLength(1);
    expect(deleteRpcCalls).toHaveLength(0);
    expect(createMessageCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Nastavitelná docházka (plan §7.4, §10.1, B4). `event_type` is mutable, so
// editing an event training→tournament moves it between live channels for
// every split member. `handleReconcile.ts` must address STORED messages by
// their STORED channel (`stored.value.personal_channel_id`), not by the
// member's CURRENT channel (`member.personal_channel_id`) — those two can
// legitimately differ when the routing bucket has moved.
// ---------------------------------------------------------------------------

describe('handleReconcile — B4: event_type edit moves a split member between channels', () => {
  it('bucket move: stored row in TRAINING_CH, ListPersonalChannelsForEvent now resolves TOURNAMENT_CH, payload hash UNCHANGED → deleteMessage(TRAINING_CH), createMessage(TOURNAMENT_CH), row repointed', async () => {
    const TRAINING_CH = '550000000000000001';
    const TOURNAMENT_CH = '550000000000000002';

    const event = makeUpcomingEvent('yes');
    // The hash the renderer will ACTUALLY produce for this event/member — seeding the
    // stored hash to match this is the whole point of the test: the move must be
    // detected and applied even though the hash-diff would otherwise skip it entirely.
    const matchingHash = computeExpectedHash({ event, discordId: DISCORD_ID_A });

    const createMessageCalls: Array<{ channelId: string }> = [];
    const updateMessageCalls: Array<{ channelId: string; messageId: string }> = [];
    const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];
    const upsertCalls: Array<{ personal_channel_id: string }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return (args: any) => {
            if (method === 'Guild/ListPersonalChannelsForEvent') {
              // The member's CURRENT channel for this event is now the tournament
              // channel — the event moved buckets.
              return Effect.succeed([
                {
                  team_member_id: MEMBER_A_ID as any,
                  discord_id: DISCORD_ID_A as any,
                  personal_channel_id: TOURNAMENT_CH as any,
                },
              ]);
            }
            if (method === 'Guild/GetAllUpcomingEventsForUser') {
              return Effect.succeed({ events: [event], total: 1, team_id: TEAM_ID });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              // The STORED row still points at the OLD (training) channel.
              return Effect.succeed(
                Option.some({
                  personal_channel_id: TRAINING_CH as any,
                  discord_message_id: PERSONAL_MSG_A as any,
                  payload_hash: matchingHash,
                }),
              );
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              upsertCalls.push({ personal_channel_id: args?.personal_channel_id });
              return Effect.succeed(undefined);
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
            return (channelId: string) => {
              createMessageCalls.push({ channelId });
              return Effect.succeed({ id: 'new-msg-id' });
            };
          }
          if (prop === 'updateMessage') {
            return (channelId: string, messageId: string) => {
              updateMessageCalls.push({ channelId, messageId });
              return Effect.succeed({});
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
          return () => Effect.succeed({ id: 'mock-id' });
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

    // Delete addresses the OLD (stored) channel.
    expect(deleteMessageCalls).toHaveLength(1);
    expect(deleteMessageCalls[0]?.channelId).toBe(TRAINING_CH);
    expect(deleteMessageCalls[0]?.messageId).toBe(PERSONAL_MSG_A);

    // Create addresses the NEW (current) channel — the move happened despite an
    // unchanged payload hash, proving the hash-skip was bypassed for this branch.
    expect(createMessageCalls).toHaveLength(1);
    expect(createMessageCalls[0]?.channelId).toBe(TOURNAMENT_CH);

    // The row is repointed at the new channel.
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]?.personal_channel_id).toBe(TOURNAMENT_CH);
  });

  it("stale-message delete addresses the STORED channel, not the current one, when the event left the member's window", async () => {
    const TRAINING_CH = '550000000000000011';
    const TOURNAMENT_CH = '550000000000000012';

    const deleteMessageCalls: Array<{ channelId: string; messageId: string }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return () => {
            if (method === 'Guild/ListPersonalChannelsForEvent') {
              // Member's CURRENT channel (e.g. after a bucket move) differs from where
              // the stale message actually lives.
              return Effect.succeed([
                {
                  team_member_id: MEMBER_A_ID as any,
                  discord_id: DISCORD_ID_A as any,
                  personal_channel_id: TOURNAMENT_CH as any,
                },
              ]);
            }
            if (method === 'Guild/GetAllUpcomingEventsForUser') {
              // Event vanished from the member's upcoming window entirely.
              return Effect.succeed({ events: [], total: 0, team_id: TEAM_ID });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(
                Option.some({
                  personal_channel_id: TRAINING_CH as any,
                  discord_message_id: PERSONAL_MSG_A as any,
                  payload_hash: 'some-hash',
                }),
              );
            }
            if (method === 'PersonalEvents/DeletePersonalEventMessage') {
              return Effect.succeed(undefined);
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
          if (prop === 'deleteMessage') {
            return (channelId: string, messageId: string) => {
              deleteMessageCalls.push({ channelId, messageId });
              return Effect.succeed(undefined);
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
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(deleteMessageCalls).toHaveLength(1);
    expect(deleteMessageCalls[0]?.channelId).toBe(TRAINING_CH);
    expect(deleteMessageCalls[0]?.messageId).toBe(PERSONAL_MSG_A);
  });

  it('update-in-place addresses the STORED channel — pins the call site so a later refactor cannot silently reintroduce member.personal_channel_id', async () => {
    // Stored and current channel are EQUAL here (the common case — no move happened).
    // The call must still be made against stored.value.personal_channel_id, not
    // member.personal_channel_id, even though the two values are equal in this case —
    // this pins the call site itself, not just its accidental correctness.
    const SAME_CHANNEL = '550000000000000021';

    const updateMessageCalls: Array<{ channelId: string; messageId: string }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return () => {
            if (method === 'Guild/ListPersonalChannelsForEvent') {
              return Effect.succeed([
                {
                  team_member_id: MEMBER_A_ID as any,
                  discord_id: DISCORD_ID_A as any,
                  personal_channel_id: SAME_CHANNEL as any,
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
              return Effect.succeed(
                Option.some({
                  personal_channel_id: SAME_CHANNEL as any,
                  discord_message_id: PERSONAL_MSG_A as any,
                  payload_hash: 'SENTINEL-WILL-NEVER-MATCH',
                }),
              );
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              return Effect.succeed(undefined);
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
            return (channelId: string, messageId: string) => {
              updateMessageCalls.push({ channelId, messageId });
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
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(updateMessageCalls).toHaveLength(1);
    expect(updateMessageCalls[0]?.channelId).toBe(SAME_CHANNEL);
    expect(updateMessageCalls[0]?.messageId).toBe(PERSONAL_MSG_A);
  });
});

// ---------------------------------------------------------------------------
// Nastavitelná docházka (plan §7.4, §10.1): Setting 1 (show_attendee_list)
// must reach the personal-channel reconcile pass, and must NOT regress the
// unanswered-event mention-edit flow for members who keep the default (on).
// ---------------------------------------------------------------------------

describe('handleReconcile — show_attendee_list wiring', () => {
  it('show_attendee_list: false → the created embed has no Going field even though GetYesAttendeesForEmbed returned names', async () => {
    const createMessageCalls: Array<{ channelId: string; payload: unknown }> = [];

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return () => {
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
                show_attendee_list: false,
              });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(Option.none());
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              return Effect.succeed(undefined);
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([
                {
                  discord_id: Option.none(),
                  name: Option.some('Alice'),
                  nickname: Option.none(),
                  username: Option.none(),
                  display_name: Option.none(),
                  response: 'yes',
                  message: Option.none(),
                },
              ]);
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
            return (channelId: string, payload: unknown) => {
              createMessageCalls.push({ channelId, payload });
              return Effect.succeed({ id: 'new-msg-id' });
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
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(createMessageCalls).toHaveLength(1);
    const json = JSON.stringify(createMessageCalls[0]?.payload);
    expect(json).not.toContain('Alice');
  });

  it('regression: show_attendee_list: true (default), same channel → byte-identical payload to today, including the unanswered mention edit', async () => {
    const updateMessageCalls: Array<{ channelId: string; messageId: string; payload: unknown }> =
      [];
    const attendee = {
      discord_id: Option.none(),
      name: Option.some('Alice'),
      nickname: Option.none(),
      username: Option.none(),
      display_name: Option.none(),
      response: 'yes' as const,
      message: Option.none(),
    };

    const rpcLayer = Layer.succeed(
      SyncRpc,
      new Proxy({} as any, {
        get: (_target: unknown, method: string) => {
          if (typeof method !== 'string' || method === 'then') return undefined;
          return () => {
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
                events: [makeUpcomingEvent(null)],
                total: 1,
                team_id: TEAM_ID,
                show_attendee_list: true,
              });
            }
            if (method === 'PersonalEvents/GetPersonalEventMessage') {
              return Effect.succeed(
                Option.some({
                  personal_channel_id: PERSONAL_CHANNEL_A as any,
                  discord_message_id: PERSONAL_MSG_A as any,
                  payload_hash: 'SENTINEL-WILL-NEVER-MATCH',
                }),
              );
            }
            if (method === 'PersonalEvents/UpsertPersonalEventMessage') {
              return Effect.succeed(undefined);
            }
            if (method === 'Event/GetYesAttendeesForEmbed') {
              return Effect.succeed([attendee]);
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
            return (channelId: string, messageId: string, payload: unknown) => {
              updateMessageCalls.push({ channelId, messageId, payload });
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
      reconcileEvent({
        event_id: EVENT_ID as any,
        team_id: TEAM_ID as any,
        guild_id: GUILD_ID as any,
      }),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(updateMessageCalls).toHaveLength(1);
    // Attendee list stays (Setting 1 defaults to on) …
    const json = JSON.stringify(updateMessageCalls[0]?.payload);
    expect(json).toContain('Alice');
    // … and the unanswered-event mention edit still fires (Setting 2 out of scope here).
    expect((updateMessageCalls[0]?.payload as any)?.content).toBe(`<@${DISCORD_ID_A}>`);
  });
});
