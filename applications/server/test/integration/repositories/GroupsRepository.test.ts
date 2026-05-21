import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  GroupsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Creates a user and returns their UserId. */
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

/** Creates a team with the given user as owner and returns the Team. */
const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
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

/** Adds a user as a team member and returns the TeamMember. */
const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

/** Creates a group under a team (no parent) and returns the GroupRow. */
const createGroup = (
  teamId: Team.TeamId,
  name: string,
  parentId: Option.Option<GroupModel.GroupId> = Option.none(),
) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertGroup(teamId, name, parentId, Option.none(), Option.none()),
    ),
  );

/** Adds a team member to a group. */
const addGroupMember = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(groupId, teamMemberId)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GroupsRepository — member_count', () => {
  it.effect('findGroupsByTeamId returns member_count of 0 for a group with no members', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('100000000000000001', 'owner1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('111111111111111111' as Discord.Snowflake, ownerId),
      ),
      Effect.tap(({ team }) => createGroup(team.id, 'Empty Group')),
      Effect.bind('groups', ({ team }) =>
        GroupsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ groups }) =>
        Effect.sync(() => {
          expect(groups).toHaveLength(1);
          expect(groups[0]?.member_count).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findGroupsByTeamId counts direct members', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('100000000000000002', 'owner2')),
      Effect.bind('memberId', () => createUser('200000000000000002', 'member2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('222222222222222222' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('group', ({ team }) => createGroup(team.id, 'Group With Member')),
      Effect.bind('tm', ({ team, memberId }) => addTeamMember(team.id, memberId)),
      Effect.tap(({ group, tm }) => addGroupMember(group.id, tm.id)),
      Effect.bind('groups', ({ team }) =>
        GroupsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
        ),
      ),
      Effect.tap(({ groups }) =>
        Effect.sync(() => {
          expect(groups).toHaveLength(1);
          expect(groups[0]?.member_count).toBe(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'findGroupsByTeamId counts members from child groups — parent has 1 member, child has 1 different member → parent.memberCount = 2, child.memberCount = 1',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000003', 'owner3')),
        Effect.bind('userId1', () => createUser('200000000000000003', 'user3a')),
        Effect.bind('userId2', () => createUser('300000000000000003', 'user3b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('333333333333333333' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
        Effect.bind('groups', ({ team }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ groups, groupA, groupB }) =>
          Effect.sync(() => {
            const a = groups.find((g) => g.id === groupA.id);
            const b = groups.find((g) => g.id === groupB.id);
            expect(a?.member_count).toBe(2);
            expect(b?.member_count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findGroupsByTeamId counts members from deeply nested groups — A→B→C, 1 unique member each → A=3, B=2, C=1',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000004', 'owner4')),
        Effect.bind('userId1', () => createUser('200000000000000004', 'user4a')),
        Effect.bind('userId2', () => createUser('300000000000000004', 'user4b')),
        Effect.bind('userId3', () => createUser('400000000000000004', 'user4c')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('444444444444444444' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('groupC', ({ team, groupB }) =>
          createGroup(team.id, 'Group C', Option.some(groupB.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.bind('tm3', ({ team, userId3 }) => addTeamMember(team.id, userId3)),
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
        Effect.tap(({ groupC, tm3 }) => addGroupMember(groupC.id, tm3.id)),
        Effect.bind('groups', ({ team }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ groups, groupA, groupB, groupC }) =>
          Effect.sync(() => {
            const a = groups.find((g) => g.id === groupA.id);
            const b = groups.find((g) => g.id === groupB.id);
            const c = groups.find((g) => g.id === groupC.id);
            expect(a?.member_count).toBe(3);
            expect(b?.member_count).toBe(2);
            expect(c?.member_count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findGroupsByTeamId counts distinct members — same member in parent A and child B → A.memberCount = 1',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000005', 'owner5')),
        Effect.bind('userId1', () => createUser('200000000000000005', 'user5a')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('555555555555555555' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        // Add the same member to both parent and child
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm1 }) => addGroupMember(groupB.id, tm1.id)),
        Effect.bind('groups', ({ team }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ groups, groupA, groupB }) =>
          Effect.sync(() => {
            const a = groups.find((g) => g.id === groupA.id);
            const b = groups.find((g) => g.id === groupB.id);
            expect(a?.member_count).toBe(1);
            expect(b?.member_count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findGroupsByTeamId excludes archived child groups from count — parent A with archived child B → A only counts its own members',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000006', 'owner6')),
        Effect.bind('userId1', () => createUser('200000000000000006', 'user6a')),
        Effect.bind('userId2', () => createUser('300000000000000006', 'user6b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('666666666666666666' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
        // Archive child group B
        Effect.tap(({ groupB }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.archiveGroupById(groupB.id)),
          ),
        ),
        Effect.bind('groups', ({ team }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findGroupsByTeamId(team.id)),
          ),
        ),
        Effect.tap(({ groups, groupA }) =>
          Effect.sync(() => {
            // Only group A should be returned (B is archived)
            expect(groups).toHaveLength(1);
            const a = groups.find((g) => g.id === groupA.id);
            // A's count should only include its own direct member, not B's member
            expect(a?.member_count).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

describe('GroupsRepository — getMemberCount', () => {
  it.effect(
    'getMemberCount counts descendant members — parent A + child B, 1 member each → getMemberCount(A) = 2',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000007', 'owner7')),
        Effect.bind('userId1', () => createUser('200000000000000007', 'user7a')),
        Effect.bind('userId2', () => createUser('300000000000000007', 'user7b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('777777777777777777' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
        Effect.bind('countA', ({ groupA }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getMemberCount(groupA.id)),
          ),
        ),
        Effect.bind('countB', ({ groupB }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getMemberCount(groupB.id)),
          ),
        ),
        Effect.tap(({ countA, countB }) =>
          Effect.sync(() => {
            expect(countA).toBe(2);
            expect(countB).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'getMemberCount excludes archived child groups — parent A, archived child B → getMemberCount(A) = 1',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000009', 'owner9')),
        Effect.bind('userId1', () => createUser('200000000000000009', 'user9a')),
        Effect.bind('userId2', () => createUser('300000000000000009', 'user9b')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('999999999999999999' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        Effect.bind('tm2', ({ team, userId2 }) => addTeamMember(team.id, userId2)),
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm2 }) => addGroupMember(groupB.id, tm2.id)),
        // Archive child group B
        Effect.tap(({ groupB }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.archiveGroupById(groupB.id)),
          ),
        ),
        Effect.bind('countA', ({ groupA }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getMemberCount(groupA.id)),
          ),
        ),
        Effect.tap(({ countA }) =>
          Effect.sync(() => {
            // A's count should only include its own direct member, not archived B's member
            expect(countA).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'getMemberCount deduplicates members across descendant groups — same member in A and B → getMemberCount(A) = 1',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('100000000000000008', 'owner8')),
        Effect.bind('userId1', () => createUser('200000000000000008', 'user8a')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('888888888888888888' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('groupA', ({ team }) => createGroup(team.id, 'Group A')),
        Effect.bind('groupB', ({ team, groupA }) =>
          createGroup(team.id, 'Group B', Option.some(groupA.id)),
        ),
        Effect.bind('tm1', ({ team, userId1 }) => addTeamMember(team.id, userId1)),
        // Same member in both parent and child
        Effect.tap(({ groupA, tm1 }) => addGroupMember(groupA.id, tm1.id)),
        Effect.tap(({ groupB, tm1 }) => addGroupMember(groupB.id, tm1.id)),
        Effect.bind('countA', ({ groupA }) =>
          GroupsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.getMemberCount(groupA.id)),
          ),
        ),
        Effect.tap(({ countA }) =>
          Effect.sync(() => {
            expect(countA).toBe(1);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
