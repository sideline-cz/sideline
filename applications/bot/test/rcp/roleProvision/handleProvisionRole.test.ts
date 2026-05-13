// TDD mode — tests for handleProvisionRole (bot role provisioning handler).
//
// Pattern: mirrors applications/bot/test/rcp/achievement/handleAchievementEarned.test.ts

import type { Discord, RoleProvisionRpcGroup, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleProvisionRole } from '~/rcp/roleProvision/handleProvisionRole.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// DiscordREST mock helpers
// ---------------------------------------------------------------------------

type RestCallRecord = {
  listGuildRoles: unknown[][];
  createGuildRole: unknown[][];
};

const makeRest = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: RestCallRecord; layer: Layer.Layer<DiscordREST> } => {
  const calls: RestCallRecord = {
    listGuildRoles: [],
    createGuildRole: [],
  };

  const defaults: Record<string, (...args: any[]) => Effect.Effect<any, any, any>> = {
    listGuildRoles: (...args: any[]) => {
      calls.listGuildRoles.push(args);
      // Return a guild roles list that contains a role named 'Bronze Achiever'
      return Effect.succeed([
        { id: EXISTING_ROLE_ID, name: 'Bronze Achiever', managed: false },
        { id: '666666666666666666', name: 'Other Role', managed: false },
      ]);
    },
    createGuildRole: (...args: any[]) => {
      calls.createGuildRole.push(args);
      return Effect.succeed({
        id: '999999999999999999' as Discord.Snowflake,
        name: args[1]?.name ?? '',
      });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
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
// SyncRpc mock helper
// ---------------------------------------------------------------------------

const makeSyncRpc = (
  overrides: Partial<Record<string, (...args: any[]) => Effect.Effect<any, any, any>>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Achievement/UpsertBuiltInRoleMapping': [],
    'Achievement/UpsertCustomRoleMapping': [],
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop];
        if (fn) return fn;
        return (...args: any[]) => {
          if (!(prop in calls)) calls[prop] = [];
          calls[prop].push(args);
          return Effect.void;
        };
      },
    }),
  );

  return { calls, layer };
};

// ---------------------------------------------------------------------------
// Event / payload factory for a provision-role event
// ---------------------------------------------------------------------------

const makeEvent = (
  overrides: Partial<{
    team_id: Team.TeamId;
    guild_id: Discord.Snowflake;
    kind: 'builtin_achievement' | 'custom_achievement';
    ref_id: string;
    desired_name: string;
  }> = {},
): RoleProvisionRpcGroup.UnprocessedRoleProvisionEvent =>
  ({
    id: 'event-id-001' as RoleProvisionRpcGroup.RoleProvisionEventId,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    kind: 'builtin_achievement' as const,
    ref_id: 'ten_activities',
    desired_name: 'Bronze Achiever',
    ...overrides,
  }) as RoleProvisionRpcGroup.UnprocessedRoleProvisionEvent;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('handleProvisionRole', () => {
  it('#11 reuses existing role with same name (no duplicate create) — calls UpsertBuiltInRoleMapping with existing role id', async () => {
    // Arrange: DiscordREST returns a role named 'Bronze Achiever' already
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const event = makeEvent({ desired_name: 'Bronze Achiever' });

    // Act
    await Effect.runPromise(
      handleProvisionRole(event).pipe(
        Effect.provide(Layer.merge(restLayer, rpcLayer)),
      ) as Effect.Effect<void>,
    );

    // Assert
    // createGuildRole must NOT have been called because the role already exists
    expect(restCalls.createGuildRole).toHaveLength(0);
    // listGuildRoles must have been called to discover existing roles
    expect(restCalls.listGuildRoles).toHaveLength(1);
    // UpsertBuiltInRoleMapping must have been called with the EXISTING role id
    const upsertCalls = rpcCalls['Achievement/UpsertBuiltInRoleMapping'];
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject([
      expect.objectContaining({
        discord_role_id: EXISTING_ROLE_ID,
      }),
    ]);
  });
});
