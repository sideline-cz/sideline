/**
 * TDD tests for the refactored handleMemberAdded handler (B4).
 *
 * These tests describe the NEW behavior after the decouple-role-from-channel
 * refactor and are expected to FAIL until the bot is updated.
 *
 * NEW contract:
 *   - handleMemberAdded NEVER calls createGuildChannel (REST).
 *   - No mapping → createRoleOnly (new helper) + Channel/UpsertMappingRoleOnly + addGuildMemberRole.
 *   - Mapping with channel_id=Some, role_id=None → createRoleForChannel + Channel/UpsertMapping + addGuildMemberRole.
 *   - Mapping with channel_id=Some, role_id=Some → addGuildMemberRole only.
 *
 * TODO: When richer integration-test scaffolding is available (fake REST + real Effect runtime),
 * replace these unit-level assertions with full integration flows.
 */

import type { ChannelRpcEvents, Discord, GroupModel, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0000-000000000100' as GroupModel.GroupId;
const GROUP_NAME = 'Goalkeepers';
const TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000020';
const DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;
const CHANNEL_ID_X = '222222222222222222' as Discord.Snowflake;
const ROLE_ID_Y = '333333333333333333' as Discord.Snowflake;
const NEW_ROLE_ID = '444444444444444444';

const makeEvent = (
  overrides: Partial<ChannelRpcEvents.GroupMemberAddedEvent> = {},
): ChannelRpcEvents.GroupMemberAddedEvent =>
  new // Dynamic import workaround — actual type is used for signature only
  // The real GroupMemberAddedEvent constructor is used at runtime
  (require('@sideline/domain').ChannelRpcEvents.GroupMemberAddedEvent)({
    id: 'evt-001' as any,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    group_id: GROUP_ID,
    group_name: GROUP_NAME,
    team_member_id: TEAM_MEMBER_ID as any,
    discord_user_id: DISCORD_USER_ID,
    ...overrides,
  });

// ---------------------------------------------------------------------------
// Mock builder helpers
// ---------------------------------------------------------------------------

type RestCallRecord = {
  createGuildChannel: unknown[];
  createGuildRole: unknown[];
  addGuildMemberRole: unknown[];
  setChannelPermissionOverwrite: unknown[];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    createGuildChannel: [],
    createGuildRole: [],
    addGuildMemberRole: [],
    setChannelPermissionOverwrite: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    createGuildChannel: (...args: any[]) => {
      calls.createGuildChannel.push(args);
      return Effect.succeed({ id: 'new-channel-id', parent_id: null });
    },
    createGuildRole: (...args: any[]) => {
      calls.createGuildRole.push(args);
      return Effect.succeed({ id: NEW_ROLE_ID });
    },
    addGuildMemberRole: (...args: any[]) => {
      calls.addGuildMemberRole.push(args);
      return Effect.void;
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
        // For unknown methods not tracked — return a no-op so tests don't crash on
        // auxiliary REST calls we don't care about in a given test.
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

type RpcCallRecord = {
  GetMapping: unknown[];
  UpsertMapping: unknown[];
  UpsertMappingRoleOnly: unknown[];
};

type ChannelMappingLike = {
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

const makeRpc = (
  mappingForGroup: Option.Option<ChannelMappingLike>,
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCallRecord; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCallRecord = {
    GetMapping: [],
    UpsertMapping: [],
    UpsertMappingRoleOnly: [],
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
    'Channel/MarkEventProcessed': () => Effect.void,
    'Guild/UpsertChannel': () => Effect.void,
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (!fn) return () => Effect.void;
        return fn;
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Handler invocation helper
// ---------------------------------------------------------------------------

const runHandleMemberAdded = async (
  event: ChannelRpcEvents.GroupMemberAddedEvent,
  rpcLayer: Layer.Layer<SyncRpc>,
  restLayer: Layer.Layer<DiscordREST>,
) => {
  // Dynamic import — will fail until the refactored handler exists at this path
  const { handleMemberAdded } = await import('~/rcp/channel/handleMemberAdded.js');
  return Effect.runPromise(
    handleMemberAdded(event).pipe(Effect.provide(Layer.merge(rpcLayer, restLayer))),
  );
};

// ---------------------------------------------------------------------------
// Tests (B4)
// ---------------------------------------------------------------------------

describe('handleMemberAdded — B4: never creates channels, only roles', () => {
  /**
   * Test 13: No mapping for the group → handler calls createRoleOnly (new helper),
   * upserts role-only mapping via Channel/UpsertMappingRoleOnly, then addGuildMemberRole.
   * Assert NO createGuildChannel REST call was made.
   */
  it('B4-13: no mapping → createRoleOnly + UpsertMappingRoleOnly + addGuildMemberRole, NO createGuildChannel', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.none());
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleMemberAdded(makeEvent(), rpcLayer, restLayer);

    // MUST NOT create a channel
    expect(restCalls.createGuildChannel).toHaveLength(0);

    // MUST create a role
    expect(restCalls.createGuildRole).toHaveLength(1);

    // MUST upsert role-only mapping (no channel_id in payload)
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(1);
    expect(rpcCalls.UpsertMapping).toHaveLength(0);

    // MUST assign role to the member
    expect(restCalls.addGuildMemberRole).toHaveLength(1);
  });

  /**
   * Test 14: Mapping with channel_id=Some(X), role_id=None → createRoleForChannel,
   * upsert via Channel/UpsertMapping, then addGuildMemberRole. Still no createGuildChannel.
   */
  it('B4-14: mapping(channel=Some, role=None) → createRoleForChannel + UpsertMapping + addGuildMemberRole, NO createGuildChannel', async () => {
    const mapping: ChannelMappingLike = {
      discord_channel_id: Option.some(CHANNEL_ID_X),
      discord_role_id: Option.none(),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.some(mapping));
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleMemberAdded(makeEvent(), rpcLayer, restLayer);

    // MUST NOT create a channel
    expect(restCalls.createGuildChannel).toHaveLength(0);

    // MUST create a role (for the existing channel)
    expect(restCalls.createGuildRole).toHaveLength(1);

    // MUST upsert full mapping (channel + role)
    expect(rpcCalls.UpsertMapping).toHaveLength(1);
    const upsertArgs = rpcCalls.UpsertMapping[0] as any;
    expect(upsertArgs.discord_channel_id).toBe(CHANNEL_ID_X);

    // MUST assign the new role to the member
    expect(restCalls.addGuildMemberRole).toHaveLength(1);
  });

  /**
   * Test 15: Mapping with channel_id=Some(X), role_id=Some(Y) → just addGuildMemberRole.
   * No role/channel creation.
   */
  it('B4-15: mapping(channel=Some, role=Some) → addGuildMemberRole only, no creation', async () => {
    const mapping: ChannelMappingLike = {
      discord_channel_id: Option.some(CHANNEL_ID_X),
      discord_role_id: Option.some(ROLE_ID_Y),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(Option.some(mapping));
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleMemberAdded(makeEvent(), rpcLayer, restLayer);

    // MUST NOT create anything
    expect(restCalls.createGuildChannel).toHaveLength(0);
    expect(restCalls.createGuildRole).toHaveLength(0);

    // MUST NOT upsert any mapping
    expect(rpcCalls.UpsertMapping).toHaveLength(0);
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(0);

    // MUST assign the existing role to the member
    expect(restCalls.addGuildMemberRole).toHaveLength(1);
    const addArgs = restCalls.addGuildMemberRole[0] as any[];
    // addGuildMemberRole(guildId, userId, roleId) — roleId must be ROLE_ID_Y
    expect(addArgs).toContain(ROLE_ID_Y);
  });
});
