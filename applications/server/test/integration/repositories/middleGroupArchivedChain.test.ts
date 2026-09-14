// Coverage gap 3 (post-fix/role-linking review): a just-changed semantic.
//
// `effectiveRoles.ts`'s ancestor walk now checks `is_archived` INSIDE the recursive
// term (not just on the final join), matching every other recursive group query in
// `GroupsRepository.ts` (e.g. `findDescendantMembersWithDiscordIdQuery`). That means an
// ARCHIVED ancestor in the MIDDLE of a chain severs it: nothing further up the chain is
// reachable, even though the archived node itself is neither the member's own group nor
// the role-granting node.
//
// Fixture: a three-deep chain A → B → C (`parent_id`: A's parent is B, B's parent is
// C; C is the parent-most / top ancestor and has no parent). `role_groups(R, C)`. A
// member belongs to A (the leaf). Archiving B (the MIDDLE group, neither A nor C) must
// stop the member from inheriting R through C — before this fix, only the *final* join
// checked `is_archived`, so R would still (wrongly) leak through the archived middle
// node.
//
// This is also asserted to AGREE with `GroupsRepository.findDescendantMembersWithDiscordIdByGroupId`
// walking the same chain top-down from C — the incoherence between role inheritance and
// channel/descendant membership (one recursive query respecting the archived-severs-the-
// chain rule, the other not) is exactly what moving the filter fixed.

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
        name: 'Middle Group Archived Chain Test Team',
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

const archiveGroup = (groupId: GroupModel.GroupId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.archiveGroupById(groupId)));

// A → B → C (C is the parent-most ancestor). role_groups(R, C). Member belongs to A.
const seedChainFixture = Effect.Do.pipe(
  Effect.bind('ownerUserId', () => createUser('920000000000000001', 'chain-owner')),
  Effect.bind('memberUserId', () => createUser('920000000000000002', 'chain-member')),
  Effect.bind('team', ({ ownerUserId }) =>
    createTeam('921010101010101010' as Discord.Snowflake, ownerUserId),
  ),
  Effect.bind('groupC', ({ team }) => createGroup(team.id, 'C (top)')),
  Effect.bind('groupB', ({ team, groupC }) =>
    createGroup(team.id, 'B (middle)', Option.some(groupC)),
  ),
  Effect.bind('groupA', ({ team, groupB }) =>
    createGroup(team.id, 'A (leaf)', Option.some(groupB)),
  ),
  Effect.bind('roleId', ({ team }) => createRoleWithPermissions(team.id, 'Coach', ['member:edit'])),
  Effect.tap(({ roleId, groupC }) => assignRoleToGroup(roleId, groupC)),
  Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
  Effect.tap(({ memberId, groupA }) => addMemberToGroup(groupA, memberId)),
  Effect.provide(TestLayer),
);

describe('archived MIDDLE group severs the ancestor chain (effectiveRoles.ts / GroupsRepository agree)', () => {
  it.effect(
    'member sees the role through the full chain before anything is archived (control)',
    () =>
      seedChainFixture.pipe(
        Effect.bind('effectiveRoles', ({ memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEffectiveRoleIdsForMember(memberId)),
          ),
        ),
        Effect.bind('descendantsOfC', ({ groupC }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findDescendantMembersWithDiscordIdByGroupId(groupC)),
          ),
        ),
        Effect.tap(({ effectiveRoles, descendantsOfC, memberId, roleId }) =>
          Effect.sync(() => {
            expect(effectiveRoles.some((r) => r.role_id === roleId)).toBe(true);
            expect(descendantsOfC.some((d) => d.teamMemberId === memberId)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'archiving the MIDDLE group (B) severs the chain: the member no longer effectively holds the role granted to C',
    () =>
      seedChainFixture.pipe(
        Effect.tap(({ groupB }) => archiveGroup(groupB)),
        Effect.bind('effectiveRoles', ({ memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findEffectiveRoleIdsForMember(memberId)),
          ),
        ),
        Effect.tap(({ effectiveRoles, roleId }) =>
          Effect.sync(() => {
            expect(effectiveRoles.some((r) => r.role_id === roleId)).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'archiving the MIDDLE group (B) ALSO severs it for findDescendantMembersWithDiscordIdByGroupId(C) — agreement, not just role inheritance',
    () =>
      seedChainFixture.pipe(
        Effect.tap(({ groupB }) => archiveGroup(groupB)),
        Effect.bind('descendantsOfC', ({ groupC }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findDescendantMembersWithDiscordIdByGroupId(groupC)),
          ),
        ),
        Effect.tap(({ descendantsOfC, memberId }) =>
          Effect.sync(() => {
            expect(descendantsOfC.some((d) => d.teamMemberId === memberId)).toBe(false);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
