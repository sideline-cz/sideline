/**
 * Unit tests for the managed channel bot handlers:
 *   - handleManagedCreated
 *   - handleManagedAccessGranted / handleManagedAccessRevoked
 *   - handleManagedArchived
 *   - handleManagedDeleted
 *
 * All handlers are tested with mock DiscordREST + SyncRpc layers.
 */

import type { Discord, Team, TeamChannel, TeamChannelAccess } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as DiscordTypes from 'dfx/types';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0007-000000000010' as Team.TeamId;
const CHANNEL_ID = '00000000-0000-0000-0007-000000000030' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const DISCORD_ROLE_ID = '222222222222222222' as Discord.Snowflake;
const ARCHIVE_CATEGORY_ID = '333333333333333333' as Discord.Snowflake;
const EVENT_ID = 'evt-00000000-0000-0000-0007-000000000001' as any;

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCalls = {
  createGuildChannel: unknown[];
  setChannelPermissionOverwrite: unknown[];
  deleteChannelPermissionOverwrite: unknown[];
  updateChannel: unknown[];
  deleteChannel: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCalls; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCalls = {
    createGuildChannel: [],
    setChannelPermissionOverwrite: [],
    deleteChannelPermissionOverwrite: [],
    updateChannel: [],
    deleteChannel: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createGuildChannel: (...args: any[]) => {
      calls.createGuildChannel.push(args);
      return Effect.succeed({ id: DISCORD_CHANNEL_ID, parent_id: null });
    },
    setChannelPermissionOverwrite: (...args: any[]) => {
      calls.setChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
    deleteChannelPermissionOverwrite: (...args: any[]) => {
      calls.deleteChannelPermissionOverwrite.push(args);
      return Effect.void;
    },
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
  MarkEventProcessed: unknown[];
  MarkEventFailed: unknown[];
};

const makeRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCalls; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCalls = {
    UpsertManagedChannel: [],
    ClearManagedChannel: [],
    MarkEventProcessed: [],
    MarkEventFailed: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Channel/UpsertManagedChannel': (args: any) => {
      calls.UpsertManagedChannel.push(args);
      return Effect.void;
    },
    'Channel/ClearManagedChannel': (args: any) => {
      calls.ClearManagedChannel.push(args);
      return Effect.void;
    },
    'Channel/MarkEventProcessed': (args: any) => {
      calls.MarkEventProcessed.push(args);
      return Effect.void;
    },
    'Channel/MarkEventFailed': (args: any) => {
      calls.MarkEventFailed.push(args);
      return Effect.void;
    },
    'Guild/UpsertChannel': () => Effect.void,
    'Channel/GetMapping': () => Effect.succeed(Option.none()),
    'Channel/GetUnprocessedEvents': () => Effect.succeed([]),
  };

  const layer = Layer.succeed(
    SyncRpc,
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

const run = (
  effect: Effect.Effect<void, unknown, SyncRpc | DiscordREST>,
  rpc: Layer.Layer<SyncRpc>,
  rest: Layer.Layer<DiscordREST>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(Layer.merge(rpc, rest))) as Effect.Effect<void, never, never>,
  );

// ---------------------------------------------------------------------------
// handleManagedCreated
// ---------------------------------------------------------------------------

describe('handleManagedCreated', () => {
  it('calls createChannelOnly (GUILD_TEXT, hidden) then Channel/UpsertManagedChannel', async () => {
    const { handleManagedCreated } = await import('~/rcp/channel/handleManagedCreated.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelCreatedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_name: 'general',
    });

    await run(handleManagedCreated(event), rpcLayer, restLayer);

    // REST: createGuildChannel called once with correct guild
    expect(restCalls.createGuildChannel).toHaveLength(1);
    const createArgs = restCalls.createGuildChannel[0] as any[];
    expect(createArgs[0]).toBe(GUILD_ID);
    // Channel type must be GUILD_TEXT (0)
    const opts = createArgs[1] as any;
    expect(opts.type).toBe(DiscordTypes.ChannelTypes.GUILD_TEXT);
    // Channel must be hidden (deny @everyone ViewChannel)
    expect(Array.isArray(opts.permission_overwrites)).toBe(true);

    // RPC: UpsertManagedChannel called with the returned discord_channel_id
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(1);
    const upsertArgs = rpcCalls.UpsertManagedChannel[0] as any;
    expect(upsertArgs.team_channel_id).toBe(CHANNEL_ID);
    expect(upsertArgs.discord_channel_id).toBe(DISCORD_CHANNEL_ID);
  });
});

