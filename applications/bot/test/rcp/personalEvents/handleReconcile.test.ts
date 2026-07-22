// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They require applications/bot/src/rcp/personalEvents/handleReconcile.ts step 4
// (the global shared-message refresh) to be skipped whenever
// `embedInfo.status !== 'active'` — i.e. once an event has started or been
// cancelled, the global message is frozen and only the personal-channel path
// keeps running (delivering/removing each member's own personal message).
//
// These tests WILL FAIL until that guard is added.

import { DiscordREST } from 'dfx/DiscordREST';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { ChannelReorderSemaphore } from '~/rcp/event/ChannelReorderSemaphore.js';
import { reconcileEvent } from '~/rcp/personalEvents/handleReconcile.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000001';
const GUILD_ID = '520000000000000001';
const EVENT_ID = 'evt-00000000-0000-0000-0000-000000000009';

const MEMBER_ID = 'mbr-00000000-0000-0000-0000-000000000001';
const DISCORD_ID = '520000000000000011';
const PERSONAL_CHANNEL_ID = '520000000000000021';
const PERSONAL_MSG_ID = '520000000000000031';

const GLOBAL_CHANNEL_ID = '520000000000000041';
const GLOBAL_MSG_ID = '520000000000000051';

type EmbedStatus = 'active' | 'started' | 'cancelled';

// ---------------------------------------------------------------------------
// Mock harness
// ---------------------------------------------------------------------------

interface Calls {
  listPersonalChannels: number;
  getMessage: Array<{ channelId: string; messageId: string }>;
  updateMessage: Array<{ channelId: string; messageId: string }>;
  deleteMessage: Array<{ channelId: string; messageId: string }>;
  deletePersonalEventMessage: unknown[];
}

/**
 * Builds a minimal SyncRpc + DiscordREST mock pair for reconcileEvent.
 *
 * Personal-channel path: one member (MEMBER_ID) whose event is no longer in
 * their upcoming window (Guild/GetAllUpcomingEventsForUser returns []), and
 * who has a stored personal message — so reconcileMemberMessage takes the
 * "stale, delete it" branch. This exercises the personal-channel path (steps
 * 1-3) independently of the global-message status gate under test (step 4).
 *
 * Global-message path: GetDiscordMessageId always resolves to a stored
 * message, and GetEventEmbedInfo resolves to Some(info) with the given
 * `status`. rest.getMessage returns a stale payload (guaranteed hash-diff
 * mismatch) so that, when NOT skipped, updateMessage is always invoked.
 */
