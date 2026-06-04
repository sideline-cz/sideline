/**
 * Unit tests for the Discord-managed channel archive handler:
 *   - handleDiscordArchived
 *
 * Key invariants (per Epic 8.1 spec):
 *   - Moves channel to archive category via REST updateChannel (parent_id).
 *   - NO deleteChannel fallback (we must never delete channels the admin didn't create through Sideline).
 *   - NO Channel/ClearManagedChannel or Channel/UpsertManagedChannel RPC (no team_channels row).
 *   - discord_channel_id None → no-op (no REST calls).
 *   - REST updateChannel failure → logs warning, does NOT call deleteChannel.
 */

import type { Discord, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0008-000000000010' as Team.TeamId;
const DISCORD_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const ARCHIVE_CATEGORY_ID = '333333333333333333' as Discord.Snowflake;
const EVENT_ID = 'evt-00000000-0000-0000-0008-000000000001' as any;

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
// handleDiscordArchived
// ---------------------------------------------------------------------------

describe('handleDiscordArchived', () => {
  it('moves channel to archive category via updateChannel and does NOT call deleteChannel', async () => {
    const { handleDiscordArchived } = await import('~/rcp/channel/handleDiscordArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.DiscordChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    await run(handleDiscordArchived(event), rpcLayer, restLayer);

    // Must call updateChannel with the channel id and parent_id = archive category
    expect(restCalls.updateChannel).toHaveLength(1);
    const updateArgs = restCalls.updateChannel[0] as any[];
    expect(updateArgs[0]).toBe(DISCORD_CHANNEL_ID);
    expect((updateArgs[1] as any).parent_id).toBe(ARCHIVE_CATEGORY_ID);

    // Must NOT call deleteChannel (no delete-fallback for discord-managed channels)
    expect(restCalls.deleteChannel).toHaveLength(0);

    // Must NOT call Channel/ClearManagedChannel or Channel/UpsertManagedChannel
    // (there is no team_channels row for discord-managed channels)
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('discord_channel_id None → no REST calls (no-op)', async () => {
    const { handleDiscordArchived } = await import('~/rcp/channel/handleDiscordArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.DiscordChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.none(),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    await run(handleDiscordArchived(event), rpcLayer, restLayer);

    // No REST calls when discord_channel_id is None
    expect(restCalls.updateChannel).toHaveLength(0);
    expect(restCalls.deleteChannel).toHaveLength(0);

    // No RPC calls
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });

  it('REST updateChannel fails → logs warning, does NOT call deleteChannel', async () => {
    const { handleDiscordArchived } = await import('~/rcp/channel/handleDiscordArchived.js');
    // Override updateChannel to simulate a persistent REST failure.
    // Note: the handler uses Effect.retry(retryPolicy) (exponential 1s × 3) before catching,
    // so this test needs a generous timeout to allow all retry attempts to exhaust.
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
    ).ChannelRpcEvents.DiscordChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    // Should not throw — the handler catches REST failures and logs a warning after retries
    await run(handleDiscordArchived(event), rpcLayer, restLayer);

    // updateChannel was attempted (at least once, possibly retried)
    expect(updateAttempts.length).toBeGreaterThanOrEqual(1);

    // deleteChannel must NOT be called after failure (no delete-fallback for discord channels)
    expect(restCalls.deleteChannel).toHaveLength(0);

    // No RPC calls (no team_channels row for discord-managed channels)
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  }, 20000); // Allow up to 20 seconds — the retry policy is exponential(1s)×3 = ~7s of waits
});