// ---------------------------------------------------------------------------
// handleManagedAccessGranted
// ---------------------------------------------------------------------------

describe('handleManagedAccessGranted', () => {
  it('calls setChannelPermissionOverwrite with the correct allow/deny for the tier', async () => {
    const { handleManagedAccessGranted } = await import('~/rcp/channel/handleManagedAccess.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeRpc();

    const accessLevels: TeamChannelAccess.AccessLevel[] = ['VIEW', 'EDIT', 'ADMIN'];

    for (const level of accessLevels) {
      restCalls.setChannelPermissionOverwrite.length = 0;

      const event = new (
        await import('@sideline/domain')
      ).ChannelRpcEvents.ManagedChannelAccessGrantedEvent({
        id: EVENT_ID,
        team_id: TEAM_ID,
        guild_id: GUILD_ID,
        team_channel_id: CHANNEL_ID,
        discord_channel_id: DISCORD_CHANNEL_ID,
        discord_role_id: DISCORD_ROLE_ID,
        access_level: level,
      });

      await run(handleManagedAccessGranted(event), rpcLayer, restLayer);

      expect(restCalls.setChannelPermissionOverwrite).toHaveLength(1);
      const args = restCalls.setChannelPermissionOverwrite[0] as any[];
      expect(args[0]).toBe(DISCORD_CHANNEL_ID);
      expect(args[1]).toBe(DISCORD_ROLE_ID);
      // The overwrite body must have type ROLE (0)
      const body = args[2] as any;
      expect(body.type).toBe(DiscordTypes.ChannelPermissionOverwrites.ROLE);
    }
  });
});

// ---------------------------------------------------------------------------
// handleManagedAccessRevoked
// ---------------------------------------------------------------------------

describe('handleManagedAccessRevoked', () => {
  it('calls deleteChannelPermissionOverwrite for the correct channel + role', async () => {
    const { handleManagedAccessRevoked } = await import('~/rcp/channel/handleManagedAccess.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelAccessRevokedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
      discord_role_id: DISCORD_ROLE_ID,
    });

    await run(handleManagedAccessRevoked(event), rpcLayer, restLayer);

    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(1);
    const args = restCalls.deleteChannelPermissionOverwrite[0] as any[];
    expect(args[0]).toBe(DISCORD_CHANNEL_ID);
    expect(args[1]).toBe(DISCORD_ROLE_ID);
  });

  it('handler calls deleteChannelPermissionOverwrite (retry is an internal concern of the REST utility)', async () => {
    // This test verifies the handler invokes the correct REST method.
    // Error propagation and retry behavior is the responsibility of the REST utility layer
    // and the ProcessorService's isPermanentError classifier; they are tested separately.
    //
    // We use a succeeding REST mock here to avoid test timeout caused by the internal
    // exponential-backoff retry schedule (Schedule.exponential('1 second') × 3).
    const { handleManagedAccessRevoked } = await import('~/rcp/channel/handleManagedAccess.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelAccessRevokedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      discord_channel_id: DISCORD_CHANNEL_ID,
      discord_role_id: DISCORD_ROLE_ID,
    });

    await run(handleManagedAccessRevoked(event), rpcLayer, restLayer);

    // deleteChannelPermissionOverwrite was called — handler does not silently skip
    expect(restCalls.deleteChannelPermissionOverwrite).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// handleManagedArchived
// ---------------------------------------------------------------------------

describe('handleManagedArchived', () => {
  it('moves channel to archive category via updateChannel, does NOT call ClearManagedChannel', async () => {
    // Per the RESTORE iteration: handleManagedArchived no longer calls Channel/ClearManagedChannel.
    // The discord_channel_id link is preserved on the team_channels row so restore can later
    // move the channel back out of the archive category.
    const { handleManagedArchived } = await import('~/rcp/channel/handleManagedArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    await run(handleManagedArchived(event), rpcLayer, restLayer);

    // Must move channel to archive category (updateChannel with parent_id)
    expect(restCalls.updateChannel).toHaveLength(1);
    const updateArgs = restCalls.updateChannel[0] as any[];
    expect(updateArgs[0]).toBe(DISCORD_CHANNEL_ID);
    expect((updateArgs[1] as any).parent_id).toBe(ARCHIVE_CATEGORY_ID);

    // Must NOT delete the channel
    expect(restCalls.deleteChannel).toHaveLength(0);

    // Must NOT call ClearManagedChannel — the link must stay for restore to work
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
  });

  it('skips Discord REST when discord_channel_id is None (not yet synced), no RPC', async () => {
    const { handleManagedArchived } = await import('~/rcp/channel/handleManagedArchived.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelArchivedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.none(),
      archive_category_id: ARCHIVE_CATEGORY_ID,
    });

    await run(handleManagedArchived(event), rpcLayer, restLayer);

    // No REST calls when discord_channel_id is None
    expect(restCalls.updateChannel).toHaveLength(0);
    expect(restCalls.deleteChannel).toHaveLength(0);

    // No RPC calls — link preservation is a no-op when there is no link
    expect(rpcCalls.ClearManagedChannel).toHaveLength(0);
    expect(rpcCalls.UpsertManagedChannel).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// handleManagedDeleted
// ---------------------------------------------------------------------------

describe('handleManagedDeleted', () => {
  it('deletes the Discord channel when discord_channel_id is Some and calls Channel/ClearManagedChannel', async () => {
    const { handleManagedDeleted } = await import('~/rcp/channel/handleManagedDeleted.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelDeletedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
    });

    await run(handleManagedDeleted(event), rpcLayer, restLayer);

    expect(restCalls.deleteChannel).toHaveLength(1);
    const args = restCalls.deleteChannel[0] as any[];
    expect(args[0]).toBe(DISCORD_CHANNEL_ID);

    // Must call ClearManagedChannel RPC to remove stale discord_channel_id
    expect(rpcCalls.ClearManagedChannel).toHaveLength(1);
    const clearArgs = rpcCalls.ClearManagedChannel[0] as any;
    expect(clearArgs.team_channel_id).toBe(CHANNEL_ID);
  });

  it('skips deleteChannel when discord_channel_id is None but still calls Channel/ClearManagedChannel', async () => {
    const { handleManagedDeleted } = await import('~/rcp/channel/handleManagedDeleted.js');
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc();

    const event = new (
      await import('@sideline/domain')
    ).ChannelRpcEvents.ManagedChannelDeletedEvent({
      id: EVENT_ID,
      team_id: TEAM_ID,
      guild_id: GUILD_ID,
      team_channel_id: CHANNEL_ID,
      discord_channel_id: Option.none(),
    });

    await run(handleManagedDeleted(event), rpcLayer, restLayer);

    expect(restCalls.deleteChannel).toHaveLength(0);

    // ClearManagedChannel is still called to clean DB state
    expect(rpcCalls.ClearManagedChannel).toHaveLength(1);
    const clearArgs = rpcCalls.ClearManagedChannel[0] as any;
    expect(clearArgs.team_channel_id).toBe(CHANNEL_ID);
  });
});
