/**
 * Integration tests for the "deactivate member on Discord leave + cascade" feature.
 *
 * Covers:
 *   A. deactivateMemberAndCascade — the core cascade utility
 *   B. Guild/RemoveMember RPC path — unknown guild, unknown user, known active member
 *   C. PersonalEventChannelsRepository.getInactiveMembersToDeprovision
 */

import { describe, expect, it } from '@effect/vitest';
import type { Discord, GroupModel, RosterModel, Team, TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { PersonalEventChannelsRepository } from '~/repositories/PersonalEventChannelsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { deactivateMemberAndCascade } from '~/utils/deactivateMemberCascade.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

// ---------------------------------------------------------------------------
// Shared test layer
// ---------------------------------------------------------------------------

const TestLayer = Layer.mergeAll(
  ChannelSyncEventsRepository.Default,
  GroupsRepository.Default,
  PersonalEventChannelsRepository.Default,
  RolesRepository.Default,
  RostersRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Seed helpers
// ---------------------------------------------------------------------------

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
        name: 'Cascade Test Team',
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
  );

const createRoster = (teamId: Team.TeamId, name = 'Squad') =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        active: true,
        color: Option.none(),
        emoji: Option.none(),
      }),
    ),
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
  );

const addGroupMember = (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) =>
  GroupsRepository.asEffect().pipe(Effect.andThen((repo) => repo.addMemberById(groupId, memberId)));

const addRosterMember = (rosterId: RosterModel.RosterId, memberId: TeamMember.TeamMemberId) =>
  RostersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.addMemberById(rosterId, memberId)),
  );

/**
 * Seeds the built-in roles (Admin, Captain, Player, Treasurer) with their
 * default permissions, finds the Admin role, and assigns it to the given member.
 */
const grantTeamManage = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
  Effect.gen(function* () {
    const rolesRepo = yield* RolesRepository.asEffect();
    const membersRepo = yield* TeamMembersRepository.asEffect();
    yield* rolesRepo.seedTeamRolesWithPermissions(teamId);
    const roles = yield* rolesRepo.findRolesByTeamId(teamId);
    const admin = roles.find((r) => r.name === 'Admin');
    if (!admin) return yield* Effect.die(new Error('Admin role not found after seeding'));
    yield* membersRepo.assignRole(memberId, admin.id);
    return admin.id;
  });

/**
 * Build the CascadeDeps object from live repository instances.
 */
const runCascade = (
  teamId: Team.TeamId,
  memberId: TeamMember.TeamMemberId,
  memberHoldsManage: boolean,
  discordUserId: Discord.Snowflake,
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient.asEffect();
    const membersRepo = yield* TeamMembersRepository.asEffect();
    const rostersRepo = yield* RostersRepository.asEffect();
    const groupsRepo = yield* GroupsRepository.asEffect();
    const channelSyncRepo = yield* ChannelSyncEventsRepository.asEffect();

    return yield* deactivateMemberAndCascade(
      {
        sql,
        members: {
          findById: membersRepo.findById,
          deactivateMemberByIds: (tId, mId) =>
            membersRepo.deactivateMemberByIds(tId, mId).pipe(Effect.asVoid, Effect.orDie),
          hasOtherActiveManager: membersRepo.hasOtherActiveManager,
        },
        rosters: {
          findRosterIdsByMember: rostersRepo.findRosterIdsByMember,
          findRosterById: rostersRepo.findRosterById,
          removeAllForMember: rostersRepo.removeAllForMember,
        },
        groups: {
          findGroupIdsByMember: groupsRepo.findGroupIdsByMember,
          findGroupById: groupsRepo.findGroupById,
          getAncestors: groupsRepo.getAncestors,
          removeAllForMember: groupsRepo.removeAllForMember,
        },
        channelSync: {
          emitRosterMemberRemoved: channelSyncRepo.emitRosterMemberRemoved,
          emitMemberRemoved: channelSyncRepo.emitMemberRemoved,
        },
      },
      teamId,
      memberId,
      memberHoldsManage,
      discordUserId,
    );
  });

