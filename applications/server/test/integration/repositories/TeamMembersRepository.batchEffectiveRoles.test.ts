// TDD — regression tests for `fix/group-role-discord-sync`.
//
// `syncGroupRoleMembers.ts` (the shared util for group-shaped role sync) needs a BATCHED
// effective-roles query so a group operation costs a constant number of statements regardless of
// member count, instead of one `findEffectiveRoleIdsForMember` call per member. This file drives
// two NEW `TeamMembersRepository` methods that do not exist yet:
//
//   - `findEffectiveRolesForMembers(memberIds)` — one row per (member, role) across MANY members
//     in a single query, built on the same `effectiveRolesFrom` fragment as
//     `findEffectiveRoleIdsForMemberQuery`, but additionally joined to `roles` with
//     `is_archived = false` (see the divergence test below).
//   - `findGrantedRolePairsForMembers(memberIds)` — the batched form of
//     `member_role_grants` lookups, analogous to `findGrantedRoleIds` but for many members.
//
// Every test below is expected to FAIL until these two methods are added: neither exists on
// `TeamMembersRepository` today, so `repo.findEffectiveRolesForMembers` / `repo
// .findGrantedRolePairsForMembers` are `undefined` and calling them throws a TypeError.
//
// Modelled on `test/integration/repositories/RoleSyncEventsRepository.test.ts`'s
// `findEffectiveRoleIdsForMember` coverage and `test/integration/repositories/
// middleGroupArchivedChain.test.ts`'s archived-ancestor fixture shape.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamMembersRepository.Default,
  RolesRepository.Default,
  GroupsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Batch Effective Roles Test Team',
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

const addActiveMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

let seq = 0;
const nextDiscordId = () => {
  seq += 1;
  return String(930000000000000000n + BigInt(seq)) as Discord.Snowflake;
};

