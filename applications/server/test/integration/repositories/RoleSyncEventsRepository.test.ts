// Integration coverage for PR-7 (root cause D):
//   - emitRoleAssigned actually inserts a row that the bot's findUnprocessed query returns
//     (root cause D was that nothing ever called these emit* functions in production).
//   - emitRoleAssigned no-ops (writes nothing) when `lookupGuildId` finds no matching team row —
//     the `_emitIfGuildLinked` onNone branch.
//   - TeamMembersRepository.findEffectiveRoleIdsForMember (PR-7 step 3) returns both directly
//     assigned and group-inherited roles, deduplicated.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  RoleSyncEventsRepository.Default,
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
        name: 'Role Sync Events Test Team',
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

describe('RoleSyncEventsRepository — emitRoleAssigned', () => {
  it.effect('inserts a row that findUnprocessed returns', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000001', 'emit-1');
      const team = yield* createTeam('900100000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleAssigned(
        team.id,
        role.id,
        role.name,
        member.id,
        '111111111111111111' as Discord.Snowflake,
      );

      const unprocessed = yield* roleSyncEvents.findUnprocessed(10);
      expect(unprocessed).toHaveLength(1);
      expect(unprocessed[0]?.team_id).toBe(team.id);
      expect(unprocessed[0]?.role_id).toBe(role.id);
      expect(unprocessed[0]?.event_type).toBe('role_assigned');
      expect(Option.getOrNull(unprocessed[0]?.team_member_id ?? Option.none())).toBe(member.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('inserts nothing when the team cannot be found (the lookupGuildId onNone branch)', () =>
    Effect.gen(function* () {
      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      const nonExistentTeamId = '00000000-0000-0000-0000-0000000000ff' as Team.TeamId;
      const fakeRoleId = '00000000-0000-0000-0000-0000000000fe' as Role.RoleId;
      const fakeMemberId = '00000000-0000-0000-0000-0000000000fd' as TeamMember.TeamMemberId;

      yield* roleSyncEvents.emitRoleAssigned(
        nonExistentTeamId,
        fakeRoleId,
        'Ghost Role',
        fakeMemberId,
        '123' as Discord.Snowflake,
      );

      const unprocessed = yield* roleSyncEvents.findUnprocessed(10);
      expect(unprocessed).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('TeamMembersRepository — findEffectiveRoleIdsForMember', () => {
  it.effect('returns direct and group-inherited roles without duplicates', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000002', 'effective-1');
      const team = yield* createTeam('900200000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);

      const roles = yield* RolesRepository.asEffect();
      const directRole = yield* roles.insertRole(team.id, 'Direct Role');
      const inheritedRole = yield* roles.insertRole(team.id, 'Inherited Role');
      const sharedRole = yield* roles.insertRole(team.id, 'Shared Role');

      // Direct assignment.
      const members = yield* TeamMembersRepository.asEffect();
      yield* members.assignRole(member.id, directRole.id);
      // Also assign the "shared" role directly, AND make it reachable via the group below, to
      // prove the UNION dedupes rather than returning it twice.
      yield* members.assignRole(member.id, sharedRole.id);

      // Group inheritance: member -> child group -> parent group carries the role.
      const groups = yield* GroupsRepository.asEffect();
      const parentGroup = yield* groups.insertGroup(
        team.id,
        'Parent Group',
        Option.none(),
        Option.none(),
        Option.none(),
      );
      const childGroup = yield* groups.insertGroup(
        team.id,
        'Child Group',
        Option.some(parentGroup.id),
        Option.none(),
        Option.none(),
      );
      yield* groups.addMemberById(childGroup.id, member.id);
      yield* roles.assignRoleToGroup(inheritedRole.id, parentGroup.id);
      yield* roles.assignRoleToGroup(sharedRole.id, parentGroup.id);

      const effectiveRoles = yield* members.findEffectiveRoleIdsForMember(member.id);
      const roleIds = effectiveRoles.map((r) => r.role_id).sort();

      expect(roleIds).toStrictEqual([directRole.id, inheritedRole.id, sharedRole.id].sort());
      // sharedRole is reachable via BOTH the direct assignment and the group ancestry — must
      // appear exactly once.
      expect(effectiveRoles.filter((r) => r.role_id === sharedRole.id)).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('returns [] for a member with no roles', () =>
    Effect.gen(function* () {
      const userId = yield* createUser('900000000000000003', 'effective-2');
      const team = yield* createTeam('900300000000000000' as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);

      const members = yield* TeamMembersRepository.asEffect();
      const effectiveRoles = yield* members.findEffectiveRoleIdsForMember(member.id);

      expect(effectiveRoles).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
