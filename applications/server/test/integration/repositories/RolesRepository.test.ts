import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Role } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Roles Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        overview_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

/**
 * Create a user + team, seed built-in roles with their default permissions,
 * and return the team plus the freshly-fetched role rows. Used by every test
 * in this file to set up the unit under test in one step.
 */
const seedTeam = (suffix: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () =>
      createUser(`70000000000000000${suffix}`, `roles-test-user-${suffix}`),
    ),
    Effect.bind('team', ({ userId }) =>
      createTeam(`71000000000000000${suffix}` as Discord.Snowflake, userId),
    ),
    Effect.tap(({ team }) =>
      RolesRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
      ),
    ),
    Effect.bind('roles', ({ team }) =>
      RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findRolesByTeamId(team.id))),
    ),
  );

const fetchPermissions = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.getPermissionsForRoleId(roleId)));

const findBuiltInRole = (
  roles: ReadonlyArray<{ id: Role.RoleId; name: string }>,
  name: 'Admin' | 'Captain' | 'Player' | 'Treasurer',
) => {
  const found = roles.find((r) => r.name === name);
  return found !== undefined
    ? Effect.succeed(found)
    : Effect.fail(new Error(`${name} role not found in seeded roles`));
};

// Reseed an already-seeded team and refetch its roles, for idempotency checks.
const reseedRoles = (teamId: Team.TeamId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(teamId)),
    Effect.flatMap(() =>
      RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.findRolesByTeamId(teamId))),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RolesRepository', () => {
  it.effect('seedTeamRolesWithPermissions creates four built-in roles for a new team', () =>
    seedTeam('1').pipe(
      Effect.tap(({ roles }) =>
        Effect.sync(() => {
          expect(roles).toHaveLength(4);
          expect(roles.every((r) => r.is_built_in)).toBe(true);
          const names = new Set(roles.map((r) => r.name));
          expect(names).toEqual(new Set(['Admin', 'Captain', 'Player', 'Treasurer']));
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('each built-in role gets exactly the permissions from defaultPermissions[name]', () =>
    seedTeam('2').pipe(
      Effect.bind('permissionsByRole', ({ roles }) =>
        Effect.all(
          roles.map((role) =>
            fetchPermissions(role.id).pipe(Effect.map((perms) => ({ name: role.name, perms }))),
          ),
        ),
      ),
      Effect.tap(({ permissionsByRole }) =>
        Effect.sync(() => {
          for (const { name, perms } of permissionsByRole) {
            const expected = Role.defaultPermissions[name];
            expect(expected).toBeDefined();
            expect([...perms].sort()).toEqual([...expected].sort());
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('Admin has every permission in the Permission catalog after seeding', () =>
    seedTeam('3').pipe(
      Effect.bind('adminRole', ({ roles }) => findBuiltInRole(roles, 'Admin')),
      Effect.bind('adminPerms', ({ adminRole }) => fetchPermissions(adminRole.id)),
      Effect.tap(({ adminPerms }) =>
        Effect.sync(() => {
          expect([...adminPerms].sort()).toEqual([...Role.allPermissions].sort());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'Treasurer has exactly [finance:view, finance:manage_fees, finance:record_payments] after seeding',
    () =>
      seedTeam('4').pipe(
        Effect.bind('treasurerRole', ({ roles }) => findBuiltInRole(roles, 'Treasurer')),
        Effect.bind('treasurerPerms', ({ treasurerRole }) => fetchPermissions(treasurerRole.id)),
        Effect.tap(({ treasurerPerms }) =>
          Effect.sync(() => {
            expect([...treasurerPerms].sort()).toEqual(
              ['finance:view', 'finance:manage_fees', 'finance:record_payments'].sort(),
            );
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('Captain only holds finance:view among finance permissions after seeding', () =>
    seedTeam('5').pipe(
      Effect.bind('captainRole', ({ roles }) => findBuiltInRole(roles, 'Captain')),
      Effect.bind('captainPerms', ({ captainRole }) => fetchPermissions(captainRole.id)),
      Effect.tap(({ captainPerms }) =>
        Effect.sync(() => {
          const captainFinance = captainPerms.filter((p) => p.startsWith('finance:'));
          expect(captainFinance).toEqual(['finance:view']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('applying default permissions twice in succession yields identical state', () => {
    type Snapshot = {
      roleIds: Set<Role.RoleId>;
      permsByName: Map<string, Role.Permission[]>;
    };

    // Given a list of roles, fetch all perms and build a snapshot keyed by role name
    // (sorted perm list per name) plus the set of role IDs (to verify no row churn).
    const snapshot = (
      roles: ReadonlyArray<{ id: Role.RoleId; name: string }>,
    ): Effect.Effect<Snapshot, Error, RolesRepository> =>
      Effect.all(
        roles.map((role) =>
          fetchPermissions(role.id).pipe(
            Effect.map((perms) => ({ id: role.id, name: role.name, perms: [...perms].sort() })),
          ),
        ),
      ).pipe(
        Effect.map((entries) => ({
          roleIds: new Set(entries.map((e) => e.id)),
          permsByName: new Map(entries.map((e) => [e.name, e.perms])),
        })),
      );

    return seedTeam('6').pipe(
      Effect.bind('snapshotAfterFirst', ({ roles }) => snapshot(roles)),
      Effect.bind('rolesAfterSecond', ({ team }) => reseedRoles(team.id)),
      Effect.bind('snapshotAfterSecond', ({ rolesAfterSecond }) => snapshot(rolesAfterSecond)),
      Effect.tap(({ snapshotAfterFirst, snapshotAfterSecond }) =>
        Effect.sync(() => {
          // Role IDs must be unchanged — no row churn
          expect(snapshotAfterSecond.roleIds).toEqual(snapshotAfterFirst.roleIds);
          // Each role's sorted permission list must be identical
          for (const [name, permsAfterFirst] of snapshotAfterFirst.permsByName) {
            expect(snapshotAfterSecond.permsByName.get(name)).toEqual(permsAfterFirst);
          }
          // Same number of roles on both sides
          expect(snapshotAfterSecond.permsByName.size).toBe(snapshotAfterFirst.permsByName.size);
        }),
      ),
      Effect.provide(TestLayer),
    );
  });
});
