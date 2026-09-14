// TDD — regression tests for the "role linking doesn't work" bug (fix/role-linking).
//
// A team member's *effective* roles are `member_roles` UNION (`group_members` →
// recursive walk up `groups.parent_id` → `role_groups`). `TeamMembersRepository`'s
// `findRosterMemberQuery` (backing `findRosterMemberByIds`) and `findRosterByTeamQuery`
// (backing `findRosterByTeam`) only implement the `member_roles` half for BOTH
// `role_names` and `permissions` — unlike `findMembershipQuery` (backing
// `findMembershipByIds`), which already unions in the group-inherited half correctly.
//
// These tests seed a member who holds `Player` directly and `Coach` (with
// `member:edit` + `roster:manage`) *only* through group membership on an ANCESTOR of
// the group they actually belong to, and assert the roster-facing queries agree with
// the already-correct `findMembershipByIds`. They fail today because `Coach` and its
// permissions are silently dropped.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  GroupsRepository.Default,
  RolesRepository.Default,
  TeamMembersRepository.Default,
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
        name: 'Group Roles Test Team',
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
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
    Effect.map((g) => g.id),
  );

const addMemberToGroup = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

const createRoleWithPermissions = (
  teamId: Team.TeamId,
  name: string,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRole(teamId, name).pipe(
        Effect.tap((role) => repo.setRolePermissions(role.id, permissions)),
        Effect.map((role) => role.id),
      ),
    ),
  );

const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRoleToGroup(roleId, groupId)),
  );

const assignRoleDirect = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

/**
 * Base fixture used by most tests below:
 *   - team with built-in roles seeded (so 'Player' exists as a built-in role)
 *   - custom role 'Coach' (member:edit, roster:manage)
 *   - group 'Muži' (parent) with child group 'Muži A'
 *   - role_groups(Coach → Muži) — the grant is on the ANCESTOR, not the child
 *   - member M is in 'Muži A' only (the child), with a direct 'Player' role assignment
 */
