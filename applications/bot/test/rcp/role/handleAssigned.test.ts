/**
 * Regression tests for blocker 3 (TOCTOU permission re-validation) and the related should-fix
 * item (dangling mapping cleanup on Discord's Unknown Role 10011).
 *
 * Spec: PR-6 fix review — "BLOCKER 3 — the permission guard is TOCTOU and never re-evaluated"
 * and the should-fix "A dangling mapping is terminal forever".
 */

import {
  type Discord,
  type Role,
  RoleRpcEvents,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Layer, Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { handleMemberAdded } from '~/rcp/role/handleAssigned.js';
import { GuildRolesCache } from '~/services/GuildRolesCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const TEAM_ID = '00000000-0000-0000-0000-000000000030' as Team.TeamId;
const ROLE_ID = '00000000-0000-0000-0000-000000000031' as Role.RoleId;
const ROLE_NAME = 'Captain';
const TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000032' as TeamMember.TeamMemberId;
const DISCORD_USER_ID = '444444444444444444' as Discord.Snowflake;
const DISCORD_ROLE_ID = '555555555555555555' as Discord.Snowflake;
const EVENT_ID = '00000000-0000-0000-0000-000000000033';

const makeEvent = () =>
  new RoleRpcEvents.RoleAssignedEvent({
    id: EVENT_ID as any,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: ROLE_ID,
    role_name: ROLE_NAME,
    team_member_id: TEAM_MEMBER_ID,
    discord_user_id: DISCORD_USER_ID,
  });

const makeGuildRole = (overrides: Record<string, unknown> = {}) => ({
  id: DISCORD_ROLE_ID,
  name: ROLE_NAME,
  description: null,
  permissions: '0',
  position: 1,
  color: 0,
  colors: { primary_color: 0, secondary_color: null, tertiary_color: null },
  hoist: false,
  managed: false,
  mentionable: false,
  icon: null,
  unicode_emoji: null,
  flags: 0,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

type AnyFn = (...args: any[]) => Effect.Effect<any, any, any>;

const makeRest = (
  overrides: Partial<Record<string, AnyFn>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<DiscordREST> } => {
  const calls: Record<string, unknown[][]> = {
    listGuildRoles: [],
    addGuildMemberRole: [],
  };

  const defaults: Record<string, AnyFn> = {
    listGuildRoles: (...args: unknown[]) => {
      calls.listGuildRoles?.push(args);
      return Effect.succeed([makeGuildRole()]);
    },
    addGuildMemberRole: (...args: unknown[]) => {
      calls.addGuildMemberRole?.push(args);
      return Effect.void;
    },
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

const makeSyncRpc = (
  overrides: Partial<Record<string, AnyFn>> = {},
): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Role/GetMapping': [],
    'Role/DeleteMapping': [],
  };

  const defaults: Record<string, AnyFn> = {
    'Role/GetMapping': (...args: unknown[]) => {
      calls['Role/GetMapping']?.push(args);
      return Effect.succeed(
        Option.some({
          id: '00000000-0000-0000-0000-000000000099',
          team_id: TEAM_ID,
          role_id: ROLE_ID,
          discord_role_id: DISCORD_ROLE_ID,
          adopted: true,
        }),
      );
    },
    'Role/DeleteMapping': (...args: unknown[]) => {
      calls['Role/DeleteMapping']?.push(args);
      return Effect.void;
    },
  };

  const layer = Layer.succeed(
    SyncRpc,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = overrides[prop] ?? defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected SyncRpc.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

const run = (
  effect: Effect.Effect<void, unknown, DiscordREST | SyncRpc | GuildRolesCache>,
  restLayer: Layer.Layer<DiscordREST>,
  rpcLayer: Layer.Layer<SyncRpc>,
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(Layer.effect(GuildRolesCache, GuildRolesCache.make)),
      Effect.provide(Layer.merge(restLayer, rpcLayer)),
    ),
  );

describe('handleMemberAdded', () => {
  it('assigns the role when its live permissions are zero', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    await run(handleMemberAdded(makeEvent()), restLayer, rpcLayer);

    expect(restCalls.addGuildMemberRole).toHaveLength(1);
    expect(restCalls.addGuildMemberRole?.[0]).toMatchObject([
      GUILD_ID,
      DISCORD_USER_ID,
      DISCORD_ROLE_ID,
    ]);
  });

  // Blocker 3's original fix (this comment used to end here: "without failing the event") was
  // itself a bug (whole-series review, "also fix" item): resolving instead of rejecting meant
  // `ProcessorService.ts` called `Role/MarkEventProcessed`, so `last_role_sync_state` was
  // recorded `'ok'` for a refused assignment. It must now reject with `UnsafeRoleAssignmentError`
  // so the processor's `Effect.catch` classifies it as `captain_action` instead.
  it('BLOCKER 3 regression: refuses to assign when the role now carries ADMINISTRATOR, and FAILS the event as captain_action', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: unknown[]) => {
        restCalls.listGuildRoles?.push(args);
        return Effect.succeed([makeGuildRole({ permissions: '8' })]);
      },
    });
    const { layer: rpcLayer } = makeSyncRpc();

    await expect(run(handleMemberAdded(makeEvent()), restLayer, rpcLayer)).rejects.toMatchObject({
      _tag: 'UnsafeRoleAssignmentError',
    });

    expect(restCalls.addGuildMemberRole).toHaveLength(0);
  });

  // Should-fix 2 (whole-series review of commit 46806427): a role missing from the fresh
  // `listGuildRoles` read is a STALE MAPPING (the Discord role was deleted), not a
  // dangerous-permissions problem — it must fail as `StaleRoleMappingError` (classified
  // `retryable`, non-terminal, by `errorClassifier.ts`), not `UnsafeRoleAssignmentError`
  // (`captain_action`, terminal). `captain_action` tells a captain to fix a role's permissions,
  // which is meaningless and unactionable for a role that no longer exists. It must also clear
  // the now-stale `discord_role_mappings` row via `Role/DeleteMapping` so the next event
  // re-resolves a fresh mapping via `ensureMapping` — before this fix, this branch never reached
  // `addGuildMemberRole`, so the REST-level 10011 cleanup path was unreachable and the SAME stale
  // id failed the SAME way forever.
  it('should-fix 2: clears the stale mapping and fails as StaleRoleMappingError (not captain_action) when the mapped role is missing from a fresh listGuildRoles read', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest({
      listGuildRoles: (...args: unknown[]) => {
        restCalls.listGuildRoles?.push(args);
        return Effect.succeed([]);
      },
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await expect(run(handleMemberAdded(makeEvent()), restLayer, rpcLayer)).rejects.toMatchObject({
      _tag: 'StaleRoleMappingError',
    });

    expect(restCalls.addGuildMemberRole).toHaveLength(0);
    expect(rpcCalls['Role/DeleteMapping']).toHaveLength(1);
    expect(rpcCalls['Role/DeleteMapping']?.[0]).toMatchObject([
      { team_id: TEAM_ID, role_id: ROLE_ID },
    ]);
  });

  it('caches listGuildRoles across two events sharing one GuildRolesCache instance', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { layer: rpcLayer } = makeSyncRpc();

    const cacheLayer = Layer.effect(GuildRolesCache, GuildRolesCache.make);
    const provided = Layer.merge(restLayer, rpcLayer);

    await Effect.runPromise(
      Effect.all([handleMemberAdded(makeEvent()), handleMemberAdded(makeEvent())], {
        concurrency: 1,
      }).pipe(Effect.provide(cacheLayer), Effect.provide(provided)),
    );

    expect(restCalls.listGuildRoles).toHaveLength(1);
  });

  it('should-fix: deletes the stale mapping when addGuildMemberRole reports Unknown Role (10011)', async () => {
    const { layer: restLayer } = makeRest({
      addGuildMemberRole: () => Effect.fail({ data: { code: 10011 } }),
    });
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    await expect(run(handleMemberAdded(makeEvent()), restLayer, rpcLayer)).rejects.toBeDefined();

    expect(rpcCalls['Role/DeleteMapping']).toHaveLength(1);
    expect(rpcCalls['Role/DeleteMapping']?.[0]).toMatchObject([
      { team_id: TEAM_ID, role_id: ROLE_ID },
    ]);
  }, 20000); // Effect.retry(retryPolicy) exhausts ~7s of exponential backoff before tapError fires.
});
