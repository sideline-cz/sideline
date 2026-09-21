// Regression: "Archived roles still grant permissions" (`fix/archived-roles-grant-permissions`).
//
// `deleteRole` (`api/role.ts`) is a SOFT delete — `RolesRepository.archiveRoleById` runs
// `UPDATE roles SET is_archived = true` and nothing else: `member_roles`, `role_groups` and
// `role_permissions` rows all survive. `effectiveRolesFrom` filtered archived GROUPS but never
// archived ROLES, so every query spliced on that fragment kept handing out a deleted role's
// permissions — including `findMembershipQuery`, the query every `requirePermission` guard reads.
//
// These tests pin the fix at the fragment, on BOTH grant paths (direct `member_roles` and
// group-inherited `role_groups`) and at both projections the fragment exposes (`permissions`,
// which authorization reads, and `effective_roles`, which the roster renders). The
// already-non-archived role in each fixture is the control: it proves the filter removes the
// archived role specifically rather than emptying the whole aggregate.
//
// Fixture helpers mirror `effectiveRolesProvenance.test.ts`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Role, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
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

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId as Discord.Snowflake,
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
        name: 'Archived Role Test Team',
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

const createGroup = (teamId: Team.TeamId, name: string) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, Option.none(), Option.none(), Option.none()),
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

const archiveRole = (roleId: Role.RoleId) =>
  RolesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveRoleById(roleId)));

const membershipOf = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findMembershipByIds(teamId, userId)),
    Effect.map(Option.getOrThrow),
  );

describe('an archived role grants nothing', () => {
  it.effect('a DIRECTLY held archived role contributes no permissions and no role name', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('940000000000000001', 'archived-direct-owner')),
      Effect.bind('memberUserId', () => createUser('940000000000000002', 'archived-direct-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('941010101010101010' as Discord.Snowflake, ownerUserId),
      ),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      Effect.bind('archivedRoleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Deleted Coach', ['member:edit', 'team:manage']),
      ),
      Effect.bind('liveRoleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Live Scorer', ['event:create']),
      ),
      Effect.tap(({ memberId, archivedRoleId }) => assignRoleDirect(memberId, archivedRoleId)),
      Effect.tap(({ memberId, liveRoleId }) => assignRoleDirect(memberId, liveRoleId)),
      Effect.tap(({ archivedRoleId }) => archiveRole(archivedRoleId)),
      Effect.bind('membership', ({ team, memberUserId }) => membershipOf(team.id, memberUserId)),
      Effect.tap(({ membership }) =>
        Effect.sync(() => {
          expect([...membership.permissions].sort()).toEqual(['event:create']);
          expect([...membership.role_names]).toEqual(['Live Scorer']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('a GROUP-INHERITED archived role contributes no permissions and no role name', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('940000000000000011', 'archived-group-owner')),
      Effect.bind('memberUserId', () => createUser('940000000000000012', 'archived-group-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('941020202020202020' as Discord.Snowflake, ownerUserId),
      ),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Leadership')),
      Effect.tap(({ groupId, memberId }) => addMemberToGroup(groupId, memberId)),
      Effect.bind('archivedRoleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Deleted Captain', ['team:manage']),
      ),
      Effect.bind('liveRoleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Live Treasurer', ['finance:view']),
      ),
      Effect.tap(({ archivedRoleId, groupId }) => assignRoleToGroup(archivedRoleId, groupId)),
      Effect.tap(({ liveRoleId, groupId }) => assignRoleToGroup(liveRoleId, groupId)),
      Effect.tap(({ archivedRoleId }) => archiveRole(archivedRoleId)),
      Effect.bind('membership', ({ team, memberUserId }) => membershipOf(team.id, memberUserId)),
      Effect.tap(({ membership }) =>
        Effect.sync(() => {
          expect([...membership.permissions].sort()).toEqual(['finance:view']);
          expect([...membership.role_names]).toEqual(['Live Treasurer']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  // `source: 'both'` is the nastiest shape: the role is reachable by BOTH paths, so a filter
  // applied to only one `JOIN roles` clause would still let it through on the other.
  it.effect('a role held BOTH directly and through a group disappears entirely once archived', () =>
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('940000000000000021', 'archived-both-owner')),
      Effect.bind('memberUserId', () => createUser('940000000000000022', 'archived-both-member')),
      Effect.bind('team', ({ ownerUserId }) =>
        createTeam('941030303030303030' as Discord.Snowflake, ownerUserId),
      ),
      Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
      Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Staff')),
      Effect.tap(({ groupId, memberId }) => addMemberToGroup(groupId, memberId)),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Deleted Manager', ['team:manage']),
      ),
      Effect.tap(({ roleId, groupId }) => assignRoleToGroup(roleId, groupId)),
      Effect.tap(({ memberId, roleId }) => assignRoleDirect(memberId, roleId)),
      Effect.tap(({ roleId }) => archiveRole(roleId)),
      Effect.bind('membership', ({ team, memberUserId }) => membershipOf(team.id, memberUserId)),
      Effect.bind('entry', ({ team, memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          Effect.map(Option.getOrThrow),
        ),
      ),
      Effect.bind('effectiveIds', ({ memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEffectiveRoleIdsForMember(memberId)),
        ),
      ),
      Effect.bind('batched', ({ memberId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findEffectiveRolesForMembers([memberId])),
        ),
      ),
      Effect.tap(({ membership, entry, effectiveIds, batched, roleId }) =>
        Effect.sync(() => {
          expect([...membership.permissions]).toEqual([]);
          expect([...membership.role_names]).toEqual([]);
          expect(entry.effective_roles).toEqual([]);
          // The per-member and batched role queries used to disagree here: the batched one bolted
          // on its own `is_archived` join, the per-member one had none. Both now inherit the
          // fragment's filter, so they agree without either carrying a local join.
          expect(effectiveIds.filter((r) => r.role_id === roleId)).toEqual([]);
          expect(batched.filter((r) => r.role_id === roleId)).toEqual([]);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
