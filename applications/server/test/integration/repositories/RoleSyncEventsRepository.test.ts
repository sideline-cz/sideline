// Integration coverage for `fix/discord-roles-sync`:
//   - Every emit* on RoleSyncEventsRepository writes NOTHING. A Sideline role is a permissions
//     construct and is never mirrored into a Discord guild role; Discord roles come from groups
//     and rosters (`channel_sync_events`) and achievements (`role_provision_events`), none of
//     which touch this repository.
//   - findUnprocessed drains nothing either, so rows enqueued before this change cannot mint a
//     Discord role after deploy.
//   - TeamMembersRepository.findEffectiveRoleIdsForMember still returns both directly assigned
//     and group-inherited roles, deduplicated — Sideline-side role resolution is unchanged, only
//     its propagation to Discord is gone.
//
// The `markProcessed` / `markFailed` fidelity and same-tick-guard describes that used to live
// here were removed with this change: both functions are only ever called by the bot's role
// ProcessorService on an event `findUnprocessed` handed it, so with the queue no longer drained
// they are unreachable, and the only way to keep exercising them would be to seed `role_sync_events`
// by raw SQL — testing a path production can no longer take. They are deleted along with the rest
// of the subsystem in the follow-up ticket.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
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

const countEvents = () =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ count: string }>`SELECT count(*)::text AS count FROM role_sync_events`,
    ),
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

describe('RoleSyncEventsRepository — Sideline roles are never mirrored into Discord', () => {
  const seedTeamAndMember = (discordSuffix: string, guildId: string, username: string) =>
    Effect.gen(function* () {
      const userId = yield* createUser(discordSuffix, username);
      const team = yield* createTeam(guildId as Discord.Snowflake, userId);
      const member = yield* addActiveMember(team.id, userId);
      return { team, member };
    });

  it.effect('emitRoleAssigned writes nothing, even for a linked team and a custom role', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedTeamAndMember(
        '900000000000000001',
        '900100000000000000',
        'emit-1',
      );
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

      expect(yield* countEvents()).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The removal direction matters as much as the assign direction: a `role_unassigned` would make
  // the bot resolve a mapping for the role in order to strip it, creating the guild role on the way.
  it.effect('emitRoleUnassigned writes nothing', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedTeamAndMember(
        '900000000000000002',
        '900100000000000001',
        'emit-2',
      );
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleUnassigned(
        team.id,
        role.id,
        role.name,
        member.id,
        '111111111111111111' as Discord.Snowflake,
      );

      expect(yield* countEvents()).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('emitRoleCreated and emitRoleDeleted write nothing', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeamAndMember(
        '900000000000000003',
        '900100000000000002',
        'emit-3',
      );
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleCreated(team.id, role.id, role.name);
      yield* roleSyncEvents.emitRoleDeleted(team.id, role.id, role.name);

      expect(yield* countEvents()).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // `syncGroupRoleMembers.ts`'s batched path — one call per group operation rather than per member.
  it.effect('emitRoleEventsBatch writes nothing for a full batch', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedTeamAndMember(
        '900000000000000004',
        '900100000000000003',
        'emit-4',
      );
      const roles = yield* RolesRepository.asEffect();
      const roleOne = yield* roles.insertRole(team.id, 'Batch One');
      const roleTwo = yield* roles.insertRole(team.id, 'Batch Two');

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleEventsBatch({
        teamId: team.id,
        entries: [
          {
            eventType: 'role_assigned',
            roleId: roleOne.id,
            roleName: roleOne.name,
            teamMemberId: member.id,
            discordUserId: '111111111111111111' as Discord.Snowflake,
          },
          {
            eventType: 'role_unassigned',
            roleId: roleTwo.id,
            roleName: roleTwo.name,
            teamMemberId: member.id,
            discordUserId: '111111111111111111' as Discord.Snowflake,
          },
        ],
      });

      expect(yield* countEvents()).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an empty entries array is still a no-op', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeamAndMember(
        '900000000000000005',
        '900100000000000004',
        'emit-5',
      );

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      yield* roleSyncEvents.emitRoleEventsBatch({ teamId: team.id, entries: [] });

      expect(yield* countEvents()).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The production reason `findUnprocessed` short-circuits rather than draining: rows enqueued
  // before this change are still in the table, and draining them would mint exactly the Discord
  // roles this change removes — once, right after deploy.
  it.effect('findUnprocessed returns nothing even when a legacy row exists in the table', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedTeamAndMember(
        '900000000000000006',
        '900100000000000005',
        'emit-6',
      );
      const roles = yield* RolesRepository.asEffect();
      const role = yield* roles.insertRole(team.id, 'Coach');

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO role_sync_events (team_id, guild_id, event_type, role_id, role_name, team_member_id, discord_user_id)
        VALUES (${team.id}, '900100000000000005', 'role_assigned', ${role.id}, ${role.name}, ${member.id}, '111111111111111111')
      `;
      expect(yield* countEvents()).toBe(1);

      const roleSyncEvents = yield* RoleSyncEventsRepository.asEffect();
      expect(yield* roleSyncEvents.findUnprocessed(10)).toHaveLength(0);
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