// ---------------------------------------------------------------------------
// A. Core cascade utility — deactivateMemberAndCascade
// ---------------------------------------------------------------------------

describe('deactivateMemberAndCascade — basic deactivation', () => {
  it.effect(
    'deactivates active non-admin member: sets active=false, removes group/roster memberships, row still exists',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('910100000000000001', 'cascade-owner-1');
        const team = yield* createTeam('910100000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('910100000000000002', 'cascade-member-1');
        const member = yield* addTeamMember(team.id, userId);
        const roster = yield* createRoster(team.id);
        const group = yield* createGroup(team.id, 'Group Alpha');
        yield* addRosterMember(roster.id, member.id);
        yield* addGroupMember(group.id, member.id);

        const result = yield* runCascade(
          team.id,
          member.id,
          false,
          '910100000000000002' as Discord.Snowflake,
        );

        expect(result.deactivated).toBe(true);

        const membersRepo = yield* TeamMembersRepository.asEffect();
        const memberRow = yield* membersRepo.findById(member.id);
        expect(Option.isSome(memberRow)).toBe(true);
        expect(Option.getOrThrow(memberRow).active).toBe(false);

        const groupsRepo = yield* GroupsRepository.asEffect();
        const groupIds = yield* groupsRepo.findGroupIdsByMember(member.id);
        expect(groupIds).toHaveLength(0);

        const rostersRepo = yield* RostersRepository.asEffect();
        const rosterIds = yield* rostersRepo.findRosterIdsByMember(member.id);
        expect(rosterIds).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'emits one member_removed channel_sync_event per roster + per direct group + per ancestor group',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('910200000000000001', 'cascade-owner-2');
        const team = yield* createTeam('910200000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('910200000000000002', 'cascade-member-2');
        const member = yield* addTeamMember(team.id, userId);
        const roster = yield* createRoster(team.id, 'TestSquad');
        // ancestor → parent → child; member is only in child
        const ancestorGroup = yield* createGroup(team.id, 'Ancestor Group');
        const parentGroup = yield* createGroup(
          team.id,
          'Parent Group',
          Option.some(ancestorGroup.id),
        );
        const childGroup = yield* createGroup(team.id, 'Child Group', Option.some(parentGroup.id));
        yield* addRosterMember(roster.id, member.id);
        yield* addGroupMember(childGroup.id, member.id);

        const result = yield* runCascade(
          team.id,
          member.id,
          false,
          '910200000000000002' as Discord.Snowflake,
        );
        expect(result.deactivated).toBe(true);

        const sql = yield* SqlClient.SqlClient.asEffect();
        const events = yield* sql.unsafe<{
          event_type: string;
          group_id: string | null;
          roster_id: string | null;
          team_member_id: string;
        }>(
          `SELECT event_type, group_id, roster_id, team_member_id
           FROM channel_sync_events
           WHERE team_id = '${team.id}' AND team_member_id = '${member.id}'
           ORDER BY created_at`,
        );

        // 1 roster event + 3 group events (child + parent + ancestor)
        expect(events).toHaveLength(4);

        const rosterEvents = events.filter(
          (e) => e.roster_id === roster.id && e.event_type === 'member_removed',
        );
        expect(rosterEvents).toHaveLength(1);

        const groupEventIds = events.filter((e) => e.group_id !== null).map((e) => e.group_id);
        expect(groupEventIds).toContain(childGroup.id);
        expect(groupEventIds).toContain(parentGroup.id);
        expect(groupEventIds).toContain(ancestorGroup.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe('deactivateMemberAndCascade — owner guard (last_admin)', () => {
  it.effect(
    'last active admin: cascade returns last_admin, member stays active, memberships intact, no events emitted',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('910300000000000001', 'cascade-owner-3');
        const team = yield* createTeam('910300000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('910300000000000002', 'cascade-admin-3');
        const member = yield* addTeamMember(team.id, userId);
        const group = yield* createGroup(team.id, 'Admin Group');
        yield* addGroupMember(group.id, member.id);
        // Grant team:manage to the ONLY active member
        yield* grantTeamManage(team.id, member.id);

        const result = yield* runCascade(
          team.id,
          member.id,
          /* memberHoldsManage */ true,
          '910300000000000002' as Discord.Snowflake,
        );

        expect(result.deactivated).toBe(false);
        if (!result.deactivated) {
          expect(result.reason).toBe('last_admin');
        }

        // Member must still be active
        const membersRepo = yield* TeamMembersRepository.asEffect();
        const memberRow = yield* membersRepo.findById(member.id);
        expect(Option.getOrThrow(memberRow).active).toBe(true);

        // Group memberships must be intact
        const groupsRepo = yield* GroupsRepository.asEffect();
        const groupIds = yield* groupsRepo.findGroupIdsByMember(member.id);
        expect(groupIds).toHaveLength(1);

        // No channel_sync_events emitted
        const sql = yield* SqlClient.SqlClient.asEffect();
        const countRows = yield* sql.unsafe<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM channel_sync_events
           WHERE team_id = '${team.id}' AND team_member_id = '${member.id}'`,
        );
        expect(parseInt(countRows[0]?.count ?? '1', 10)).toBe(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'owner guard negative: second active admin lets first member be deactivated normally',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('910400000000000001', 'cascade-owner-4');
        const team = yield* createTeam('910400000000000099' as Discord.Snowflake, ownerId);
        const userId1 = yield* createUser('910400000000000002', 'cascade-admin-4a');
        const userId2 = yield* createUser('910400000000000003', 'cascade-admin-4b');
        const member1 = yield* addTeamMember(team.id, userId1);
        const member2 = yield* addTeamMember(team.id, userId2);
        // Grant team:manage to both — seeds roles once for member1, then reuses for member2
        yield* grantTeamManage(team.id, member1.id);
        const rolesRepo = yield* RolesRepository.asEffect();
        const roles = yield* rolesRepo.findRolesByTeamId(team.id);
        const admin = roles.find((r) => r.name === 'Admin');
        if (!admin) return yield* Effect.die(new Error('Admin role not found'));
        const membersRepo = yield* TeamMembersRepository.asEffect();
        yield* membersRepo.assignRole(member2.id, admin.id);

        // Deactivating member1 should succeed because member2 also holds team:manage
        const result = yield* runCascade(
          team.id,
          member1.id,
          true,
          '910400000000000002' as Discord.Snowflake,
        );

        expect(result.deactivated).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe('deactivateMemberAndCascade — already inactive guard', () => {
  it.effect('already-inactive member → returns already_inactive, no-op', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('910500000000000001', 'cascade-owner-5');
      const team = yield* createTeam('910500000000000099' as Discord.Snowflake, ownerId);
      const userId = yield* createUser('910500000000000002', 'cascade-member-5');
      const member = yield* addTeamMember(team.id, userId);
      // Deactivate first
      const membersRepo = yield* TeamMembersRepository.asEffect();
      yield* membersRepo.deactivateMemberByIds(team.id, member.id);

      const result = yield* runCascade(
        team.id,
        member.id,
        false,
        '910500000000000002' as Discord.Snowflake,
      );

      expect(result.deactivated).toBe(false);
      if (!result.deactivated) {
        expect(result.reason).toBe('already_inactive');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('deactivateMemberAndCascade — history preservation', () => {
  it.effect('RSVP rows survive cascade — history is NOT deleted', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('910600000000000001', 'cascade-owner-6');
      const team = yield* createTeam('910600000000000099' as Discord.Snowflake, ownerId);
      const userId = yield* createUser('910600000000000002', 'cascade-member-6');
      const member = yield* addTeamMember(team.id, userId);

      // Insert an event and RSVP directly via SQL (simplest path — avoids full event seeding)
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql.unsafe(`
        INSERT INTO events (team_id, title, event_type, start_at, created_by, status)
        VALUES ('${team.id}', 'Cascade Test Event', 'training',
                now() + interval '1 day', '${member.id}', 'active')
      `);
      const eventRows = yield* sql.unsafe<{ id: string }>(
        `SELECT id FROM events WHERE team_id = '${team.id}' LIMIT 1`,
      );
      const eventId = eventRows[0]?.id ?? '';

      yield* sql.unsafe(`
        INSERT INTO event_rsvps (event_id, team_member_id, response)
        VALUES ('${eventId}', '${member.id}', 'yes')
      `);

      yield* runCascade(team.id, member.id, false, '910600000000000002' as Discord.Snowflake);

      const rsvpRows = yield* sql.unsafe<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM event_rsvps
         WHERE event_id = '${eventId}' AND team_member_id = '${member.id}'`,
      );
      expect(parseInt(rsvpRows[0]?.count ?? '0', 10)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B. Guild/RemoveMember RPC path — no-op cases and full deactivation path
//    Exercise the same logic flow the RPC handler uses (via repository calls
//    and the cascade utility), without instantiating the full GuildsRpcLive.
// ---------------------------------------------------------------------------

describe('Guild/RemoveMember — no-op paths', () => {
  it.effect('unknown guild → findByGuildId returns None → no member deactivated', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('910700000000000001', 'noopguild-owner');
      const team = yield* createTeam('910700000000000099' as Discord.Snowflake, ownerId);
      const userId = yield* createUser('910700000000000002', 'noopguild-member');
      const member = yield* addTeamMember(team.id, userId);

      // A guild_id that was never registered has no associated team
      const teamsRepo = yield* TeamsRepository.asEffect();
      const noTeam = yield* teamsRepo.findByGuildId('999999999999000000' as Discord.Snowflake);
      expect(Option.isNone(noTeam)).toBe(true);

      // Member is still active — no cascade ran
      const membersRepo = yield* TeamMembersRepository.asEffect();
      const memberRow = yield* membersRepo.findById(member.id);
      expect(Option.getOrThrow(memberRow).active).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('unknown discord user → findByDiscordId returns None → no member deactivated', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('910800000000000001', 'noopdiscord-owner');
      const team = yield* createTeam('910800000000000099' as Discord.Snowflake, ownerId);
      const userId = yield* createUser('910800000000000002', 'noopdiscord-member');
      const member = yield* addTeamMember(team.id, userId);

      const usersRepo = yield* UsersRepository.asEffect();
      const noUser = yield* usersRepo.findByDiscordId('777777777777000000' as Discord.Snowflake);
      expect(Option.isNone(noUser)).toBe(true);

      // Member is still active
      const membersRepo = yield* TeamMembersRepository.asEffect();
      const memberRow = yield* membersRepo.findById(member.id);
      expect(Option.getOrThrow(memberRow).active).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('known active member via cascade: deactivated + roster/group memberships removed', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('910900000000000001', 'rpcfull-owner');
      const team = yield* createTeam('910900000000000099' as Discord.Snowflake, ownerId);
      const userId = yield* createUser('910900000000000002', 'rpcfull-member');
      const member = yield* addTeamMember(team.id, userId);
      const roster = yield* createRoster(team.id, 'RpcSquad');
      const group = yield* createGroup(team.id, 'RpcGroup');
      yield* addRosterMember(roster.id, member.id);
      yield* addGroupMember(group.id, member.id);

      const result = yield* runCascade(
        team.id,
        member.id,
        false,
        '910900000000000002' as Discord.Snowflake,
      );
      expect(result.deactivated).toBe(true);

      const membersRepo = yield* TeamMembersRepository.asEffect();
      const memberRow = yield* membersRepo.findById(member.id);
      expect(Option.getOrThrow(memberRow).active).toBe(false);

      const groupsRepo = yield* GroupsRepository.asEffect();
      const groupIds = yield* groupsRepo.findGroupIdsByMember(member.id);
      expect(groupIds).toHaveLength(0);

      const rostersRepo = yield* RostersRepository.asEffect();
      const rosterIds = yield* rostersRepo.findRosterIdsByMember(member.id);
      expect(rosterIds).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// C. PersonalEventChannelsRepository.getInactiveMembersToDeprovision
// ---------------------------------------------------------------------------

describe('PersonalEventChannelsRepository — getInactiveMembersToDeprovision', () => {
  it.effect(
    'inactive member with a provisioned channel appears in deprovision list (open-to-all team)',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('911000000000000001', 'deprov-owner-1');
        const team = yield* createTeam('911000000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('911000000000000002', 'deprov-member-1');
        const member = yield* addTeamMember(team.id, userId);

        const personalChannelsRepo = yield* PersonalEventChannelsRepository.asEffect();
        yield* personalChannelsRepo.reservePersonalChannel(team.id, member.id);
        yield* personalChannelsRepo.savePersonalChannelId(
          team.id,
          member.id,
          '911000000000000777' as Discord.Snowflake,
          'events-{discord_id}',
        );

        // Deactivate the member (simulating Discord leave)
        const membersRepo = yield* TeamMembersRepository.asEffect();
        yield* membersRepo.deactivateMemberByIds(team.id, member.id);

        const toDeprovision = yield* personalChannelsRepo.getInactiveMembersToDeprovision(
          team.id,
          100,
        );

        const memberIds = toDeprovision.map((r) => r.team_member_id);
        expect(memberIds).toContain(member.id);
        const row = toDeprovision.find((r) => r.team_member_id === member.id);
        expect(String(row?.discord_channel_id)).toBe('911000000000000777');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'active member with a provisioned channel does NOT appear in inactive deprovision list',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('911100000000000001', 'deprov-owner-2');
        const team = yield* createTeam('911100000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('911100000000000002', 'deprov-member-2');
        const member = yield* addTeamMember(team.id, userId);

        const personalChannelsRepo = yield* PersonalEventChannelsRepository.asEffect();
        yield* personalChannelsRepo.reservePersonalChannel(team.id, member.id);
        yield* personalChannelsRepo.savePersonalChannelId(
          team.id,
          member.id,
          '911100000000000777' as Discord.Snowflake,
          'events-{discord_id}',
        );

        // Member remains active — must NOT appear
        const toDeprovision = yield* personalChannelsRepo.getInactiveMembersToDeprovision(
          team.id,
          100,
        );

        const memberIds = toDeprovision.map((r) => r.team_member_id);
        expect(memberIds).not.toContain(member.id);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'open-to-all team: inactive member without personal-events group configured still appears',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('911200000000000001', 'deprov-owner-3');
        const team = yield* createTeam('911200000000000099' as Discord.Snowflake, ownerId);
        const userId = yield* createUser('911200000000000002', 'deprov-member-3');
        const member = yield* addTeamMember(team.id, userId);
        // No group membership; no personal-events group setting configured

        const personalChannelsRepo = yield* PersonalEventChannelsRepository.asEffect();
        yield* personalChannelsRepo.reservePersonalChannel(team.id, member.id);
        yield* personalChannelsRepo.savePersonalChannelId(
          team.id,
          member.id,
          '911200000000000777' as Discord.Snowflake,
          'events-{discord_id}',
        );

        // Deactivate (cascade complete)
        const membersRepo = yield* TeamMembersRepository.asEffect();
        yield* membersRepo.deactivateMemberByIds(team.id, member.id);

        const toDeprovision = yield* personalChannelsRepo.getInactiveMembersToDeprovision(
          team.id,
          100,
        );

        // Inactive-based deprovision always runs regardless of group config
        const memberIds = toDeprovision.map((r) => r.team_member_id);
        expect(memberIds).toContain(member.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});
