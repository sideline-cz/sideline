/**
 * TDD — regression test for `fix/group-role-discord-sync`'s "must land" blocker 1:
 * `GuildRolesCache` staleness.
 *
 * `GuildRolesCache` (`src/services/GuildRolesCache.ts`) fetches `listGuildRoles` ONCE per guild
 * and memoizes it for the rest of the processor tick (`ProcessorService` builds one fresh
 * instance per tick and shares it across every event drained in that tick). If a tick's FIRST
 * event is for an already-mapped role, that event's own `rolesCache.get(guildId)` call
 * populates the cache — and a LATER event in the SAME tick that needs to CREATE a brand-new
 * Discord role (because its Sideline role has no mapping yet) will, immediately after creating
 * it, see the STALE cached list that predates the creation. `handleMemberAdded` reads that as
 * `missing: true`, deletes the mapping it just created, and fails the event as
 * `StaleRoleMappingError` — worst case, the next processor tick repeats the whole
 * adopt-or-create dance again, producing duplicate Discord roles across ticks.
 *
 * This PR's fan-out (one group operation can enqueue many `role_assigned` events for a role
 * that has never been mapped before) is exactly what makes this reachable in practice: "create a
 * role, attach it to a group" is the single most likely captain workflow this whole fix targets,
 * and the SECOND role_assigned event onward (for a DIFFERENT already-mapped role processed
 * earlier in the same tick) is what fills the cache before the new role exists.
 *
 * This test requires NO production change to demonstrate — it drives the real, unmodified
 * `handleMemberAdded` twice against one shared `GuildRolesCache` instance (mirroring
 * `handleAssigned.test.ts`'s own "caches listGuildRoles across two events sharing one
 * GuildRolesCache instance" test) and asserts the CORRECT (fixed) outcome, which fails today
 * because `createGuildRole`/`ensureMapping` have no way to write into an already-populated
 * cache entry (`GuildRolesCacheService` only exposes `get`, no `set`/invalidate).
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
const TEAM_ID = '00000000-0000-0000-0000-000000000040' as Team.TeamId;

// Role A: already mapped BEFORE this tick — its event is drained FIRST and its own
// `rolesCache.get()` call is what populates the (soon-to-be-stale) cache.
const ROLE_ID_A = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const ROLE_NAME_A = 'Already Mapped Role';
const DISCORD_ROLE_ID_A = '555555555555555555' as Discord.Snowflake;
const TEAM_MEMBER_ID_A = '00000000-0000-0000-0000-000000000042' as TeamMember.TeamMemberId;
const DISCORD_USER_ID_A = '444444444444444444' as Discord.Snowflake;

// Role B: has NO mapping yet — its event is drained SECOND, in the SAME tick, and must create a
// brand-new Discord role via `ensureMapping` -> `createGuildRole`.
const ROLE_ID_B = '00000000-0000-0000-0000-000000000043' as Role.RoleId;
const ROLE_NAME_B = 'Brand New Role';
const DISCORD_ROLE_ID_B = '666666666666666666' as Discord.Snowflake;
const TEAM_MEMBER_ID_B = '00000000-0000-0000-0000-000000000044' as TeamMember.TeamMemberId;
const DISCORD_USER_ID_B = '777777777777777777' as Discord.Snowflake;

const BOT_USER_ID = '888888888888888888';

const makeEventA = () =>
  new RoleRpcEvents.RoleAssignedEvent({
    id: '00000000-0000-0000-0000-000000000045' as any,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: ROLE_ID_A,
    role_name: ROLE_NAME_A,
    team_member_id: TEAM_MEMBER_ID_A,
    discord_user_id: DISCORD_USER_ID_A,
  });

const makeEventB = () =>
  new RoleRpcEvents.RoleAssignedEvent({
    id: '00000000-0000-0000-0000-000000000046' as any,
    team_id: TEAM_ID,
    guild_id: GUILD_ID,
    role_id: ROLE_ID_B,
    role_name: ROLE_NAME_B,
    team_member_id: TEAM_MEMBER_ID_B,
    discord_user_id: DISCORD_USER_ID_B,
  });

const makeGuildRole = (overrides: Record<string, unknown> = {}) => ({
  id: DISCORD_ROLE_ID_A,
  name: ROLE_NAME_A,
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

const makeRest = (): { calls: Record<string, unknown[][]>; layer: Layer.Layer<DiscordREST> } => {
  const calls: Record<string, unknown[][]> = {
    listGuildRoles: [],
    addGuildMemberRole: [],
    getMyUser: [],
    getGuildMember: [],
    createGuildRole: [],
  };

  // Live Discord state at the moment each `listGuildRoles` call happens to run. Only role A
  // exists at the start of the tick — role B is created mid-tick by event B's own
  // `createGuildRole` call, exactly like a real Discord guild.
  let liveRoles = [makeGuildRole()];

  const defaults: Record<string, AnyFn> = {
    listGuildRoles: (...args: unknown[]) => {
      calls.listGuildRoles?.push(args);
      return Effect.succeed(liveRoles);
    },
    addGuildMemberRole: (...args: unknown[]) => {
      calls.addGuildMemberRole?.push(args);
      return Effect.void;
    },
    getMyUser: (...args: unknown[]) => {
      calls.getMyUser?.push(args);
      return Effect.succeed({ id: BOT_USER_ID, username: 'sideline-bot' });
    },
    getGuildMember: (...args: unknown[]) => {
      calls.getGuildMember?.push(args);
      return Effect.succeed({
        avatar: null,
        banner: null,
        communication_disabled_until: null,
        flags: 0,
        joined_at: '2024-01-01T00:00:00.000Z',
        nick: null,
        pending: false,
        premium_since: null,
        roles: [],
        user: { id: BOT_USER_ID, username: 'sideline-bot' },
        mute: false,
        deaf: false,
      });
    },
    createGuildRole: (...args: unknown[]) => {
      calls.createGuildRole?.push(args);
      const created = makeGuildRole({
        id: DISCORD_ROLE_ID_B,
        name: ROLE_NAME_B,
        managed: false,
      });
      // The role now genuinely exists in Discord — a FRESH `listGuildRoles` call from this
      // point on would see it. `GuildRolesCache`'s per-tick memoization is precisely what stops
      // the bot's own next cache read from seeing this.
      liveRoles = [...liveRoles, created];
      return Effect.succeed({ id: created.id, name: created.name });
    },
  };

  const layer = Layer.succeed(
    DiscordREST,
    new Proxy({} as any, {
      get: (_target: unknown, prop: string) => {
        if (typeof prop !== 'string' || prop === 'then' || prop === 'catch') return undefined;
        const fn = defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected DiscordREST.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

const makeSyncRpc = (): { calls: Record<string, unknown[][]>; layer: Layer.Layer<SyncRpc> } => {
  const calls: Record<string, unknown[][]> = {
    'Role/GetMapping': [],
    'Role/UpsertMapping': [],
    'Role/DeleteMapping': [],
  };

  const defaults: Record<string, AnyFn> = {
    'Role/GetMapping': (...args: unknown[]) => {
      calls['Role/GetMapping']?.push(args);
      const request = args[0] as { role_id: Role.RoleId };
      if (request.role_id === ROLE_ID_A) {
        return Effect.succeed(
          Option.some({
            id: '00000000-0000-0000-0000-000000000099',
            team_id: TEAM_ID,
            role_id: ROLE_ID_A,
            discord_role_id: DISCORD_ROLE_ID_A,
            adopted: true,
          }),
        );
      }
      return Effect.succeed(Option.none());
    },
    'Role/UpsertMapping': (...args: unknown[]) => {
      calls['Role/UpsertMapping']?.push(args);
      return Effect.void;
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
        const fn = defaults[prop];
        if (fn !== undefined) return fn;
        return (...args: unknown[]) => {
          throw new Error(`Unexpected SyncRpc.${prop} call: ${JSON.stringify(args)}`);
        };
      },
    }),
  );

  return { calls, layer };
};

describe('GuildRolesCache staleness — a role created mid-tick must be visible to a later event in the same tick', () => {
  it('lets the SECOND event (a brand-new role) succeed after the FIRST event (an already-mapped role) filled the cache', async () => {
    const { calls: restCalls, layer: restLayer } = makeRest();
    const { calls: rpcCalls, layer: rpcLayer } = makeSyncRpc();

    const cacheLayer = Layer.effect(GuildRolesCache, GuildRolesCache.make);
    const provided = Layer.merge(restLayer, rpcLayer);

    // Sequential — mirrors `ProcessorService`'s `concurrency: 1` drain and, critically, shares
    // ONE `GuildRolesCache` instance across both events, exactly as one processor tick does.
    //
    // Event A: role already mapped. Its own `rolesCache.get()` call is the FIRST of the tick and
    // populates the cache with the pre-creation role list (role A only). Event B: brand-new
    // role, created mid-tick by THIS event's own `ensureMapping` -> `createGuildRole` call. The
    // fixed behavior: the cache must be told about the role it just created, so this event's OWN
    // `rolesCache.get()` call (the second of the tick) sees it too, and the assignment succeeds.
    await Effect.runPromise(
      handleMemberAdded(makeEventA())
        .pipe(Effect.andThen(() => handleMemberAdded(makeEventB())))
        .pipe(Effect.provide(cacheLayer), Effect.provide(provided)),
    );

    // Today this throws instead (StaleRoleMappingError) — `runPromise` above rejects before
    // reaching here, which is the FIRST symptom of this bug this test surfaces.
    expect(restCalls.createGuildRole).toHaveLength(1);
    expect(restCalls.addGuildMemberRole).toHaveLength(2);
    expect(restCalls.addGuildMemberRole?.[1]).toMatchObject([
      GUILD_ID,
      DISCORD_USER_ID_B,
      DISCORD_ROLE_ID_B,
    ]);

    // The bug's signature symptom: the mapping `createGuildRole` just wrote via
    // `Role/UpsertMapping` must NOT be immediately deleted again as "stale".
    const deletedRoleIds = (rpcCalls['Role/DeleteMapping'] ?? []).map(
      (args) => (args[0] as { role_id: Role.RoleId }).role_id,
    );
    expect(deletedRoleIds).not.toContain(ROLE_ID_B);
  });
});
