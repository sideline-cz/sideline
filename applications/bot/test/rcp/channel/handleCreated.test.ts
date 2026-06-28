/**
 * Tests for handleCreated — role-only idempotency (Task 1) + member backfill (Task 2).
 *
 * Task 1 contract (already implemented):
 *   - role-only path (existing_channel_id=None, discord_channel_name=None) calls
 *     Channel/GetMapping FIRST (mirrors handleMemberAdded):
 *       • mapping present AND discord_role_id is Some → NO-OP (no createRoleOnly, no upsert)
 *       • no mapping → createRoleOnly + Channel/UpsertMappingRoleOnly
 *       • mapping with discord_channel_id Some but discord_role_id None →
 *           createRoleForChannel + Channel/UpsertMapping (NOT UpsertMappingRoleOnly)
 *
 * Task 2 contract (NEW — expected to fail until implementation is added):
 *   After resolving the role id (via any branch), call Channel/GetGroupMembers and
 *   backfill each member with addGuildMemberRole({ concurrency: 1 }), isolating
 *   per-member failures the same way handleRosterChannelCreated does.
 */

import type { Discord, GroupModel, Team, TeamMember } from '@sideline/domain';
import { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleCreated } from '~/rcp/channel/handleCreated.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const GROUP_ID = '00000000-0000-0000-0001-000000000100' as GroupModel.GroupId;
const MEMBER_ID_A = '00000000-0000-0000-0002-000000000001' as TeamMember.TeamMemberId;
const MEMBER_ID_B = '00000000-0000-0000-0002-000000000002' as TeamMember.TeamMemberId;
const DISCORD_USER_A = '111111111111111111' as Discord.Snowflake;
const DISCORD_USER_B = '222222222222222222' as Discord.Snowflake;
const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const EXISTING_CHANNEL_ID = '666666666666666666' as Discord.Snowflake;
const NEW_ROLE_ID = '777777777777777777' as Discord.Snowflake;
const NEW_CHANNEL_ID = '888888888888888888' as Discord.Snowflake;

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
// Fake ErrorResponse factory (matches isPermanentError check in ProcessorService)
// Shape: { _tag: 'ErrorResponse', response: { status } }
// isPermanentError reads e._tag and e.response.status — no real HttpClientResponse needed.
// ---------------------------------------------------------------------------

const makeErrorResponse = (status: number, code?: number) =>
  ({
    _tag: 'ErrorResponse',
    response: { status },
    data: code !== undefined ? { code } : {},
  }) as any;

// ---------------------------------------------------------------------------
// Log capture helper
// ---------------------------------------------------------------------------

