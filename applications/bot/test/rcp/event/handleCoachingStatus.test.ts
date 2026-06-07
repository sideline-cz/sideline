// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They test handleCoachingStatus (new bot RCP handler for the 'coaching_status' sync event).
//
// ASSUMPTION: handleCoachingStatus is exported from ~/rcp/event/handleCoachingStatus.ts (new file).
// ASSUMPTION: When discord_target_channel_id is None → logs a warning, does NOT call createMessage.
// ASSUMPTION: When discord_target_channel_id is Some → createMessage is called to THAT channel,
//   and the message content/embed contains the coach name (claimed_by_display_name).
// ASSUMPTION: HTTP errors (HttpClientError / ErrorResponse / RatelimitedResponse) are caught and
//   logged — the handler does NOT throw/fail for Discord REST errors.
//
// The CoachingStatusEvent schema (in domain) has:
//   _tag: 'coaching_status', id, team_id, guild_id, event_id, title, start_at,
//   discord_target_channel_id, claimed_by_display_name, claimed_by_discord_id, location.

import type { EventRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type { MessageCreateRequest } from 'dfx/types';
import { DateTime, Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleCoachingStatus } from '~/rcp/event/handleCoachingStatus.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010';
const GUILD_ID = '111111111111111111';
const EVENT_ID = '00000000-0000-0000-0000-000000000001';
const TRAINING_CHANNEL = '777777777777777777';
const COACH_NAME = 'Alice Coach';
const COACH_DISCORD_ID = '888888888888888888';

// ---------------------------------------------------------------------------
// Event factory
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<EventRpcEvents.CoachingStatusEvent> = {},
): EventRpcEvents.CoachingStatusEvent =>
  ({
    _tag: 'coaching_status' as const,
    id: 'sync-coaching-1',
    team_id: TEAM_ID as any,
    guild_id: GUILD_ID as any,
    event_id: EVENT_ID as any,
    title: 'Monday Training',
    start_at: DateTime.makeUnsafe('2026-06-01T14:00:00Z'),
    discord_target_channel_id: Option.some(TRAINING_CHANNEL as any),
    claimed_by_display_name: Option.some(COACH_NAME),
    claimed_by_discord_id: Option.some(COACH_DISCORD_ID as any),
    location: Option.none(),
    ...overrides,
  }) as any;

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type CreateMessageCall = [string, MessageCreateRequest];

const makeRecordingDiscordREST = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any>>> = {},
) => {
  const createMessageCalls: CreateMessageCall[] = [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any>> = {
    createMessage: (...args: any[]) => {
      createMessageCalls.push(args as CreateMessageCall);
      return Effect.succeed({ id: 'msg-coaching-1' });
    },
    getGuild: (_guildId: any) =>
      Effect.succeed({
        preferred_locale: 'en-US',
        system_channel_id: null,
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

  return { createMessageCalls, layer };
};

const makeNoOpSyncRpc = () =>
  Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, method: string) => {
        if (typeof method !== 'string' || method === 'then' || method === 'catch') return undefined;
        return () => Effect.succeed(null);
      },
    }),
  );

const run = (
  effect: Effect.Effect<void, any, SyncRpc | DiscordREST>,
  layers: Layer.Layer<SyncRpc | DiscordREST>,
) => Effect.runPromise(effect.pipe(Effect.provide(layers)) as Effect.Effect<void, never, never>);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleCoachingStatus', () => {
  it('None channel → logs, no createMessage', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleCoachingStatus(makeEvent({ discord_target_channel_id: Option.none() })),
      Layer.merge(makeNoOpSyncRpc(), restLayer),
    );

    expect(createMessageCalls).toHaveLength(0);
  });

  it('Some channel → createMessage to the training channel containing the coach name', async () => {
    const { createMessageCalls, layer: restLayer } = makeRecordingDiscordREST();

    await run(
      handleCoachingStatus(
        makeEvent({ discord_target_channel_id: Option.some(TRAINING_CHANNEL as any) }),
      ),
      Layer.merge(makeNoOpSyncRpc(), restLayer),
    );

    expect(createMessageCalls).toHaveLength(1);
    const [channelId, payload] = createMessageCalls[0];
    // Must post to the training channel
    expect(channelId).toBe(TRAINING_CHANNEL);
    // Message content or embed must contain coach name
    const bodyText = JSON.stringify(payload);
    expect(bodyText).toContain(COACH_NAME);
  });

  it('HTTP error path is caught and logged — handler does not throw', async () => {
    const { layer: restLayer } = makeRecordingDiscordREST({
      // Simulate a Discord REST 403 Missing Permissions error (HttpClientError-like defect)
      createMessage: () =>
        Effect.die({ _tag: 'ErrorResponse', code: 50013, message: 'Missing Permissions' }),
    });

    // Must resolve without throwing
    await expect(
      run(handleCoachingStatus(makeEvent()), Layer.merge(makeNoOpSyncRpc(), restLayer)),
    ).resolves.not.toThrow();
  });

  it('RatelimitedResponse error path is caught and logged', async () => {
    const { layer: restLayer } = makeRecordingDiscordREST({
      createMessage: () => Effect.die({ _tag: 'RatelimitedResponse', retry_after: 1.5 }),
    });

    await expect(
      run(handleCoachingStatus(makeEvent()), Layer.merge(makeNoOpSyncRpc(), restLayer)),
    ).resolves.not.toThrow();
  });
});
