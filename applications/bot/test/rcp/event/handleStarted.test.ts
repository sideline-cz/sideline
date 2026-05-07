// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference the expanded EventStartedEvent (title, start_at, end_at,
// location, event_type, member_group_id, discord_channel_id, discord_role_id)
// and the new "Starting now" post behaviour added to handleStarted.
// They will FAIL to compile / run until the developer implements the bot task.

import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';
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
const MESSAGE_ID = '444444444444444444';
const ROLE_ID = '555555555555555555';

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
    member_group_id: Option.none(),
    discord_channel_id: Option.some(CHANNEL_ID as any),
    discord_role_id: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type SyncRpcCalls = {
  GetDiscordMessageId: unknown[];
  GetRsvpCounts: unknown[];
  GetEventEmbedInfo: unknown[];
  GetYesAttendeesForEmbed: unknown[];
};

const makeRecordingSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: SyncRpcCalls = {
    GetDiscordMessageId: [],
    GetRsvpCounts: [],
    GetEventEmbedInfo: [],
    GetYesAttendeesForEmbed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    'Event/GetDiscordMessageId': (_args: any) => {
      calls.GetDiscordMessageId.push(_args);
      return Effect.succeed(
        Option.some({
          discord_channel_id: CHANNEL_ID as any,
          discord_message_id: MESSAGE_ID as any,
        }),
      );
    },
    'Event/GetRsvpCounts': (_args: any) => {
      calls.GetRsvpCounts.push(_args);
      return Effect.succeed({ yesCount: 3, noCount: 1, maybeCount: 0, canRsvp: true });
    },
    'Event/GetEventEmbedInfo': (_args: any) => {
      calls.GetEventEmbedInfo.push(_args);
      return Effect.succeed(
        Option.some({
          title: 'Saturday Match',
          description: Option.none(),
          image_url: Option.none(),
          start_at: DateTime.makeUnsafe('2026-05-01T16:00:00Z'),
          end_at: Option.none(),
          location: Option.none(),
          event_type: 'match',
        }),
      );
    },
    'Event/GetYesAttendeesForEmbed': (_args: any) => {
      calls.GetYesAttendeesForEmbed.push(_args);
      return Effect.succeed([]);
    },
    'Event/GetChannelEvents': () => Effect.succeed([]),
    'Event/GetChannelDivider': () => Effect.succeed(Option.none()),
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
  updateMessage: unknown[];
  createMessage: unknown[];
};

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const calls: RestCalls = { updateMessage: [], createMessage: [] };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    updateMessage: (...args: any[]) => {
      calls.updateMessage.push(args);
      return Effect.succeed({});
    },
    createMessage: (...args: any[]) => {
      calls.createMessage.push(args);
      return Effect.succeed({ id: 'new-msg-id' });
    },
    getGuild: (_guildId: any) =>
      Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: SYSTEM_CHANNEL_ID,
      }),
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

// ---------------------------------------------------------------------------
// T11.1 — in-place edit + new "Starting now" post both succeed
// ---------------------------------------------------------------------------

describe('handleStarted', () => {
  it('performs in-place edit AND posts "Starting now" message when both channels are known', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.some(CHANNEL_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.updateMessage).toHaveLength(1);
    expect(restCalls.createMessage).toHaveLength(1);
    // The createMessage should target the event channel
    const [createChannelArg] = restCalls.createMessage[0] as [string, unknown];
    expect(createChannelArg).toBe(CHANNEL_ID);
  });

  // T11.2 — in-place edit failure is isolated (does not prevent "Starting now" post)
  it('still posts "Starting now" message even if in-place edit fails', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST({
      updateMessage: (..._args: any[]) => Effect.die(new Error('update failed')),
    });

    await run(handleStarted(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // In-place edit failed but createMessage should still have been attempted
    expect(restCalls.createMessage).toHaveLength(1);
  });

  // T11.3 — "Starting now" post failure is isolated (does not affect in-place edit)
  it('still performs in-place edit even if "Starting now" post fails', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST({
      createMessage: (..._args: any[]) => Effect.die(new Error('post failed')),
    });

    await run(handleStarted(makeEvent()), Layer.merge(rpcLayer, restLayer));

    // createMessage failed but updateMessage should still have been attempted
    expect(restCalls.updateMessage).toHaveLength(1);
  });

  // T11.4 — role mention rendered when discord_role_id is Some
  it('includes <@&roleId> mention prefix in content when discord_role_id is Some', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_role_id: Option.some(ROLE_ID as any) })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [_channelId, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    // The content field should include the role mention
    expect(typeof payload.content).toBe('string');
    expect(payload.content).toContain(`<@&${ROLE_ID}>`);
  });

  // T11.5 — role mention omitted when discord_role_id is None
  it('does NOT include role mention in content when discord_role_id is None', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_role_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [_channelId, payload] = restCalls.createMessage[0] as [string, MessageCreateRequest];
    // content should be absent or not contain a role mention
    const content = payload.content ?? '';
    expect(content).not.toContain('<@&');
  });

  // T11.6 — system_channel fallback when discord_channel_id is None
  it('falls back to system_channel_id when event discord_channel_id is None', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    expect(restCalls.createMessage).toHaveLength(1);
    const [createChannelArg] = restCalls.createMessage[0] as [string, unknown];
    // Should have fallen back to the system channel
    expect(createChannelArg).toBe(SYSTEM_CHANNEL_ID);
  });

  // T11.7 — both channels None → no createMessage call
  it('does NOT call createMessage when both discord_channel_id and system_channel_id are absent', async () => {
    const { layer: rpcLayer } = makeRecordingSyncRpc();
    const { calls: restCalls, layer: restLayer } = makeRecordingDiscordREST({
      getGuild: (_guildId: any) =>
        Effect.succeed({
          preferred_locale: 'en-US',
          system_channel_id: null,
        }),
    });

    await run(
      handleStarted(makeEvent({ discord_channel_id: Option.none() })),
      Layer.merge(rpcLayer, restLayer),
    );

    // No channel available → no message posted
    expect(restCalls.createMessage).toHaveLength(0);
  });
});
