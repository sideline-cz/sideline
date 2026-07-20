/**
 * TDD tests for handleRosterChannelCreated — idempotency + member backfill.
 *
 * These tests describe NEW behavior after the bug fix is implemented and are
 * expected to FAIL until the bot's handleRosterChannelCreated is updated.
 *
 * Contracts (new behavior to be added):
 *   (a) mapping+role already exist (GetRosterMapping returns Some with discord_role_id=Some)
 *       → createGuildRole / createDiscordChannelAndRole / createRoleForChannel NOT called
 *       → UpsertRosterMapping NOT called, UpdateRosterChannel NOT called
 *       → GetRosterMembers called → addGuildMemberRole called once per member (2 members → 2 calls)
 *         with the EXISTING role id
 *   (b) no mapping (GetRosterMapping returns None)
 *       → create path runs (role created once via createDiscordChannelAndRole or createRoleForChannel)
 *       → UpsertRosterMapping + UpdateRosterChannel called
 *       → then 2 members backfilled (addGuildMemberRole ×2)
 *   (c) mapping exists but discord_role_id is None
 *       → treated as create-role branch (createRoleForChannel or createDiscordChannelAndRole)
 *       → UpsertRosterMapping called, UpdateRosterChannel NOT called (channel already exists)
 *       → then backfill runs
 *   (d) DOUBLE-EMIT regression: invoke handler twice (first creates role, second sees mapping)
 *       → exactly ONE createGuildRole call total across both invocations
 *       → second invocation takes reuse path (no new role, addGuildMemberRole with same role id)
 *   (e) per-member failure isolation: one addGuildMemberRole fails permanently (404)
 *       → other member still added, event completes without throwing, warning logged
 *   (f) zero members → no addGuildMemberRole calls, mapping still handled (created or reused)
 */

