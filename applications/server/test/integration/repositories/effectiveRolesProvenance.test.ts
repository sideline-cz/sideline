// Coverage gap 4 (post-fix/role-linking review): `effectiveRolesFrom`'s per-role
// provenance (`source` / `group_names`, surfaced as `RosterEntry.effective_roles` via
// `effectiveRolesAggLateral`) had no coverage for:
//   - a role granted by TWO different groups the member belongs to — must dedupe to
//     ONE row for that role, `source: 'inherited'`, `group_names` containing BOTH names
//     (the fragment's `GROUP BY combined.role_id` + `array_agg(DISTINCT ...)`).
//   - a role granted by a group AND held directly — `source: 'both'`, with the
//     granting group's name still present in `group_names` (only `'direct'` clears it).

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
        name: 'Effective Roles Provenance Test Team',
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

describe('effectiveRolesFrom provenance — source / group_names', () => {
  it.effect(
    'a role granted by TWO different groups the member belongs to appears exactly once, source inherited, with both group names',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerUserId', () => createUser('930000000000000001', 'two-groups-owner')),
        Effect.bind('memberUserId', () => createUser('930000000000000002', 'two-groups-member')),
        Effect.bind('team', ({ ownerUserId }) =>
          createTeam('931010101010101010' as Discord.Snowflake, ownerUserId),
        ),
        Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
        Effect.bind('roleId', ({ team }) =>
          createRoleWithPermissions(team.id, 'Coach', ['member:edit']),
        ),
        Effect.bind('groupOneId', ({ team }) => createGroup(team.id, 'Group One')),
        Effect.bind('groupTwoId', ({ team }) => createGroup(team.id, 'Group Two')),
        Effect.tap(({ roleId, groupOneId }) => assignRoleToGroup(roleId, groupOneId)),
        Effect.tap(({ roleId, groupTwoId }) => assignRoleToGroup(roleId, groupTwoId)),
        Effect.tap(({ groupOneId, memberId }) => addMemberToGroup(groupOneId, memberId)),
        Effect.tap(({ groupTwoId, memberId }) => addMemberToGroup(groupTwoId, memberId)),
        Effect.bind('entry', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          ),
        ),
        Effect.tap(({ entry, roleId }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(entry);
            const coachRows = row.effective_roles.filter((r) => r.role_id === roleId);
            expect(coachRows).toHaveLength(1);
            expect(coachRows[0]?.source).toBe('inherited');
            expect([...(coachRows[0]?.group_names ?? [])].sort()).toEqual([
              'Group One',
              'Group Two',
            ]);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'a role granted by a group AND held directly has source "both" with the granting group name still present',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerUserId', () => createUser('930000000000000011', 'both-source-owner')),
        Effect.bind('memberUserId', () => createUser('930000000000000012', 'both-source-member')),
        Effect.bind('team', ({ ownerUserId }) =>
          createTeam('931020202020202020' as Discord.Snowflake, ownerUserId),
        ),
        Effect.bind('memberId', ({ team, memberUserId }) => addTeamMember(team.id, memberUserId)),
        Effect.bind('roleId', ({ team }) =>
          createRoleWithPermissions(team.id, 'Coach', ['member:edit']),
        ),
        Effect.bind('groupId', ({ team }) => createGroup(team.id, 'Leadership')),
        Effect.tap(({ roleId, groupId }) => assignRoleToGroup(roleId, groupId)),
        Effect.tap(({ groupId, memberId }) => addMemberToGroup(groupId, memberId)),
        Effect.tap(({ memberId, roleId }) => assignRoleDirect(memberId, roleId)),
        Effect.bind('entry', ({ team, memberId }) =>
          TeamMembersRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findRosterMemberByIds(team.id, memberId)),
          ),
        ),
        Effect.tap(({ entry, roleId }) =>
          Effect.sync(() => {
            const row = Option.getOrThrow(entry);
            const coachRows = row.effective_roles.filter((r) => r.role_id === roleId);
            expect(coachRows).toHaveLength(1);
            expect(coachRows[0]?.source).toBe('both');
            expect(coachRows[0]?.group_names).toEqual(['Leadership']);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