const makeLayers = (status: EmbedStatus) => {
  const calls: Calls = {
    listPersonalChannels: 0,
    getMessage: [],
    updateMessage: [],
    deleteMessage: [],
    deletePersonalEventMessage: [],
  };

  const rpcLayer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then') return undefined;
        return (args: any) => {
          switch (method) {
            case 'Guild/ListPersonalChannelsForEvent':
              calls.listPersonalChannels++;
              return Effect.succeed([
                {
                  team_member_id: MEMBER_ID as any,
                  discord_id: DISCORD_ID as any,
                  personal_channel_id: PERSONAL_CHANNEL_ID as any,
                },
              ]);
            case 'Guild/GetAllUpcomingEventsForUser':
              // Event is no longer upcoming for this member → stale-message delete branch.
              return Effect.succeed({ events: [], total: 0, team_id: TEAM_ID });
            case 'PersonalEvents/GetPersonalEventMessage':
              return Effect.succeed(
                Option.some({
                  discord_message_id: PERSONAL_MSG_ID,
                  payload_hash: 'stored-hash',
                }),
              );
            case 'PersonalEvents/DeletePersonalEventMessage':
              calls.deletePersonalEventMessage.push(args);
              return Effect.succeed(undefined);
            case 'Event/GetYesAttendeesForEmbed':
              return Effect.succeed([]);
            case 'Event/GetDiscordMessageId':
              return Effect.succeed(
                Option.some({
                  discord_channel_id: GLOBAL_CHANNEL_ID as any,
                  discord_message_id: GLOBAL_MSG_ID as any,
                }),
              );
            case 'Event/GetEventEmbedInfo':
              return Effect.succeed(
                Option.some({
                  title: 'Some Event',
                  description: Option.none(),
                  image_url: Option.none(),
                  start_at: DateTime.makeUnsafe('2027-07-01T14:00:00Z'),
                  end_at: Option.none(),
                  location: Option.none(),
                  location_url: Option.none(),
                  event_type: 'training',
                  all_day: false,
                  status,
                }),
              );
            case 'Event/GetRsvpCounts':
              return Effect.succeed({ yesCount: 1, noCount: 0, maybeCount: 0, canRsvp: true });
            default:
              return Effect.succeed(null);
          }
        };
      },
    }),
  );

  const restLayer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (prop === 'getMessage') {
          return (channelId: string, messageId: string) => {
            calls.getMessage.push({ channelId, messageId });
            // Deliberately stale content so the hash-diff always decides to
            // update when the global-message refresh is NOT skipped.
            return Effect.succeed({ embeds: [{ title: 'stale-embed' }], components: [] });
          };
        }
        if (prop === 'updateMessage') {
          return (channelId: string, messageId: string, _payload: unknown) => {
            calls.updateMessage.push({ channelId, messageId });
            return Effect.succeed({});
          };
        }
        if (prop === 'deleteMessage') {
          return (channelId: string, messageId: string) => {
            calls.deleteMessage.push({ channelId, messageId });
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

  return { rpcLayer, restLayer, calls };
};

const run = (
  effect: Effect.Effect<void, never, SyncRpc | DiscordREST | ChannelReorderSemaphore>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) =>
  Effect.runPromise(effect.pipe(Effect.provide(Layer.merge(layers, ChannelReorderSemaphore.Live))));

const runReconcile = (status: EmbedStatus) => {
  const { rpcLayer, restLayer, calls } = makeLayers(status);
  return run(
    reconcileEvent({
      event_id: EVENT_ID as any,
      team_id: TEAM_ID as any,
      guild_id: GUILD_ID as any,
    }),
    Layer.merge(rpcLayer, restLayer),
  ).then(() => calls);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleReconcile — global message refresh is skipped once an event is no longer active', () => {
  it('status="active": global getMessage/updateMessage IS called', async () => {
    const calls = await runReconcile('active');

    expect(calls.getMessage.length).toBeGreaterThanOrEqual(1);
    const globalUpdates = calls.updateMessage.filter((c) => c.channelId === GLOBAL_CHANNEL_ID);
    expect(globalUpdates.length).toBeGreaterThanOrEqual(1);
  });

  it('status="started": global getMessage/updateMessage NOT called; personal-channel path still runs', async () => {
    const calls = await runReconcile('started');

    // Global message is frozen once the event has started.
    const globalGets = calls.getMessage.filter((c) => c.channelId === GLOBAL_CHANNEL_ID);
    expect(globalGets).toHaveLength(0);
    const globalUpdates = calls.updateMessage.filter((c) => c.channelId === GLOBAL_CHANNEL_ID);
    expect(globalUpdates).toHaveLength(0);

    // The personal-channel path still ran: the event's channels were listed,
    // and the stale personal message was deleted for the member.
    expect(calls.listPersonalChannels).toBeGreaterThanOrEqual(1);
    expect(calls.deletePersonalEventMessage.length).toBeGreaterThanOrEqual(1);
    expect(calls.deleteMessage.some((c) => c.channelId === PERSONAL_CHANNEL_ID)).toBe(true);
  });

  it('status="cancelled": global getMessage/updateMessage NOT called; personal-channel path still runs', async () => {
    const calls = await runReconcile('cancelled');

    const globalGets = calls.getMessage.filter((c) => c.channelId === GLOBAL_CHANNEL_ID);
    expect(globalGets).toHaveLength(0);
    const globalUpdates = calls.updateMessage.filter((c) => c.channelId === GLOBAL_CHANNEL_ID);
    expect(globalUpdates).toHaveLength(0);

    expect(calls.listPersonalChannels).toBeGreaterThanOrEqual(1);
    expect(calls.deletePersonalEventMessage.length).toBeGreaterThanOrEqual(1);
    expect(calls.deleteMessage.some((c) => c.channelId === PERSONAL_CHANNEL_ID)).toBe(true);
  });
});