import type { Discord, RosterModel, Team, TeamMember } from '@sideline/domain';
import { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Logger, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleRosterChannelCreated } from '~/rcp/channel/handleRosterChannelCreated.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const ROSTER_ID = '00000000-0000-0000-0001-000000000030' as RosterModel.RosterId;
const MEMBER_ID_A = '00000000-0000-0000-0002-000000000001' as TeamMember.TeamMemberId;
const MEMBER_ID_B = '00000000-0000-0000-0002-000000000002' as TeamMember.TeamMemberId;
const DISCORD_USER_A = '111111111111111111' as Discord.Snowflake;
const DISCORD_USER_B = '222222222222222222' as Discord.Snowflake;
const EXISTING_CHANNEL_ID = '666666666666666666' as Discord.Snowflake;
const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const NEW_CHANNEL_ID = '888888888888888888' as Discord.Snowflake;
const NEW_ROLE_ID = '777777777777777777' as Discord.Snowflake;

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
        return (...args: unknown[]) => {
          throw new Error(`Unexpected DiscordREST.${prop} call: ${JSON.stringify(args)}`);
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

type RosterMemberLike = {
  team_member_id: TeamMember.TeamMemberId;
  discord_user_id: Discord.Snowflake;
};

type RpcCallRecord = {
  GetRosterMapping: unknown[];
  GetRosterMembers: unknown[];
  UpsertRosterMapping: unknown[];
  UpdateRosterChannel: unknown[];
};

const makeRpc = (
  opts: {
    rosterMapping: Option.Option<ChannelMappingLike>;
    rosterMembers?: RosterMemberLike[];
  },
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RpcCallRecord; layer: Layer.Layer<SyncRpc> } => {
  const calls: RpcCallRecord = {
    GetRosterMapping: [],
    GetRosterMembers: [],
    UpsertRosterMapping: [],
    UpdateRosterChannel: [],
  };

  const members = opts.rosterMembers ?? [];

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    'Channel/GetRosterMapping': (args: any) => {
      calls.GetRosterMapping.push(args);
      return Effect.succeed(opts.rosterMapping);
    },
    'Channel/GetRosterMembers': (args: any) => {
      calls.GetRosterMembers.push(args);
      return Effect.succeed(members);
    },
    'Channel/UpsertRosterMapping': (args: any) => {
      calls.UpsertRosterMapping.push(args);
      return Effect.void;
    },
    'Channel/UpdateRosterChannel': (args: any) => {
      calls.UpdateRosterChannel.push(args);
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
        // Throw on unexpected RPC method calls — mirrors REST proxy behavior.
        // If a new RPC method is called without being declared here, the test fails loudly.
        return (...args: unknown[]) => {
          throw new Error(`Unexpected SyncRpc.${prop} call: ${JSON.stringify(args)}`);
        };
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
  extraLayer?: Layer.Layer<never>,
) => {
  const base = handleRosterChannelCreated(event).pipe(
    Effect.provide(Layer.merge(rpcLayer, restLayer)),
  );
  return Effect.runPromise(extraLayer ? base.pipe(Effect.provide(extraLayer)) : base);
};

// ---------------------------------------------------------------------------
// Test helpers — two standard roster members for reuse
// ---------------------------------------------------------------------------

const TWO_MEMBERS: RosterMemberLike[] = [
  { team_member_id: MEMBER_ID_A, discord_user_id: DISCORD_USER_A },
  { team_member_id: MEMBER_ID_B, discord_user_id: DISCORD_USER_B },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleRosterChannelCreated — idempotency + member backfill', () => {
  /**
   * (a) mapping+role already exist → reuse path
   *     - createGuildRole / createDiscordChannelAndRole / createRoleForChannel NOT called
   *     - UpsertRosterMapping NOT called, UpdateRosterChannel NOT called
   *     - GetRosterMembers called → addGuildMemberRole called twice with EXISTING_ROLE_ID
   */
  it('(a) mapping+role exist → no createGuildRole, no UpsertRosterMapping/UpdateRosterChannel; addGuildMemberRole ×2 with existing role id', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };

    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.some(existingMapping),
      rosterMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleRosterCreated(makeRosterCreatedEvent(), rpcLayer, restLayer);

    // Role must NOT be created (reuse existing)
    expect(restCalls.createGuildRole).toHaveLength(0);
    expect(restCalls.createGuildChannel).toHaveLength(0);
    // Mapping must NOT be written again (idempotency)
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(0);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(0);
    // Members must be backfilled with the EXISTING role id
    expect(rpcCalls.GetRosterMembers).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    // Both calls must use the existing role id
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(EXISTING_ROLE_ID);
    }
  });

  /**
   * (b) no mapping (None) → create path runs, then 2 members backfilled
   *     - createGuildRole called once (via createDiscordChannelAndRole)
   *     - UpsertRosterMapping + UpdateRosterChannel called
   *     - addGuildMemberRole called twice (with new role id)
   */
  it('(b) no mapping (None) → role created once, UpsertRosterMapping+UpdateRosterChannel called, then 2 members backfilled', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.none(),
      rosterMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleRosterCreated(makeRosterCreatedEvent(), rpcLayer, restLayer);

    // Role creation: createDiscordChannelAndRole path calls createGuildRole
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Bot-created roles must carry no global guild permissions (createDiscordChannelAndRole path)
    expect(restCalls.createGuildRole[0]?.[1]).toMatchObject({ permissions: 0 });
    // Mapping upserted after role created
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(1);
    // Members backfilled
    expect(rpcCalls.GetRosterMembers).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    // Both calls must use the newly created role id
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * (c) mapping exists but discord_role_id is None
   *     → treated as create-role branch (createRoleForChannel)
   *     → UpsertRosterMapping called (UpdateRosterChannel NOT called — channel already exists)
   *     → then backfill runs
   */
  it('(c) mapping exists but discord_role_id=None → create-role branch runs, UpsertRosterMapping called, then backfill', async () => {
    const mappingNoRole: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.none(),
    };

    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.some(mappingNoRole),
      rosterMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleRosterCreated(makeRosterCreatedEvent(), rpcLayer, restLayer);

    // A role must be created (the existing channel path calls createRoleForChannel → createGuildRole)
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Bot-created roles must carry no global guild permissions (createRoleForChannel path)
    expect(restCalls.createGuildRole[0]?.[1]).toMatchObject({ permissions: 0 });
    // Mapping must be upserted
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    // UpdateRosterChannel NOT called — channel already exists in the mapping
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(0);
    // Members backfilled
    expect(rpcCalls.GetRosterMembers).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
  });

  /**
   * (d) DOUBLE-EMIT regression
   *     Invoke handler twice:
   *       1st invocation: mapping=None → creates role+channel → stores mapping
   *       2nd invocation: mapping=Some(role=Some) → reuses role, backfills members
   *     → exactly ONE createGuildRole call total
   *     → second invocation uses NEW_ROLE_ID (reuse, not a fresh role)
   *     → createGuildChannel called exactly once (1st invocation only)
   *     → 2nd invocation still produces addGuildMemberRole calls (it doesn't short-circuit)
   */
  it('(d) double-emit: handler invoked twice → exactly 1 createGuildRole + 1 createGuildChannel total; 2nd run reuses role', async () => {
    let mappingState: Option.Option<ChannelMappingLike> = Option.none();

    const { calls: rpcCalls, layer: rpcLayer } = makeRpc(
      {
        rosterMapping: Option.none(), // initial state (ignored — we override below)
        rosterMembers: TWO_MEMBERS,
      },
      {
        'Channel/GetRosterMapping': () => {
          rpcCalls.GetRosterMapping.push({});
          return Effect.succeed(mappingState);
        },
        'Channel/UpsertRosterMapping': (args: any) => {
          rpcCalls.UpsertRosterMapping.push(args);
          // Simulate mapping being persisted after first invocation
          mappingState = Option.some({
            discord_channel_id: Option.some(NEW_CHANNEL_ID),
            discord_role_id: Option.some(NEW_ROLE_ID),
          });
          return Effect.void;
        },
      },
    );

    const { calls: restCalls, layer: restLayer } = makeRest();

    const event = makeRosterCreatedEvent();
    await runHandleRosterCreated(event, rpcLayer, restLayer);
    await runHandleRosterCreated(event, rpcLayer, restLayer);

    // Exactly ONE createGuildRole across both invocations
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Exactly ONE createGuildChannel across both invocations (1st run only)
    expect(restCalls.createGuildChannel).toHaveLength(1);
    // GetRosterMapping called twice (once per invocation)
    expect(rpcCalls.GetRosterMapping).toHaveLength(2);
    // UpsertRosterMapping called only ONCE (first invocation only)
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    // addGuildMemberRole called 4 times (2 members × 2 invocations)
    // — the 2nd invocation must still backfill (it didn't early-exit)
    expect(restCalls.addGuildMemberRole).toHaveLength(4);
    // All role adds in the 2nd run must use NEW_ROLE_ID (reuse, not a fresh ID)
    const secondRunCalls = restCalls.addGuildMemberRole.slice(2);
    for (const call of secondRunCalls) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(NEW_ROLE_ID);
    }
  });

  /**
   * (e) per-member failure isolation
   *     One addGuildMemberRole fails permanently (Discord 404) while the other succeeds.
   *     The event handler must complete without throwing.
   *     The surviving member (B) must still receive addGuildMemberRole with the correct args.
   *     A warning must be logged for the failed member (A).
   */
  it('(e) one addGuildMemberRole fails (404) → other member still added with correct role id, handler does not throw, warning logged', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };

    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.some(existingMapping),
      rosterMembers: TWO_MEMBERS,
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
    const result = await runHandleRosterCreated(
      makeRosterCreatedEvent(),
      rpcLayer,
      restLayer,
      logLayer,
    );
    expect(result).toBeUndefined();

    // GetRosterMembers was called
    expect(rpcCalls.GetRosterMembers).toHaveLength(1);

    // Exactly 2 addGuildMemberRole attempts — no retries on permanent errors
    expect(addRoleCallCount).toBe(2);

    // Member B's call must carry DISCORD_USER_B and EXISTING_ROLE_ID (survivor was actually added)
    const memberBCall = addRoleCallArgs[1] as [string, string, string];
    expect(memberBCall).toBeDefined();
    expect(memberBCall[1]).toBe(DISCORD_USER_B);
    expect(memberBCall[2]).toBe(EXISTING_ROLE_ID);

    // A warning must have been logged for member A's failure
    // The impl calls Effect.logWarning for each failed member add.
    // We check that at least one log entry is at Warn level or mentions the failure.
    const warnCount = logLevels.filter((l) => l.includes('Warn') || l.includes('Warning')).length;
    const msgCount = messages.filter(
      (m) => m.includes('404') || m.toLowerCase().includes('warn'),
    ).length;
    expect(warnCount + msgCount).toBeGreaterThan(0);
  });

  /**
   * (f) zero members → no addGuildMemberRole calls, mapping still handled
   */
  it('(f) zero members → no addGuildMemberRole calls; new-mapping path still creates role and upserts mapping', async () => {
    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.none(),
      rosterMembers: [], // empty roster
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleRosterCreated(makeRosterCreatedEvent(), rpcLayer, restLayer);

    // Role still created
    expect(restCalls.createGuildRole).toHaveLength(1);
    // Mapping still upserted
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(1);
    // No member role adds
    expect(restCalls.addGuildMemberRole).toHaveLength(0);
    // GetRosterMembers was still called (backfill runs, just with no members)
    expect(rpcCalls.GetRosterMembers).toHaveLength(1);
  });

  /**
   * (a2) existing mapping+role with existing_channel_id event field
   *      → same idempotency holds: no createGuildRole, no UpsertRosterMapping, no UpdateRosterChannel
   */
  it('(a2) mapping+role exist, event has existing_channel_id=Some → still no createGuildRole, no mapping writes, 2 members backfilled', async () => {
    const existingMapping: ChannelMappingLike = {
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    };

    const { calls: rpcCalls, layer: rpcLayer } = makeRpc({
      rosterMapping: Option.some(existingMapping),
      rosterMembers: TWO_MEMBERS,
    });
    const { calls: restCalls, layer: restLayer } = makeRest();

    await runHandleRosterCreated(
      makeRosterCreatedEvent({ existing_channel_id: Option.some(EXISTING_CHANNEL_ID) }),
      rpcLayer,
      restLayer,
    );

    expect(restCalls.createGuildRole).toHaveLength(0);
    expect(restCalls.createGuildChannel).toHaveLength(0);
    expect(rpcCalls.UpsertRosterMapping).toHaveLength(0);
    expect(rpcCalls.UpdateRosterChannel).toHaveLength(0);
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    for (const call of restCalls.addGuildMemberRole) {
      const [, , roleId] = call as [string, string, string];
      expect(roleId).toBe(EXISTING_ROLE_ID);
    }
  });
});
