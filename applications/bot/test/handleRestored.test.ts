/**
 * Unit tests for the channel restore handlers:
 *   - handleManagedRestored
 *   - handleDiscordRestored
 *
 * Key invariants (mirror of handleDiscordArchived, but for restore):
 *   - Moves channel out of archive category via REST updateChannel({ parent_id: null }).
 *   - NO deleteChannel fallback.
 *   - NO Channel/ClearManagedChannel or Channel/UpsertManagedChannel RPC.
 *   - discord_channel_id None → no-op (no REST calls).
 *   - REST updateChannel failure → logs warning, does NOT call deleteChannel.
 */

import type { Discord, Team, TeamChannel } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0011-000000000010' as Team.TeamId;
const CHANNEL_ID = '00000000-0000-0000-0011-000000000030' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const EVENT_ID = 'evt-00000000-0000-0000-0011-000000000001' as any;

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCalls = {
  updateChannel: unknown[];
  deleteChannel: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    updateChannel: [],
    deleteChannel: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    updateChannel: (...args: any[]) => {
      calls.updateChannel.push(args);
      return Effect.succeed({});
    },
    deleteChannel: (...args: any[]) => {
      calls.deleteChannel.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

type RpcCalls = {
  UpsertManagedChannel: unknown[];
  ClearManagedChannel: unknown[];
};

const makeRpc = (): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    UpsertManagedChannel: [],
    ClearManagedChannel: [],
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        if (prop === 'Channel/UpsertManagedChannel') {
          return (args: any) => {
            calls.UpsertManagedChannel.push(args);
            return Effect.void;
          };
        }
        if (prop === 'Channel/ClearManagedChannel') {
          return (args: any) => {
            calls.ClearManagedChannel.push(args);
            return Effect.void;
          };
        }
        return () => Effect.void;
      },
    }),
  );

  return { calls, layer };
};

const run = (
  effect: Effect.Effect<void, unknown, SyncRpc | DiscordREST>,
  rpc: Layer.Layer<SyncRpc>,
  rest: Layer.Layer<DiscordREST>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(rpc, rest))) as Effect.Effect<void, never, never>,
  );

// ---------------------------------------------------------------------------
// handleManagedRestored
// ---------------------------------------------------------------------------

describe('handleManagedRestored', () => {
  it('Some discord_channel_id → updateChannel({ parent_id: null }), no deleteChannel, no RPC', async () => {
    const { handleManagedRestored } = await import('~/rcp/channel/handleManagedRestored.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    await run(handleManagedRestored(event), rpcLayer, restLayer);

    // Must call updateChannel once with parent_id: null (move out of archive)
    expect(restCalls.updateChannel).toHaveLength(1);
    const updateArgs = restCalls.updateChannel[0] as any[];
    expect(updateArgs[0]).toBe(DISCORD_CHANNEL_ID);
    expect((updateArgs[1] as any).parent_id).toBeNull();

    // Must NOT call deleteChannel
    expect(restCalls.deleteChannel).toHaveLength(0);

    // Must NOT call any RPC (no team_channels update needed — discord_channel_id stays linked)
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('None discord_channel_id → no REST calls (no-op)', async () => {
    const { handleManagedRestored } = await import('~/rcp/channel/handleManagedRestored.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.none(),
    });

    await run(handleManagedRestored(event), rpcLayer, restLayer);

    expect(restCalls.updateChannel).toHaveLength(0);
    expect(restCalls.deleteChannel).toHaveLength(0);
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('REST updateChannel failure → logs warning, does NOT call deleteChannel', async () => {
    const { handleManagedRestored } = await import('~/rcp/channel/handleManagedRestored.js');
    const updateAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail({ _tag: 'RestError', status: 500, message: 'Internal Server Error' });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    // Should not throw — handler catches REST failures and logs a warning after retries
    await run(handleManagedRestored(event), rpcLayer, restLayer);

    // updateChannel was attempted (at least once, possibly retried)
    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);

    // deleteChannel must NOT be called
    expect(restCalls.deleteChannel).toHaveLength(0);

    // No RPC calls
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  }, 20000); // Allow up to 20 seconds for retry exhaustion
});

// ---------------------------------------------------------------------------
// handleDiscordRestored
// ---------------------------------------------------------------------------

describe('handleDiscordRestored', () => {
  it('Some discord_channel_id → updateChannel({ parent_id: null }), no deleteChannel, no RPC', async () => {
    const { handleDiscordRestored } = await import('~/rcp/channel/handleDiscordRestored.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.DiscordChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    await run(handleDiscordRestored(event), rpcLayer, restLayer);

    // Must call updateChannel once with parent_id: null
    expect(restCalls.updateChannel).toHaveLength(1);
    const updateArgs = restCalls.updateChannel[0] as any[];
    expect(updateArgs[0]).toBe(DISCORD_CHANNEL_ID);
    expect((updateArgs[1] as any).parent_id).toBeNull();

    // Must NOT call deleteChannel
    expect(restCalls.deleteChannel).toHaveLength(0);

    // Must NOT call any RPC (no team_channels row for discord-managed channels)
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('None discord_channel_id → no REST calls (no-op)', async () => {
    const { handleDiscordRestored } = await import('~/rcp/channel/handleDiscordRestored.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.DiscordChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.none(),
    });

    await run(handleDiscordRestored(event), rpcLayer, restLayer);

    expect(restCalls.updateChannel).toHaveLength(0);
    expect(restCalls.deleteChannel).toHaveLength(0);
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('REST updateChannel failure → logs warning, does NOT call deleteChannel', async () => {
    const { handleDiscordRestored } = await import('~/rcp/channel/handleDiscordRestored.js');
    const updateAttempts: unknown[][] = [];
    const { calls: restCalls, layer: restLayer } = makeRest({
      updateChannel: (...args: any[]) => {
        updateAttempts.push(args);
        return Effect.fail({ _tag: 'RestError', status: 500, message: 'Internal Server Error' });
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.DiscordChannelRestoredEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    // Should not throw — handler catches REST failures and logs a warning after retries
    await run(handleDiscordRestored(event), rpcLayer, restLayer);

    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);
    expect(restCalls.deleteChannel).toHaveLength(0);
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  }, 20000); // Allow up to 20 seconds for retry exhaustion
});