describe('TeamMembersRepository.findEffectiveRolesForMembers', () => {
  it.effect('returns one row per (member, role) across several members in one call', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'batch-owner-1');
      const team = yield* createTeam(nextDiscordId(), ownerId);

      const userA = yield* createUser(nextDiscordId(), 'batch-a');
      const userB = yield* createUser(nextDiscordId(), 'batch-b');
      const memberA = yield* addActiveMember(team.id, userA);
      const memberB = yield* addActiveMember(team.id, userB);

      const roles = yield* RolesRepository.asEffect();
      const roleDirect = yield* roles.insertRole(team.id, 'Direct');
      const roleGroup = yield* roles.insertRole(team.id, 'Group-Granted');

      const members = yield* TeamMembersRepository.asEffect();
      yield* members.assignRole(memberA.id, roleDirect.id);

      const groups = yield* GroupsRepository.asEffect();
      const group = yield* groups.insertGroup(
        team.id,
        'Group',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      yield* groups.addMemberById(group.id, memberB.id);
      yield* roles.assignRoleToGroup(roleGroup.id, group.id);

      const rows = yield* members.findEffectiveRolesForMembers([memberA.id, memberB.id]);

      const forA = rows.filter((r: any) => r.team_member_id === memberA.id);
      const forB = rows.filter((r: any) => r.team_member_id === memberB.id);
      expect(forA.map((r: any) => r.role_id)).toStrictEqual([roleDirect.id]);
      expect(forB.map((r: any) => r.role_id)).toStrictEqual([roleGroup.id]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a role reached via TWO groups appears exactly once for the member', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'batch-owner-2');
      const team = yield* createTeam(nextDiscordId(), ownerId);
      const userA = yield* createUser(nextDiscordId(), 'batch-dup-a');
      const memberA = yield* addActiveMember(team.id, userA);

      const roles = yield* RolesRepository.asEffect();
      const sharedRole = yield* roles.insertRole(team.id, 'Shared');

      const groups = yield* GroupsRepository.asEffect();
      const groupOne = yield* groups.insertGroup(
        team.id,
        'GroupOne',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      const groupTwo = yield* groups.insertGroup(
        team.id,
        'GroupTwo',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      yield* groups.addMemberById(groupOne.id, memberA.id);
      yield* groups.addMemberById(groupTwo.id, memberA.id);
      yield* roles.assignRoleToGroup(sharedRole.id, groupOne.id);
      yield* roles.assignRoleToGroup(sharedRole.id, groupTwo.id);

      const members = yield* TeamMembersRepository.asEffect();
      const rows = yield* members.findEffectiveRolesForMembers([memberA.id]);

      expect(rows.filter((r: any) => r.role_id === sharedRole.id)).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'excludes a role that is archived (divergence from findEffectiveRoleIdsForMember)',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser(nextDiscordId(), 'batch-owner-3');
        const team = yield* createTeam(nextDiscordId(), ownerId);
        const userA = yield* createUser(nextDiscordId(), 'batch-archived-a');
        const memberA = yield* addActiveMember(team.id, userA);

        const roles = yield* RolesRepository.asEffect();
        const role = yield* roles.insertRole(team.id, 'ToArchive');

        const members = yield* TeamMembersRepository.asEffect();
        yield* members.assignRole(memberA.id, role.id);
        yield* roles.archiveRoleById(role.id);

        const rows = yield* members.findEffectiveRolesForMembers([memberA.id]);
        expect(rows.filter((r: any) => r.role_id === role.id)).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('empty memberIds returns [] with no crash', () =>
    Effect.gen(function* () {
      const members = yield* TeamMembersRepository.asEffect();
      const rows = yield* members.findEffectiveRolesForMembers([]);
      expect(rows).toStrictEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Anti-divergence test: agrees with `findEffectiveRoleIdsForMember` member-by-member, EXCEPT
  // for archived roles — `findEffectiveRoleIdsForMemberQuery` has no `roles.is_archived` join
  // (`TeamMembersRepository.ts:233-245`), so the two legitimately diverge there. This fixture
  // uses only non-archived roles so the comparison is exact.
  it.effect('matches findEffectiveRoleIdsForMember per member, for non-archived roles', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'batch-owner-4');
      const team = yield* createTeam(nextDiscordId(), ownerId);
      const userA = yield* createUser(nextDiscordId(), 'batch-parity-a');
      const userB = yield* createUser(nextDiscordId(), 'batch-parity-b');
      const memberA = yield* addActiveMember(team.id, userA);
      const memberB = yield* addActiveMember(team.id, userB);

      const roles = yield* RolesRepository.asEffect();
      const roleOne = yield* roles.insertRole(team.id, 'Parity One');
      const roleTwo = yield* roles.insertRole(team.id, 'Parity Two');

      const members = yield* TeamMembersRepository.asEffect();
      yield* members.assignRole(memberA.id, roleOne.id);

      const groups = yield* GroupsRepository.asEffect();
      const group = yield* groups.insertGroup(
        team.id,
        'Parity Group',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      yield* groups.addMemberById(group.id, memberB.id);
      yield* roles.assignRoleToGroup(roleTwo.id, group.id);

      const batched = yield* members.findEffectiveRolesForMembers([memberA.id, memberB.id]);
      const perMemberA = yield* members.findEffectiveRoleIdsForMember(memberA.id);
      const perMemberB = yield* members.findEffectiveRoleIdsForMember(memberB.id);

      const batchedA = batched
        .filter((r: any) => r.team_member_id === memberA.id)
        .map((r: any) => r.role_id)
        .sort();
      const batchedB = batched
        .filter((r: any) => r.team_member_id === memberB.id)
        .map((r: any) => r.role_id)
        .sort();

      expect(batchedA).toStrictEqual(perMemberA.map((r) => r.role_id).sort());
      expect(batchedB).toStrictEqual(perMemberB.map((r) => r.role_id).sort());
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('TeamMembersRepository.findGrantedRolePairsForMembers', () => {
  it.effect('returns the granted (member, role) pairs for several members in one call', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser(nextDiscordId(), 'batch-grant-owner');
      const team = yield* createTeam(nextDiscordId(), ownerId);
      const userA = yield* createUser(nextDiscordId(), 'batch-grant-a');
      const userB = yield* createUser(nextDiscordId(), 'batch-grant-b');
      const memberA = yield* addActiveMember(team.id, userA);
      const memberB = yield* addActiveMember(team.id, userB);

      const roles = yield* RolesRepository.asEffect();
      const roleA = yield* roles.insertRole(team.id, 'Granted To A');
      const roleB = yield* roles.insertRole(team.id, 'Granted To Neither');

      const members = yield* TeamMembersRepository.asEffect();
      yield* members.recordRoleGrant(memberA.id, roleA.id);

      const pairs = yield* members.findGrantedRolePairsForMembers([memberA.id, memberB.id]);

      expect(pairs).toStrictEqual([{ team_member_id: memberA.id, role_id: roleA.id }]);
      expect(pairs.some((p: any) => p.role_id === roleB.id)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('empty memberIds returns [] with no crash', () =>
    Effect.gen(function* () {
      const members = yield* TeamMembersRepository.asEffect();
      const pairs = yield* members.findGrantedRolePairsForMembers([]);
      expect(pairs).toStrictEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
