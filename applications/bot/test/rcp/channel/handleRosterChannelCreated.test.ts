/**
 * TDD tests for handleRosterChannelCreated — per-team Discord category support.
 *
 * These tests describe NEW behavior after the feature is implemented and are
 * expected to FAIL until the bot's handleRosterChannelCreated is updated.
 *
 * Contracts:
 *   1. target_category_id=Some(cat123), existing_channel_id=None
 *      → createGuildChannel called with parent_id: 'cat123'
 *   2. target_category_id=None, existing_channel_id=None
 *      → createGuildChannel called WITHOUT parent_id (undefined)
 *   3. Stale category: createGuildChannel (with parent_id) fails with PERMANENT
 *      Discord error (e.g. 10003 / 404) → retry without parent_id, succeeds,
 *      mapping/UpdateRosterChannel still upserted once
 *   3b. Stale category (real Discord shape): HTTP 400 + code 50035 (Invalid Form Body)
 *      → same fallback behaviour as 3
 *   4. Transient error (HttpClientError / 5xx) → retried with parent_id still
 *      present (no root-level fallback on transient); uses TestClock for fast CI
 *   5. Link-existing: existing_channel_id=Some(chan), target_category_id=Some(cat123)
 *      → createGuildChannel NOT called (only createRoleForChannel path)
 *   6. Group-created path unaffected — createGuildChannel called with no parent_id
 *      (regression guard; tested via handleCreated for the group path)
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, RosterModel, Team } from '@sideline/domain';
import { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { handleRosterChannelCreated } from '~/rcp/channel/handleRosterChannelCreated.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const ROSTER_ID = '00000000-0000-0000-0001-000000000030' as RosterModel.RosterId;
const EXISTING_CHANNEL_ID = '666666666666666666' as Discord.Snowflake;
const NEW_CHANNEL_ID = 'new-channel-id' as Discord.Snowflake;
const NEW_ROLE_ID = '777777777777777777' as Discord.Snowflake;
const CATEGORY_ID = 'cat123000000000000' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factory helpers
// ---------------------------------------------------------------------------

const makeRosterCreatedEvent = (
  overrides: Partial<{
    existing_channel_id: Option.Option<Discord.Snowflake>;
    target_category_id: Option.Option<Discord.Snowflake>;
  }> = {},
): ChannelRpcEvents.RosterChannelCreatedEvent =>
  new ChannelRpcEvents.RosterChannelCreatedEvent({
    id: 'evt-roster-001' as never,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    roster_id: ROSTER_ID,
    roster_name: 'Test Roster',
    existing_channel_id: Option.none<Discord.Snowflake>(),
    discord_channel_name: '│test-roster',
    discord_role_name: 'Test Roster',
    discord_role_color: Option.none<number>(),
    target_category_id: Option.none<Discord.Snowflake>(),
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCallRecord = {
  createGuildRole: unknown[];
  createGuildChannel: unknown[];
  setChannelPermissionOverwrite: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    createGuildRole: [],
    createGuildChannel: [],
    setChannelPermissionOverwrite: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createGuildRole: (...args: any[]) => {
      calls.createGuildRole.push(args);
      return Effect.succeed({ id: NEW_ROLE_ID });
    },
    createGuildChannel: (...args: any[]) => {
      calls.createGuildChannel.push(args);
      return Effect.succeed({ id: NEW_CHANNEL_ID, parent_id: null });
    },
    setChannelPermissionOverwrite: (...args: any[]) => {
      calls.setChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
    deleteChannel: () => Effect.void,
    deleteGuildRole: () => Effect.void,
    updateGuildRole: () => Effect.succeed({}),
    updateChannel: () => Effect.succeed({}),
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected DiscordREST.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

type RpcCallRecord = {
  UpsertRosterMapping: unknown[];
  UpdateRosterChannel: unknown[];
  UpsertGroupChannel: unknown[];
};

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCallRecord; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCallRecord = {
    UpsertRosterMapping: [],
    UpdateRosterChannel: [],
    UpsertGroupChannel: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Channel/UpsertRosterMapping': (args: any) => {
      calls.UpsertRosterMapping.push(args);
      return Effect.void;
    },
    'Channel/UpdateRosterChannel': (args: any) => {
      calls.UpdateRosterChannel.push(args);
      return Effect.void;
    },
    'Channel/UpsertGroupChannel': (args: any) => {
      calls.UpsertGroupChannel.push(args);
      return Effect.void;
    },
    'Channel/MarkEventProcessed': () => Effect.void,
    'Guild/UpsertChannel': () => Effect.void,
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (fn !== undefined) return fn;
        return () => Effect.void;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

const runHandleRosterCreated = (
  event: ChannelRpcEvents.RosterChannelCreatedEvent,
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
) =>
  Effect.runPromise(
    handleRosterChannelCreated(event).pipe(Effect.provide(Layer.merge(rpcLayer, restLayer))),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRosterChannelCreated — target_category_id / Discord category support', () => {
  /**
   * Test 1: target_category_id=Some(cat123), existing_channel_id=None
   * → createGuildChannel called with parent_id: 'cat123'
   */
  it('target_category_id=Some(cat123), existing_channel_id=None → createGuildChannel called with parent_id: cat123', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({ target_category_id: Option.some(CATEGORY_ID) }),
      rpcLayer,
      restLayer,
    );

    // createGuildChannel must be called exactly once
    expect(restCalls.createGuildChannel).toHaveLength(1);

    // The call must include parent_id matching the category
    const [_guildId, channelParams] = restCalls.createGuildChannel[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(channelParams.parent_id).toBe(CATEGORY_ID);

    // Mapping and UpdateRosterChannel must be upserted
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
  });

  /**
   * Test 2: target_category_id=None, existing_channel_id=None
   * → createGuildChannel called without parent_id (undefined or absent)
   */
  it('target_category_id=None, existing_channel_id=None → createGuildChannel called without parent_id', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({ target_category_id: Option.none() }),
      rpcLayer,
      restLayer,
    );

    expect(restCalls.createGuildChannel).toHaveLength(1);

    const [_guildId, channelParams] = restCalls.createGuildChannel[0] as [
      string,
      Record<string, unknown>,
    ];
    // parent_id must not be set (either undefined or absent from the object)
    expect(channelParams.parent_id).toBeUndefined();

    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
  });

  /**
   * Test 3: Stale category — createGuildChannel with parent_id fails with PERMANENT
   * Discord error (code 10003 / 404 Unknown Channel). Handler retries without parent_id
   * and succeeds. Mapping/UpdateRosterChannel still upserted exactly once.
   */
  it('stale category: createGuildChannel(with parent_id) fails 10003/404 → retried without parent_id, mapping upserted once', async () => {
    let callCount = 0;

    const permanentError = {
      _tag: 'ErrorResponse',
      data: { code: 10003, message: 'Unknown Channel' },
      response: { status: 404 },
      request: {},
    };

    const { calls: restCalls, layer: restLayer } = makeRest({
      createGuildChannel: (...args: any[]) => {
        callCount++;
        const channelParams = args[1] as Record<string, unknown>;
        restCalls.createGuildChannel.push(args);

        if (channelParams.parent_id !== undefined) {
          // First call (with parent_id) — return permanent Discord error
          return Effect.fail(permanentError);
        }
        // Second call (without parent_id) — succeed
        return Effect.succeed({ id: NEW_CHANNEL_ID, parent_id: null });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({ target_category_id: Option.some(CATEGORY_ID) }),
      rpcLayer,
      restLayer,
    );

    // createGuildChannel called twice: first with parent_id (fails), then without (succeeds)
    expect(restCalls.createGuildChannel).toHaveLength(2);
    expect(callCount).toBe(2);

    const [, firstParams] = restCalls.createGuildChannel[0] as [string, Record<string, unknown>];
    expect(firstParams.parent_id).toBe(CATEGORY_ID);

    const [, secondParams] = restCalls.createGuildChannel[1] as [string, Record<string, unknown>];
    expect(secondParams.parent_id).toBeUndefined();

    // Mapping upserted exactly once (from the successful second call)
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
  });

  /**
   * Test 3b: Stale category — real-world Discord error shape: HTTP 400 + code 50035
   * (Invalid Form Body — parent_id refers to a deleted category). Handler falls back to
   * guild-root channel creation and upserts the mapping exactly once.
   */
  it('stale category: createGuildChannel(with parent_id) fails 50035/400 → retried without parent_id, mapping upserted once', async () => {
    let callCount = 0;

    const invalidFormBodyError = {
      _tag: 'ErrorResponse',
      data: { code: 50035, message: 'Invalid Form Body' },
      response: { status: 400 },
      request: {},
    };

    const { calls: restCalls, layer: restLayer } = makeRest({
      createGuildChannel: (...args: any[]) => {
        callCount++;
        const channelParams = args[1] as Record<string, unknown>;
        restCalls.createGuildChannel.push(args);

        if (channelParams.parent_id !== undefined) {
          // First call (with parent_id) — return permanent Discord error (stale category)
          return Effect.fail(invalidFormBodyError);
        }
        // Second call (without parent_id) — succeed
        return Effect.succeed({ id: NEW_CHANNEL_ID, parent_id: null });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({ target_category_id: Option.some(CATEGORY_ID) }),
      rpcLayer,
      restLayer,
    );

    // createGuildChannel called twice: first with parent_id (fails), then without (succeeds)
    expect(restCalls.createGuildChannel).toHaveLength(2);
    expect(callCount).toBe(2);

    const [, firstParams] = restCalls.createGuildChannel[0] as [string, Record<string, unknown>];
    expect(firstParams.parent_id).toBe(CATEGORY_ID);

    const [, secondParams] = restCalls.createGuildChannel[1] as [string, Record<string, unknown>];
    expect(secondParams.parent_id).toBeUndefined();

    // Mapping upserted exactly once (from the successful second call)
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
  });

  /**
   * Test 4: Transient error (HttpClientError / 5xx) → retried with parent_id still present.
   * The root-level fallback (drop parent_id) must NOT trigger for transient errors.
   * Uses TestClock to advance virtual time so the exponential back-off does not
   * cause real multi-second delays in CI.
   */
  it.effect(
    'transient 5xx error → retried with parent_id still present, fallback NOT triggered',
    () => {
      const transientError = {
        _tag: 'HttpClientError',
        reason: { _tag: 'StatusCodeError' },
        response: { status: 503 },
      };

      let callCount = 0;
      const { calls: restCalls, layer: restLayer } = makeRest({
        createGuildChannel: (...args: any[]) => {
          callCount++;
          restCalls.createGuildChannel.push(args);
          // Fail first two attempts with transient error, succeed on third
          if (callCount <= 2) {
            return Effect.fail(transientError);
          }
          return Effect.succeed({ id: NEW_CHANNEL_ID, parent_id: null });
        },
      });
      const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

      const handler = handleRosterChannelCreated(
        makeRosterCreatedEvent({ target_category_id: Option.some(CATEGORY_ID) }),
      ).pipe(Effect.provide(Layer.merge(rpcLayer, restLayer)));

      return Effect.Do.pipe(
        Effect.bind('fiber', () => Effect.forkChild(handler)),
        // Advance virtual time past the exponential delays (1s + 2s = 3s covers recurs(3))
        Effect.tap(() => TestClock.adjust('10 seconds')),
        Effect.bind('result', ({ fiber }) => Fiber.join(fiber)),
        Effect.tap(({ result: _result }) =>
          Effect.sync(() => {
            // All calls must have parent_id (transient retry keeps the category)
            expect(restCalls.createGuildChannel.length).toBeGreaterThanOrEqual(2);
            for (const call of restCalls.createGuildChannel) {
              const [, params] = call as [string, Record<string, unknown>];
              expect(params.parent_id).toBe(CATEGORY_ID);
            }

            // Mapping upserted once (from successful call)
            expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
            expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      );
    },
  );

  /**
   * Test 5: Link-existing path — existing_channel_id=Some(chan), target_category_id=Some(cat123)
   * → createGuildChannel NOT called; only createRoleForChannel path runs.
   * Mapping/UpdateRosterChannel still upserted.
   */
  it('link-existing: existing_channel_id=Some(chan), target_category_id=Some(cat123) → createGuildChannel NOT called', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({
        existing_channel_id: Option.some(EXISTING_CHANNEL_ID),
        target_category_id: Option.some(CATEGORY_ID),
      }),
      rpcLayer,
      restLayer,
    );

    // No channel creation — we're linking an existing channel
    expect(restCalls.createGuildChannel).toHaveLength(0);

    // Role must be created for the existing channel
    expect(restCalls.createGuildRole).toHaveLength(1);

    // Mapping upserted once
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
  });
});