const seedBaseFixture = Effect.Do.pipe(
  Effect.bind('ownerUserId', () => createUser('820000000000000001', 'group-roles-owner')),
  Effect.bind('memberUserId', () => createUser('820000000000000002', 'group-roles-member')),
  Effect.bind('team', ({ ownerUserId }) =>
    createTeam('821010101010101010' as Discord.Snowflake, ownerUserId),
  ),
  Effect.tap(({ team }) =>
    RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
    ),
  ),
  Effect.bind('playerRoleId', ({ team }) =>
    RolesRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findRoleByTeamAndName(team.id, 'Player')),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new Error('Player role not found')),
          onSome: (r) => Effect.succeed(r.id),
        }),
      ),
    ),
  ),
  Effect.bind('coachRoleId', ({ team }) =>
    createRoleWithPermissions(team.id, 'Coach', ['member:edit', 'roster:manage']),
  ),
  Effect.bind('muziGroupId', ({ team }) => createGroup(team.id, 'Muži')),
  Effect.bind('muziAGroupId', ({ team, muziGroupId }) =>
    createGroup(team.id, 'Muži A', Option.some(muziGroupId)),
  ),
  Effect.tap(({ coachRoleId, muziGroupId }) => assignRoleToGroup(coachRoleId, muziGroupId)),
  Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
  Effect.tap(({ memberId, muziAGroupId }) => addMemberToGroup(muziAGroupId, memberId)),
  Effect.tap(({ memberId, playerRoleId }) => assignRoleDirect(memberId, playerRoleId)),
  Effect.provide(TestLayer),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('TeamMembersRepository — group-inherited roles', () => {
  it.effect(
    'findRosterMemberByIds role_names contains both the direct role and the group-inherited role',
    () =>
      seedBaseFixture.pipe(
        Effect.bind('entry', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          ),
        ),
        Effect.tap(({ entry }) =>
          Effect.sync(() => {
            expect(Option.isSome(entry)).toBe(true);
            const roleNames = Option.getOrThrow(entry).role_names;
            expect([...roleNames].sort()).toEqual(['Coach', 'Player']);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findRosterMemberByIds permissions contains member:edit and roster:manage from the group-inherited Coach role',
    () =>
      seedBaseFixture.pipe(
        Effect.bind('entry', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          ),
        ),
        Effect.tap(({ entry }) =>
          Effect.sync(() => {
            const permissions = Option.getOrThrow(entry).permissions;
            expect(permissions).toContain('member:edit');
            expect(permissions).toContain('roster:manage');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'the granting role sits on the ancestor group, not the child the member belongs to',
    () =>
      seedBaseFixture.pipe(
        Effect.bind('entry', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          ),
        ),
        Effect.tap(({ entry, muziAGroupId, coachRoleId }) =>
          Effect.sync(() => {
            // The member belongs directly ONLY to 'Muži A' (the child), never to 'Muži'
            // (the ancestor) — yet 'Coach' (granted to the ancestor) still shows up. This
            // guards the walk direction: ancestors of the member's group, not descendants.
            expect(muziAGroupId).toBeDefined();
            expect(coachRoleId).toBeDefined();
            const roleNames = Option.getOrThrow(entry).role_names;
            expect(roleNames).toContain('Coach');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('findRosterByTeam and findRosterMemberByIds agree on role_names and permissions', () =>
    seedBaseFixture.pipe(
      Effect.bind('rosterList', ({ team }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterByTeam(team.id)),
        ),
      ),
      Effect.bind('single', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ rosterList, single, memberId }) =>
        Effect.sync(() => {
          const listed = rosterList.find((e) => e.member_id === memberId);
          expect(listed).toBeDefined();
          const singleEntry = Option.getOrThrow(single);
          expect([...(listed?.role_names ?? [])].sort()).toEqual(
            [...singleEntry.role_names].sort(),
          );
          expect([...(listed?.permissions ?? [])].sort()).toEqual(
            [...singleEntry.permissions].sort(),
          );
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findRosterMemberByIds agrees with the already-correct findMembershipByIds', () =>
    seedBaseFixture.pipe(
      Effect.bind('membership', ({ team, memberUserId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findMembershipByIds(team.id, memberUserId)),
        ),
      ),
      Effect.bind('rosterEntry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ membership, rosterEntry }) =>
        Effect.sync(() => {
          const membershipRow = Option.getOrThrow(membership);
          const rosterRow = Option.getOrThrow(rosterEntry);
          expect([...rosterRow.role_names].sort()).toEqual([...membershipRow.role_names].sort());
          expect([...rosterRow.permissions].sort()).toEqual([...membershipRow.permissions].sort());
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('a role held both directly and via a group appears exactly once in role_names', () =>
    seedBaseFixture.pipe(
      // Also assign 'Coach' directly to the member, in addition to the group grant.
      Effect.tap(({ memberId, coachRoleId }) => assignRoleDirect(memberId, coachRoleId)),
      Effect.bind('entry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ entry }) =>
        Effect.sync(() => {
          const roleNames = Option.getOrThrow(entry).role_names;
          expect(roleNames.filter((n) => n === 'Coach')).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member with no group membership sees only their direct roles', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('820000000000000011', 'no-group-owner')),
      Effect.bind('memberUserId', () => createUser('820000000000000012', 'no-group-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('821020202020202020' as Discord.Snowflake, ownerUserId),
      ),
      Effect.tap(({ team }) =>
        RolesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.seedTeamRolesWithPermissions(team.id)),
        ),
      ),
      Effect.bind('playerRoleId', ({ team }) =>
        RolesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRoleByTeamAndName(team.id, 'Player')),
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new Error('Player role not found')),
              onSome: (r) => Effect.succeed(r.id),
            }),
          ),
        ),
      ),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      Effect.tap(({ memberId, playerRoleId }) => assignRoleDirect(memberId, playerRoleId)),
      Effect.bind('entry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ entry }) =>
        Effect.sync(() => {
          expect(Option.getOrThrow(entry).role_names).toEqual(['Player']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member with no roles at all decodes role_names as an empty array, not [""]', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('820000000000000021', 'empty-owner')),
      Effect.bind('memberUserId', () => createUser('820000000000000022', 'empty-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('821030303030303030' as Discord.Snowflake, ownerUserId),
      ),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      Effect.bind('entry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ entry }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(entry);
          expect(row.role_names).toEqual([]);
          expect(row.permissions).toEqual([]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('an archived group does not grant its roles', () =>
    seedBaseFixture.pipe(
      Effect.tap(({ muziGroupId }) => archiveGroup(muziGroupId)),
      Effect.bind('entry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
        ),
      ),
      Effect.tap(({ entry }) =>
        Effect.sync(() => {
          const row = Option.getOrThrow(entry);
          expect(row.role_names).not.toContain('Coach');
          expect(row.role_names).toContain('Player');
          expect(row.permissions).not.toContain('member:edit');
          expect(row.permissions).not.toContain('roster:manage');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'the ancestor walk terminates even when parent_id forms a cycle (cycle guard)',
    () =>
      seedBaseFixture.pipe(
        // Force a cycle directly via SQL: make 'Muži' (the ancestor) its own descendant by
        // pointing it at 'Muži A' (its own child) as parent. A naive `WITH RECURSIVE` walk
        // with no depth guard would loop forever on this shape.
        Effect.tap(({ muziGroupId, muziAGroupId }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql`UPDATE groups SET parent_id = ${muziAGroupId} WHERE id = ${muziGroupId}`,
            ),
          ),
        ),
        Effect.bind('result', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
            // The important assertion is simply that this resolves at all within the
            // timeout (i.e. the query terminated) rather than hanging CI. On timeout this
            // fails with a `TimeoutError` instead of hanging the whole suite.
            Effect.timeout('5 seconds'),
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            expect(Option.isSome(result)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    10_000,
  );

  // Coverage gap 2 (post-fix/role-linking review): the cycle guard above only ran
  // `findRosterMemberByIds` through the cyclic fixture. `findEffectiveRoleIdsForMember`
  // walks the SAME `effectiveRolesFrom` fragment and was unguarded until this fix, so it
  // needs its own regression — a naive `WITH RECURSIVE` with no depth guard would hang
  // forever on this shape, hanging the whole CI run with it.
  it.effect(
    'findEffectiveRoleIdsForMember terminates even when parent_id forms a cycle (cycle guard)',
    () =>
      seedBaseFixture.pipe(
        Effect.tap(({ muziGroupId, muziAGroupId }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql`UPDATE groups SET parent_id = ${muziAGroupId} WHERE id = ${muziGroupId}`,
            ),
          ),
        ),
        Effect.bind('result', ({ memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEffectiveRoleIdsForMember(memberId)),
            Effect.timeout('5 seconds'),
          ),
        ),
        Effect.tap(({ result }) =>
          Effect.sync(() => {
            // Resolving at all (rather than timing out) is the assertion that matters;
            // the role content is incidental here.
            expect(result.some((r) => r.role_name === 'Coach')).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    10_000,
  );

  // Coverage gap 2, other half: `GroupsRepository.findAncestors` (backing `getAncestors`
  // / `getAncestorIds`, and `moveGroup`'s own cycle check) walks `groups.parent_id`
  // independently of `effectiveRoles.ts` and was ALSO unguarded until this fix.
  it.effect(
    'GroupsRepository.getAncestors terminates even when parent_id forms a cycle (cycle guard)',
    () =>
      seedBaseFixture.pipe(
        Effect.tap(({ muziGroupId, muziAGroupId }) =>
          SqlClient.SqlClient.asEffect().pipe(
            Effect.andThen(
              (sql) => sql`UPDATE groups SET parent_id = ${muziAGroupId} WHERE id = ${muziGroupId}`,
            ),
          ),
        ),
        Effect.bind('result', ({ muziAGroupId }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getAncestors(muziAGroupId)),
            Effect.timeout('5 seconds'),
          ),
        ),
        Effect.tap(({ result, muziGroupId }) =>
          Effect.sync(() => {
            // `muziAGroupId`'s parent is `muziGroupId`, and (post-cycle-edit)
            // `muziGroupId`'s parent is `muziAGroupId` itself — the walk must terminate
            // on the depth guard rather than loop, and it still finds the direct parent.
            expect(result.map((g) => g.id)).toContain(muziGroupId);
          }),
        ),
        Effect.provide(TestLayer),
      ),
    10_000,
  );
});