const makeLogCapture = (): { messages: string[]; level: string[]; layer: Layer.Layer<never> } => {
  const messages: string[] = [];
  const level: string[] = [];
  const layer = Logger.layer([
    Logger.make((options) => {
      messages.push(String(options.message));
      level.push(String(options.logLevel));
    }),
  ]);
  return { messages, level, layer };
};

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type RestCallRecord = {
  createGuildRole: unknown[][];
  createGuildChannel: unknown[][];
  setChannelPermissionOverwrite: unknown[][];
  addGuildMemberRole: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    createGuildRole: [],
    createGuildChannel: [],
    setChannelPermissionOverwrite: [],
    addGuildMemberRole: [],
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
    addGuildMemberRole: (...args: any[]) => {
      calls.addGuildMemberRole.push(args);
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

type GroupMemberLike = {
  team_member_id: TeamMember.TeamMemberId;
  discord_user_id: Discord.Snowflake;
};

type RpcCallRecord = {
  GetMapping: unknown[];
  UpsertMapping: unknown[];
  UpsertMappingRoleOnly: unknown[];
  UpsertGroupChannel: unknown[];
  GetGroupMembers: unknown[];
};

const makeRpc = (
  opts: {
    mappingForGroup: Option.Option<ChannelMappingLike>;
    groupMembers?: GroupMemberLike[];
  },
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCallRecord; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCallRecord = {
    GetMapping: [],
    UpsertMapping: [],
    UpsertMappingRoleOnly: [],
    UpsertGroupChannel: [],
    GetGroupMembers: [],
  };

  const members = opts.groupMembers ?? [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Channel/GetMapping': (args: any) => {
      calls.GetMapping.push(args);
      return Effect.succeed(opts.mappingForGroup);
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
    'Channel/GetGroupMembers': (args: any) => {
      calls.GetGroupMembers.push(args);
      return Effect.succeed(members);
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
  extraLayer?: Layer.Layer<never>,
) => {
  const base = handleCreated(event).pipe(Effect.provide(Layer.merge(rpcLayer, restLayer)));
  return Effect.runPromise(extraLayer ? base.pipe(Effect.provide(extraLayer)) : base);
};

// ---------------------------------------------------------------------------
// Test helpers — two standard group members for reuse
// ---------------------------------------------------------------------------

const TWO_MEMBERS: GroupMemberLike[] = [
  { team_member_id: MEMBER_ID_A, discord_user_id: DISCORD_USER_A },
  { team_member_id: MEMBER_ID_B, discord_user_id: DISCORD_USER_B },
];

// ---------------------------------------------------------------------------
// Tests — Task 1: role-only GetMapping-first idempotency
// ---------------------------------------------------------------------------

describe('handleCreated — Task 1: role-only GetMapping-first idempotency', () => {
  /**
   * Case 1: role-only event + mapping already has discord_role_id Some
   *   → GetMapping called with correct args, NO createGuildRole, NO UpsertMappingRoleOnly
   *   → GetGroupMembers called, returns [] → addGuildMemberRole not called
   */
  it('role-only: mapping with role already set → GetMapping called with {team_id, group_id}, createRoleOnly NOT called, no upsert', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.some(existingMapping),
      groupMembers: [],
    });
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
   *   → GetGroupMembers called, returns [] → addGuildMemberRole not called
   */
  it('role-only: no mapping → GetMapping called with {team_id, group_id}, createRoleOnly once, UpsertMappingRoleOnly once', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.none(),
      groupMembers: [],
    });
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
   *   → GetGroupMembers called, returns [] → addGuildMemberRole not called
   */
  it('role-only: mapping(channel=Some, role=None) → createRoleForChannel + UpsertMapping called, UpsertMappingRoleOnly NOT called', async () => {
    const mappingWithChannelNoRole: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.none(),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.some(mappingWithChannelNoRole),
      groupMembers: [],
    });
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

// ---------------------------------------------------------------------------
// Tests — Task 2: member backfill after role resolution
// ---------------------------------------------------------------------------

describe('handleCreated — Task 2: member backfill after role resolution', () => {
  /**
   * Test 1: existing_channel_id=Some branch backfills
   *   - createGuildRole ×1 (via createRoleForChannel)
   *   - UpsertMapping ×1
   *   - GetGroupMembers ×1
   *   - addGuildMemberRole ×2 with the newly created role id
   */
  it('existing_channel_id=Some branch: createRoleForChannel + UpsertMapping + GetGroupMembers + addGuildMemberRole ×2 with new role id', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.none(), // not consulted for existing_channel_id=Some branch
      groupMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(
      makeRoleOnlyCreatedEvent({ existing_channel_id: Option.some(EXISTING_CHANNEL_ID) }),
      rpcLayer,
      restLayer,
    );

    // Role creation via createRoleForChannel
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Mapping upserted
    expect(rpcCalls.UpsertMapping).toHaveLength(1);
    // GetGroupMembers called with correct args
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    const getGroupMembersArg = rpcCalls.GetGroupMembers[0] as {
      team_id: Team.TeamId;
      group_id: GroupModel.GroupId;
    };
    expect(getGroupMembersArg.team_id).toBe(TEAM_ID);
    expect(getGroupMembersArg.group_id).toBe(GROUP_ID);
    // Members backfilled with new role id
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * Test 2: discord_channel_name=Some branch backfills
   *   - createGuildChannel ×1
   *   - UpsertGroupChannel ×1
   *   - createGuildRole ×1
   *   - UpsertMapping ×1
   *   - GetGroupMembers ×1
   *   - addGuildMemberRole ×2 with new role id
   */
  it('discord_channel_name=Some branch: createGuildChannel + UpsertGroupChannel + createGuildRole + UpsertMapping + GetGroupMembers + addGuildMemberRole ×2 with new role id', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.none(), // not consulted for discord_channel_name=Some branch
      groupMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(
      makeRoleOnlyCreatedEvent({ discord_channel_name: Option.some('│goalkeepers') }),
      rpcLayer,
      restLayer,
    );

    // Channel created
    expect(restCalls.createGuildChannel).toHaveLength(1);
    // Channel id persisted before role
    expect(rpcCalls.UpsertGroupChannel).toHaveLength(1);
    // Role created
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Full mapping upserted
    expect(rpcCalls.UpsertMapping).toHaveLength(1);
    // GetGroupMembers called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    // Members backfilled
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * Test 3 (THE BUG): role-only, mapping has role (Some) → reuse + backfill
   *   This is the core regression: before the fix, the reuse path did nothing after
   *   finding an existing role. After the fix it must still call GetGroupMembers and
   *   addGuildMemberRole with the EXISTING role id.
   *
   *   - GetMapping ×1
   *   - createGuildRole ×0 (role reused)
   *   - UpsertMapping ×0 (no write)
   *   - UpsertMappingRoleOnly ×0 (no write)
   *   - GetGroupMembers ×1
   *   - addGuildMemberRole ×2 each with EXISTING_ROLE_ID
   */
  it('role-only, mapping has role → reuse + backfill: GetMapping ×1, no createGuildRole, no UpsertMapping*, GetGroupMembers ×1, addGuildMemberRole ×2 with EXISTING_ROLE_ID', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.some(existingMapping),
      groupMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // GetMapping consulted
    expect(rpcCalls.GetMapping).toHaveLength(1);
    // Role NOT created — reuse existing
    expect(restCalls.createGuildRole).toHaveLength(0);
    // No mapping writes
    expect(rpcCalls.UpsertMapping).toHaveLength(0);
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(0);
    // GetGroupMembers called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    // Members backfilled with EXISTING role id (not a new one)
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(EXISTING_ROLE_ID);
    }
  });

  /**
   * Test 4: role-only, no mapping → create role + backfill
   *   - createGuildRole ×1
   *   - UpsertMappingRoleOnly ×1
   *   - UpsertMapping ×0
   *   - GetGroupMembers ×1
   *   - addGuildMemberRole ×2 with new role id
   */
  it('role-only, no mapping → createRoleOnly + UpsertMappingRoleOnly + GetGroupMembers + addGuildMemberRole ×2 with new role id', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.none(),
      groupMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // Role created
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Role-only upsert written
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(1);
    // Full mapping NOT written
    expect(rpcCalls.UpsertMapping).toHaveLength(0);
    // GetGroupMembers called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    // Members backfilled with new role id
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * Test 5: role-only, mapping channel=Some role=None → createRoleForChannel + backfill
   *   - createGuildRole ×1
   *   - UpsertMapping ×1 with discord_channel_id = EXISTING_CHANNEL_ID
   *   - UpsertMappingRoleOnly ×0
   *   - GetGroupMembers ×1
   *   - addGuildMemberRole ×2 with new role id
   */
  it('role-only, mapping(channel=Some, role=None) → createRoleForChannel + UpsertMapping + GetGroupMembers + addGuildMemberRole ×2 with new role id', async () => {
    const mappingWithChannelNoRole: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.none(),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.some(mappingWithChannelNoRole),
      groupMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // Role created
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Full mapping upserted with existing channel id
    expect(rpcCalls.UpsertMapping).toHaveLength(1);
    const upsertArgs = rpcCalls.UpsertMapping[0] as {
      discord_channel_id: Discord.Snowflake;
    };
    expect(upsertArgs.discord_channel_id).toBe(EXISTING_CHANNEL_ID);
    // Role-only upsert NOT called
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(0);
    // GetGroupMembers called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    // Members backfilled with new role id
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * Test 6: per-member failure isolation
   *   - mapping has role (Some) → reuse path
   *   - member A's addGuildMemberRole returns permanent 404 → no retry
   *   - member B succeeds
   *   - handler resolves successfully (no throw)
   *   - exactly 2 addGuildMemberRole attempts (no retry on permanent error)
   *   - member B added with EXISTING_ROLE_ID
   *   - ≥1 Warn log captured for the failed member
   */
  it('per-member failure isolation: member A fails (404 permanent), member B succeeds; handler does not throw, 2 attempts total, warning logged', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.some(existingMapping),
      groupMembers: TWO_MEMBERS,
    });

    const addRoleCallArgs: unknown[][] = [];
    let addRoleCallCount = 0;
    const { layer: restLayer } = makeRest({
      addGuildMemberRole: (...args: any[]) => {
        addRoleCallCount++;
        addRoleCallArgs.push(args);
        // First call (DISCORD_USER_A) fails with a permanent 404 — no retry should occur.
        // isPermanentError classifies _tag=ErrorResponse + status=404 as permanent.
        if (addRoleCallCount === 1) {
          return Effect.fail(makeErrorResponse(404, 10007 /* Unknown Member */));
        }
        // Second call (DISCORD_USER_B) succeeds
        return Effect.void;
      },
    });

    const { messages, level: logLevels, layer: logLayer } = makeLogCapture();

    // The handler must NOT throw even though one member add failed
    const result = await runHandleCreated(
      makeRoleOnlyCreatedEvent(),
      rpcLayer,
      restLayer,
      logLayer,
    );
    expect(result).toBeUndefined();

    // GetGroupMembers was called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);

    // Exactly 2 addGuildMemberRole attempts — no retries on permanent errors
    expect(addRoleCallCount).toBe(2);

    // Member B's call must carry DISCORD_USER_B and EXISTING_ROLE_ID
    const memberBCall = addRoleCallArgs[1] as [string, string, string];
    expect(memberBCall).toBeDefined();
    expect(memberBCall[1]).toBe(DISCORD_USER_B);
    expect(memberBCall[2]).toBe(EXISTING_ROLE_ID);

    // A warning must have been logged for member A's failure
    const warnCount = logLevels.filter((l) => l.includes('Warn') || l.includes('Warning')).length;
    const msgCount = messages.filter(
      (m) => m.includes('404') || m.toLowerCase().includes('warn'),
    ).length;
    expect(warnCount + msgCount).toBeGreaterThan(0);
  });

  /**
   * Test 7: zero members → no addGuildMemberRole calls, role still resolved/created
   *   - GetGroupMembers ×1 (returns [])
   *   - addGuildMemberRole ×0
   *   - Role still handled per its branch (createGuildRole ×1 for no-mapping path)
   */
  it('zero members: GetGroupMembers ×1 (returns []), addGuildMemberRole ×0, role still created on no-mapping path', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      mappingForGroup: Option.none(),
      groupMembers: [],
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleCreated(makeRoleOnlyCreatedEvent(), rpcLayer, restLayer);

    // GetGroupMembers called
    expect(rpcCalls.GetGroupMembers).toHaveLength(1);
    // No member role adds
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
    // Role still created (no-mapping path)
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Mapping still upserted
    expect(rpcCalls.UpsertMappingRoleOnly).toHaveLength(1);
  });
});
