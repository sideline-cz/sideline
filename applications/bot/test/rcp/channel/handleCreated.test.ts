/**
 * Tests for Task 1 — bot handleCreated role-only idempotency.
 *
 * The contract after Task 1 is implemented:
 *   - role-only path (existing_channel_id=None, discord_channel_name=None) calls
 *     Channel/GetMapping FIRST (mirrors handleMemberAdded):
 *       • mapping present AND discord_role_id is Some → NO-OP (no createRoleOnly, no upsert)
 *       • no mapping → createRoleOnly + Channel/UpsertMappingRoleOnly
 *       • mapping with discord_channel_id Some but discord_role_id None →
 *           createRoleForChannel + Channel/UpsertMapping (NOT UpsertMappingRoleOnly)
 */

import type { Discord, GroupModel, Team } from '@sideline/domain';
import { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleCreated } from '~/rcp/channel/handleCreated.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0001-000000000100' as GroupModel.GroupId;
const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const EXISTING_CHANNEL_ID = '666666666666666666' as Discord.Snowflake;
const NEW_ROLE_ID = '777777777777777777' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Event factory helpers
// ---------------------------------------------------------------------------

const makeRoleOnlyCreatedEvent = (
  overrides: Partial<{
    existing_channel_id: Option.Option<Discord.Snowflake>;
    discord_channel_name: Option.Option<string>;
  }> = {},
): ChannelRpcEvents.GroupChannelCreatedEvent =>
  new ChannelRpcEvents.GroupChannelCreatedEvent({
    id: 'evt-created-001' as never,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    group_id: GROUP_ID,
    group_name: 'Goalkeepers',
    existing_channel_id: Option.none<Discord.Snowflake>(),
    discord_channel_name: Option.none<string>(),
    discord_role_name: 'Goalkeepers',
    discord_role_color: Option.none<number>(),
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
      return Effect.succeed({ id: 'new-channel-id', parent_id: null });
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
        // Fail on unexpected method calls so misrouted calls are caught
        return (...args: unknown[]) => {
          throw new Error(`Unexpected DiscordREST.${prop} call with args: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

type ChannelMappingLike = {
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

type RpcCallRecord = {
  GetMapping: unknown[];
  UpsertMapping: unknown[];
  UpsertMappingRoleOnly: unknown[];
  UpsertGroupChannel: unknown[];
};

const makeRpc = (
  mappingForGroup: Option.Option<ChannelMappingLike>,
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCallRecord; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCallRecord = {
    GetMapping: [],
    UpsertMapping: [],
    UpsertMappingRoleOnly: [],
    UpsertGroupChannel: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Channel/GetMapping': (args: any) => {
      calls.GetMapping.push(args);
      return Effect.succeed(mappingForGroup);
    },
    'Channel/UpsertMapping': (args: any) => {
      calls.UpsertMapping.push(args);
      return Effect.void;
    },
    'Channel/UpsertMappingRoleOnly': (args: any) => {
      calls.UpsertMappingRoleOnly.push(args);
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

const runHandleCreated = (
  event: ChannelRpcEvents.GroupChannelCreatedEvent,
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
) => Effect.runPromise(handleCreated(event).pipe(Effect.provide(Layer.merge(rpcLayer, restLayer))));

// ---------------------------------------------------------------------------
// Tests — Task 1: role-only GetMapping-first idempotency
// ---------------------------------------------------------------------------

describe('handleCreated — Task 1: role-only GetMapping-first idempotency', () => {
  /**
   * Case 1: role-only event + mapping already has discord_role_id Some
   *   → GetMapping called with correct args, NO createGuildRole, NO UpsertMappingRoleOnly
   */
  it('role-only: mapping with role already set → GetMapping called with {team_id, group_id}, createRoleOnly NOT called, no upsert', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.some(existingMapping));
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // GetMapping must have been consulted exactly once with the correct args
    expect(rpcCalls.GetMapping).toHaveLength(1);
    const getMappingArg = rpcCalls.GetMapping[0] as {
      team_id: Team.TeamId;
      group_id: GroupModel.GroupId;
    };
    expect(getMappingArg.team_id).toBe(TEAM_ID);
    expect(getMappingArg.group_id).toBe(GROUP_ID);

    // No role creation — role already exists
    expect(restCalls.createGuildRole).toHaveLength(0);

    // No upsert writes
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(0);
    expect(rpcCalls.UpsertMapping).toHaveLength(0);
  });

  /**
   * Case 2: role-only event + no mapping at all
   *   → GetMapping called, createRoleOnly once, UpsertMappingRoleOnly once, UpsertMapping NOT called
   */
  it('role-only: no mapping → GetMapping called with {team_id, group_id}, createRoleOnly once, UpsertMappingRoleOnly once', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.none());
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // GetMapping must have been consulted with the correct args
    expect(rpcCalls.GetMapping).toHaveLength(1);
    const getMappingArg = rpcCalls.GetMapping[0] as {
      team_id: Team.TeamId;
      group_id: GroupModel.GroupId;
    };
    expect(getMappingArg.team_id).toBe(TEAM_ID);
    expect(getMappingArg.group_id).toBe(GROUP_ID);

    // Role must be created exactly once
    expect(restCalls.createGuildRole).toHaveLength(1);

    // Role-only upsert written exactly once
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(1);

    // Full mapping upsert NOT called (role-only path)
    expect(rpcCalls.UpsertMapping).toHaveLength(0);
  });

  /**
   * Case 3: role-only event + mapping with discord_channel_id Some but discord_role_id None
   *   → createRoleForChannel (not createRoleOnly) + UpsertMapping (not UpsertMappingRoleOnly)
   *   → UpsertMapping receives discord_channel_id = EXISTING_CHANNEL_ID
   */
  it('role-only: mapping(channel=Some, role=None) → createRoleForChannel + UpsertMapping called, UpsertMappingRoleOnly NOT called', async () => {
    const mappingWithChannelNoRole: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.none(),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.some(mappingWithChannelNoRole));
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // GetMapping must have been consulted with the correct args
    expect(rpcCalls.GetMapping).toHaveLength(1);
    const getMappingArg = rpcCalls.GetMapping[0] as {
      team_id: Team.TeamId;
      group_id: GroupModel.GroupId;
    };
    expect(getMappingArg.team_id).toBe(TEAM_ID);
    expect(getMappingArg.group_id).toBe(GROUP_ID);

    // A role must be created (for the existing channel — the channel+role path)
    expect(restCalls.createGuildRole).toHaveLength(1);

    // Full mapping upsert (channel + role) called with existing channel id
    expect(rpcCalls.UpsertMapping).toHaveLength(1);
    const upsertArgs = rpcCalls.UpsertMapping[0] as {
      discord_channel_id: Discord.Snowflake;
      discord_role_id: Discord.Snowflake;
    };
    expect(upsertArgs.discord_channel_id).toBe(EXISTING_CHANNEL_ID);

    // Role-only upsert must NOT be called — the channel+role path was used
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(0);
  });
});
