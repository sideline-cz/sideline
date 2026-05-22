/**
 * TDD tests for Group/SyncRoleMembers endpoint.
 *
 * These tests describe NEW behavior and are expected to FAIL until the server
 * handler is implemented.
 *
 * Domain shape already in place:
 *   - GroupApi.syncRoleMembers POST /teams/:teamId/groups/:groupId/sync-role-members
 *   - GroupApi.SyncRoleMembersResult { addedCount, removedCount, skippedCount, noGuildLinked }
 *
 * New repository method assumed by the implementation:
 *   - GroupsRepository.findMembersWithDiscordIdByGroupId(groupId)
 *     → { teamMemberId, discordUserId: string | null }[]
 */

import type { Auth, Discord, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventSeriesRepository } from '~/repositories/EventSeriesRepository.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { RosterEntry, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_USER_B_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_USER_C_ID = '00000000-0000-0000-0000-000000000004' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;

const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_MEMBER_B_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const TEST_MEMBER_C_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;
const TEST_MEMBER_NO_DISCORD_ID = '00000000-0000-0000-0000-000000000024' as TeamMember.TeamMemberId;

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const TEST_ANCESTOR_GROUP_ID = '00000000-0000-0000-0000-000000000031' as GroupModel.GroupId;
const TEST_ANCESTOR_2_GROUP_ID = '00000000-0000-0000-0000-000000000032' as GroupModel.GroupId;
const TEST_OTHER_TEAM_GROUP_ID = '00000000-0000-0000-0000-000000000039' as GroupModel.GroupId;

const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

const ADMIN_PERMISSIONS: readonly Role.Permission[] = [
  'team:manage',
  'team:invite',
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'member:remove',
  'role:view',
  'role:manage',
  'group:manage',
  'activity-type:create',
  'activity-type:delete',
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testAdmin = {
  id: TEST_ADMIN_ID,
  discord_id: '67890',
  username: 'adminuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Admin User'),
  birth_date: Option.some(DateTime.makeUnsafe('1990-01-01')),
  gender: Option.some('male' as const),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testUserA = {
  id: TEST_USER_ID,
  discord_id: 'discord-user-a',
  username: 'user-a',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('User A'),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testUserB = {
  id: TEST_USER_B_ID,
  discord_id: 'discord-user-b',
  username: 'user-b',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('User B'),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testUserC = {
  id: TEST_USER_C_ID,
  discord_id: 'discord-user-c',
  username: 'user-c',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('User C'),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_ADMIN_ID);
sessionsStore.set('player-token', TEST_USER_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: ['roster:view', 'member:view'],
});

// ---------------------------------------------------------------------------
// Recorded sync calls
// ---------------------------------------------------------------------------

type RecordedMemberSyncCall = {
  eventType: 'member_added' | 'member_removed';
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  teamMemberId: TeamMember.TeamMemberId;
  discordUserId: string;
};

let syncCalls: RecordedMemberSyncCall[] = [];

const makeRecordingChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: (..._args: readonly unknown[]) => Effect.void,
    emitChannelDeleted: (..._args: readonly unknown[]) => Effect.void,
    emitChannelArchived: (..._args: readonly unknown[]) => Effect.void,
    emitChannelDetached: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelCreated: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelDeleted: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelArchived: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelDetached: (..._args: readonly unknown[]) => Effect.void,
    emitGroupChannelUpdated: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelUpdated: (..._args: readonly unknown[]) => Effect.void,
    emitMemberAdded: (..._args: readonly unknown[]) => Effect.void,
    emitMembersAddedBatch: (input: {
      teamId: Team.TeamId;
      entries: ReadonlyArray<{
        groupId: GroupModel.GroupId;
        groupName: string;
        teamMemberId: TeamMember.TeamMemberId;
        discordUserId: string;
      }>;
    }) => {
      for (const e of input.entries) {
        syncCalls.push({
          eventType: 'member_added',
          teamId: input.teamId,
          groupId: e.groupId,
          groupName: e.groupName,
          teamMemberId: e.teamMemberId,
          discordUserId: e.discordUserId,
        });
      }
      return Effect.void;
    },
    emitMembersRemovedBatch: (input: {
      teamId: Team.TeamId;
      entries: ReadonlyArray<{
        groupId: GroupModel.GroupId;
        groupName: string;
        teamMemberId: TeamMember.TeamMemberId;
        discordUserId: string;
      }>;
    }) => {
      for (const e of input.entries) {
        syncCalls.push({
          eventType: 'member_removed',
          teamId: input.teamId,
          groupId: e.groupId,
          groupName: e.groupName,
          teamMemberId: e.teamMemberId,
          discordUserId: e.discordUserId,
        });
      }
      return Effect.void;
    },
    emitMemberRemoved: (..._args: readonly unknown[]) => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

// ---------------------------------------------------------------------------
// Configurable group members store (per-test)
// ---------------------------------------------------------------------------

type GroupMemberEntry = { teamMemberId: TeamMember.TeamMemberId; discordUserId: string | null };
type RosterMemberEntry = {
  teamMemberId: TeamMember.TeamMemberId;
  userId: Auth.UserId;
  discordId: string | null;
};

let groupMembersWithDiscord: GroupMemberEntry[] = [];
let rosterByTeam: RosterMemberEntry[] = [];
let groupAncestors: GroupModel.GroupId[] = [];

const makeGroupsRepositoryLayer = () =>
  Layer.succeed(GroupsRepository, {
    _tag: 'api/GroupsRepository',
    findGroupsByTeamId: () => Effect.succeed([]),
    findGroupById: (id: GroupModel.GroupId) => {
      if (id === TEST_GROUP_ID) {
        return Effect.succeed(
          Option.some({
            id: TEST_GROUP_ID,
            team_id: TEST_TEAM_ID,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Test Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          }),
        );
      }
      if (id === TEST_ANCESTOR_GROUP_ID) {
        return Effect.succeed(
          Option.some({
            id: TEST_ANCESTOR_GROUP_ID,
            team_id: TEST_TEAM_ID,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Ancestor Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          }),
        );
      }
      if (id === TEST_ANCESTOR_2_GROUP_ID) {
        return Effect.succeed(
          Option.some({
            id: TEST_ANCESTOR_2_GROUP_ID,
            team_id: TEST_TEAM_ID,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Ancestor 2 Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          }),
        );
      }
      if (id === TEST_OTHER_TEAM_GROUP_ID) {
        return Effect.succeed(
          Option.some({
            id: TEST_OTHER_TEAM_GROUP_ID,
            team_id: '00000000-0000-0000-0000-000000000099' as Team.TeamId,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Other Team Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          }),
        );
      }
      return Effect.succeed(Option.none());
    },
    insertGroup: () => Effect.die(new Error('Not implemented')),
    updateGroupById: () => Effect.die(new Error('Not implemented')),
    archiveGroupById: () => Effect.void,
    moveGroup: () => Effect.die(new Error('Not implemented')),
    findMembersByGroupId: () => Effect.succeed([]),
    findMembersWithDiscordIdByGroupId: (_groupId: GroupModel.GroupId) =>
      Effect.succeed(groupMembersWithDiscord),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
    getRolesForGroup: () => Effect.succeed([]),
    getMemberCount: () => Effect.succeed(0),
    getChildren: () => Effect.succeed([]),
    getAncestorIds: () => Effect.succeed(groupAncestors),
    getAncestors: () => {
      const ancestorRows = groupAncestors.map((ancestorId) => {
        if (ancestorId === TEST_ANCESTOR_GROUP_ID) {
          return {
            id: TEST_ANCESTOR_GROUP_ID,
            team_id: TEST_TEAM_ID,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Ancestor Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          };
        }
        if (ancestorId === TEST_ANCESTOR_2_GROUP_ID) {
          return {
            id: TEST_ANCESTOR_2_GROUP_ID,
            team_id: TEST_TEAM_ID,
            parent_id: Option.none<GroupModel.GroupId>(),
            name: 'Ancestor 2 Group',
            emoji: Option.none<string>(),
            color: Option.none<string>(),
          };
        }
        return {
          id: ancestorId,
          team_id: TEST_TEAM_ID,
          parent_id: Option.none<GroupModel.GroupId>(),
          name: 'Unknown Ancestor',
          emoji: Option.none<string>(),
          color: Option.none<string>(),
        };
      });
      return Effect.succeed(ancestorRows);
    },
    getDescendantMemberIds: () => Effect.succeed([]),
  } as any);

const makeTeamMembersRepositoryLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    _tag: 'api/TeamMembersRepository',
    addMember: () => Effect.die(new Error('Not implemented')),
    findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
      const member = Array.from(membersStore.values()).find(
        (m) => m.team_id === teamId && m.user_id === userId,
      );
      return Effect.succeed(member ? Option.some(member) : Option.none());
    },
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: (_teamId: Team.TeamId) =>
      Effect.succeed(
        rosterByTeam
          .map((r) => {
            const user = r.discordId
              ? { discord_id: r.discordId, username: 'user', name: Option.none<string>() }
              : null;
            if (!user) return null;
            return new RosterEntry({
              member_id: r.teamMemberId,
              user_id: r.userId,
              discord_id: user.discord_id as Discord.Snowflake,
              role_names: [],
              permissions: [],
              name: Option.none(),
              birth_date: Option.none(),
              gender: Option.none(),
              jersey_number: Option.none(),
              username: user.username,
              avatar: Option.none(),
            });
          })
          .filter(Boolean) as RosterEntry[],
      ),
    findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
      const member = membersStore.get(memberId);
      if (!member || member.team_id !== teamId || !member.active) {
        return Effect.succeed(Option.none());
      }
      return Effect.succeed(
        Option.some(
          new RosterEntry({
            member_id: member.id,
            user_id: member.user_id,
            discord_id: '67890' as Discord.Snowflake,
            role_names: member.role_names,
            permissions: member.permissions,
            name: Option.none(),
            birth_date: Option.none(),
            gender: Option.none(),
            jersey_number: Option.none(),
            username: 'user',
            avatar: Option.none(),
          }),
        ),
      );
    },
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_PLAYER_ROLE_ID })),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Static mocks
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) => {
    const users = [testAdmin, testUserA, testUserB, testUserC];
    const user = users.find((u) => u.id === id);
    return Effect.succeed(user ? Option.some(user) : Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testAdmin),
  completeProfile: () => Effect.succeed(testAdmin),
  updateLocale: () => Effect.succeed(testAdmin),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: (id: Team.TeamId) => {
    if (id === TEST_TEAM_ID) return Effect.succeed(Option.some(testTeam));
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.succeed(testTeam),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockRolesRepositoryLayer = Layer.succeed(RolesRepository, {
  _tag: 'api/RolesRepository',
  findRolesByTeamId: () => Effect.succeed([]),
  findRoleById: () => Effect.succeed(Option.none()),
  getPermissionsForRoleId: () => Effect.succeed([]),
  insertRole: () => Effect.die(new Error('Not implemented')),
  updateRole: () => Effect.die(new Error('Not implemented')),
  archiveRoleById: () => Effect.void,
  setRolePermissions: () => Effect.void,
  initializeTeamRoles: () => Effect.void,
  findRoleByTeamAndName: () => Effect.succeed(Option.none()),
  seedTeamRolesWithPermissions: () => Effect.succeed([]),
  getMemberCountForRole: () => Effect.succeed(0),
  findGroupsForRole: () => Effect.succeed([]),
  assignRoleToGroup: () => Effect.void,
  unassignRoleFromGroup: () => Effect.void,
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as any);

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: '12345', username: 'testuser', avatar: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  _tag: 'api/TrainingTypesRepository',
  findByTeamId: () => Effect.succeed([]),
  findTrainingTypesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findTrainingTypeById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  insertTrainingType: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateTrainingType: () => Effect.die(new Error('Not implemented')),
  deleteTrainingType: () => Effect.void,
  deleteTrainingTypeById: () => Effect.void,
  findCoaches: () => Effect.succeed([]),
  findCoachesByTrainingTypeId: () => Effect.succeed([]),
  addCoach: () => Effect.void,
  addCoachById: () => Effect.void,
  removeCoach: () => Effect.void,
  removeCoachById: () => Effect.void,
  countCoachesForTrainingType: () => Effect.succeed({ count: 0 }),
  getCoachCount: () => Effect.succeed(0),
} as any);

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  updateRule: () => Effect.die(new Error('Not implemented')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('Not implemented')),
  updateRuleById: () => Effect.die(new Error('Not implemented')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => Effect.die(new Error('Not implemented')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.void,
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
  evaluateTeam: () => Effect.succeed([]),
  evaluate: () => Effect.succeed([]),
} as any);

const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  emitRoleAssigned: () => Effect.void,
  emitRoleUnassigned: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: () => Effect.succeed(Option.none()),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
  insertSeries: () => Effect.die(new Error('Not implemented')),
  insertEventSeries: () => Effect.die(new Error('Not implemented')),
  findByTeamId: () => Effect.succeed([]),
  findSeriesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findSeriesById: () => Effect.succeed(Option.none()),
  updateSeries: () => Effect.die(new Error('Not implemented')),
  updateEventSeries: () => Effect.die(new Error('Not implemented')),
  cancelSeries: () => Effect.void,
  cancelEventSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: () => Effect.die(new Error('Not implemented')),
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
} as any);

const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(false),
  findAll: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
} as any);

const MockDiscordRolesRepositoryLayer = Layer.succeed(
  DiscordRolesRepository,
  new Proxy({} as any, { get: () => () => Effect.void }),
);

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  _tag: 'api/OAuthConnectionsRepository',
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
} as any);

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  _tag: 'api/ICalTokensRepository',
  findByToken: () => Effect.succeed(Option.none()),
  findByUserId: () => Effect.succeed(Option.none()),
  create: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token',
      created_at: new Date(),
    }),
  regenerate: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token-new',
      created_at: new Date(),
    }),
} as any);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  findByRosterId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertRoleOnly: () => Effect.void,
  upsertGroupChannel: () => Effect.void,
  clearGroupChannel: () => Effect.void,
  insertRoster: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  deleteByRosterId: () => Effect.void,
  findAllByTeam: () => Effect.succeed([]),
} as any);

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  insert: () => Effect.die(new Error('not implemented')),
  findByTeamMember: () => Effect.succeed([]),
} as any);

const MockLeaderboardRepositoryLayer = Layer.succeed(LeaderboardRepository, {
  getLeaderboard: () => Effect.succeed([]),
} as any);

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  findBySlug: () =>
    Effect.succeed(
      Option.some({ id: 'mock-training-type-id', name: 'Training', slug: Option.some('training') }),
    ),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
} as any);

const defaultSettingsLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

// ---------------------------------------------------------------------------
// Mock SqlClient (passthrough withTransaction, no real DB)
// ---------------------------------------------------------------------------

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([]);
    },
    {
      safe: undefined as any,
      withoutTransforms: function (this: any) {
        return this;
      },
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> =>
        effect,
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
      unsafe: () => Effect.succeed([]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => ({ _tag: 'Fragment' as const, segments: [] }),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => ({ _tag: 'Fragment' as const, segments: [] }),
      or: (..._args: unknown[]) => ({ _tag: 'Fragment' as const, segments: [] }),
      csv: (..._args: unknown[]) => ({ _tag: 'Fragment' as const, segments: [] }),
      join:
        (..._args: unknown[]) =>
        () => ({ _tag: 'Fragment' as const, segments: [] }),
      onDialect: (..._args: unknown[]) => undefined as never,
      onDialectOrElse: (..._args: unknown[]) => undefined as never,
    },
  ) as unknown as SqlClient.SqlClient,
);

const MockAchievementAdminLayers = Layer.mergeAll(
  Layer.succeed(AchievementRoleMappingsRepository, {
    findAllByTeam: () => Effect.succeed([]),
    upsert: () => Effect.void,
    delete: () => Effect.void,
  } as any),
  Layer.succeed(AchievementSettingsRepository, {
    findOverridesByTeam: () => Effect.succeed(new Map()),
    upsertOverride: () => Effect.void,
    deleteOverride: () => Effect.void,
  } as any),
  Layer.succeed(CustomAchievementsRepository, {
    findByTeam: () => Effect.succeed([]),
    findById: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.void,
    setRoleMapping: () => Effect.void,
  } as any),
  Layer.succeed(DiscordRoleProvisionEventsRepository, {
    enqueue: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any),
  Layer.succeed(AchievementPreview, {
    preview: () =>
      Effect.succeed({ qualifyingCount: 0, removedMembers: [], botCanManageRoles: true }),
  } as any),
);

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

const buildTestLayer = () => {
  const channelSyncLayer = makeRecordingChannelSyncLayer();
  const groupsRepositoryLayer = makeGroupsRepositoryLayer();
  const teamMembersRepositoryLayer = makeTeamMembersRepositoryLayer();

  return ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(MockDiscordOAuthLayer),
    Layer.provide(MockUsersRepositoryLayer),
    Layer.provide(MockSessionsRepositoryLayer),
    Layer.provide(MockTeamsRepositoryLayer),
    Layer.provide(teamMembersRepositoryLayer),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
          MockActivityTypesRepositoryLayer,
        ),
        MockLeaderboardRepositoryLayer,
      ),
    ),
    Layer.provide(
      Layer.merge(
        MockTeamInvitesRepositoryLayer,
        Layer.merge(
          Layer.succeed(PendingGuildJoinsRepository, {
            _tag: 'api/PendingGuildJoinsRepository',
            enqueue: () => Effect.void,
            listPending: () => Effect.succeed([]),
            markDone: () => Effect.void,
            markFailed: () => Effect.void,
          } as never),
          Layer.succeed(InviteAcceptancesRepository, {
            _tag: 'api/InviteAcceptancesRepository',
          } as never),
        ),
      ),
    ),
    Layer.provide(MockRolesRepositoryLayer),
    Layer.provide(groupsRepositoryLayer),
    Layer.provide(MockTrainingTypesRepositoryLayer),
    Layer.provide(MockHttpClientLayer),
    Layer.provide(MockAgeCheckServiceLayer),
    Layer.provide(MockAgeThresholdRepositoryLayer),
    Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
    Layer.provide(Layer.merge(channelSyncLayer, MockEventSyncEventsRepositoryLayer)),
    Layer.provide(
      Layer.merge(MockDiscordChannelMappingRepositoryLayer, MockICalTokensRepositoryLayer),
    ),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.merge(
                Layer.merge(MockEventsRepositoryLayer, MockEventRsvpsRepositoryLayer),
                MockBotGuildsRepositoryLayer,
              ),
              Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
            ),
            MockEventSeriesRepositoryLayer,
          ),
          Layer.merge(defaultSettingsLayer, MockSqlClientLayer),
        ),
        MockOAuthConnectionsRepositoryLayer,
      ),
    ),
    Layer.provide(MockAchievementAdminLayers),
  )
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(BotInfoStore.Default));
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const disposeHandlers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const dispose of disposeHandlers) {
    await dispose();
  }
});

beforeEach(() => {
  syncCalls = [];
  groupMembersWithDiscord = [];
  rosterByTeam = [];
  groupAncestors = [];
});

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const callSyncRoleMembers = async (
  handler: (...args: any) => Promise<Response>,
  teamId: Team.TeamId = TEST_TEAM_ID,
  groupId: GroupModel.GroupId = TEST_GROUP_ID,
  token = 'admin-token',
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/groups/${groupId}/sync-role-members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Group/SyncRoleMembers', () => {
  describe('adds missing role-holders', () => {
    it('emits member_added for each linked group member and cascades to ancestor', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupAncestors = [TEST_ANCESTOR_GROUP_ID];
      groupMembersWithDiscord = [
        { teamMemberId: TEST_MEMBER_ID, discordUserId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, discordUserId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_C_ID, discordUserId: 'discord-user-c' },
      ];
      rosterByTeam = [
        { teamMemberId: TEST_MEMBER_ID, userId: TEST_USER_ID, discordId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, userId: TEST_USER_B_ID, discordId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_C_ID, userId: TEST_USER_C_ID, discordId: 'discord-user-c' },
      ];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(3);
      expect(body.removedCount).toBe(0);
      expect(body.skippedCount).toBe(0);

      const addedCalls = syncCalls.filter((c) => c.eventType === 'member_added');
      expect(addedCalls).toHaveLength(6);

      const leafAdds = addedCalls.filter((c) => c.groupId === TEST_GROUP_ID);
      const ancestorAdds = addedCalls.filter((c) => c.groupId === TEST_ANCESTOR_GROUP_ID);
      expect(leafAdds).toHaveLength(3);
      expect(ancestorAdds).toHaveLength(3);
    });
  });

  describe('skips members without a Discord link', () => {
    it('counts unlinked members in skippedCount and does not emit events for them', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupMembersWithDiscord = [
        { teamMemberId: TEST_MEMBER_ID, discordUserId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, discordUserId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_NO_DISCORD_ID, discordUserId: null },
      ];
      rosterByTeam = [
        { teamMemberId: TEST_MEMBER_ID, userId: TEST_USER_ID, discordId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, userId: TEST_USER_B_ID, discordId: 'discord-user-b' },
      ];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(2);
      expect(body.skippedCount).toBe(1);
      expect(body.removedCount).toBe(0);

      const addedCalls = syncCalls.filter((c) => c.eventType === 'member_added');
      expect(addedCalls).toHaveLength(2);
      expect(addedCalls.every((c) => c.groupId === TEST_GROUP_ID)).toBe(true);
    });
  });

  describe('removes extras when team-member is no longer in the group', () => {
    it('emits member_added for group members and member_removed only at leaf for non-members', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupAncestors = [TEST_ANCESTOR_GROUP_ID];
      groupMembersWithDiscord = [
        { teamMemberId: TEST_MEMBER_ID, discordUserId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, discordUserId: 'discord-user-b' },
      ];
      rosterByTeam = [
        { teamMemberId: TEST_MEMBER_ID, userId: TEST_USER_ID, discordId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, userId: TEST_USER_B_ID, discordId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_C_ID, userId: TEST_USER_C_ID, discordId: 'discord-user-c' },
      ];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(2);
      expect(body.removedCount).toBe(1);
      expect(body.skippedCount).toBe(0);

      const addedCalls = syncCalls.filter((c) => c.eventType === 'member_added');
      const removedCalls = syncCalls.filter((c) => c.eventType === 'member_removed');

      expect(addedCalls).toHaveLength(4);
      const leafAdds = addedCalls.filter((c) => c.groupId === TEST_GROUP_ID);
      const ancestorAdds = addedCalls.filter((c) => c.groupId === TEST_ANCESTOR_GROUP_ID);
      expect(leafAdds).toHaveLength(2);
      expect(ancestorAdds).toHaveLength(2);

      expect(removedCalls).toHaveLength(1);
      expect(removedCalls[0]?.groupId).toBe(TEST_GROUP_ID);
      expect(removedCalls[0]?.teamMemberId).toBe(TEST_MEMBER_C_ID);
      expect(removedCalls[0]?.groupName).toBe('Test Group');
    });
  });

  describe('no-op for empty group and no outside team members', () => {
    it('emits no events and returns all-zero counts', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupMembersWithDiscord = [];
      rosterByTeam = [];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(0);
      expect(body.removedCount).toBe(0);
      expect(body.skippedCount).toBe(0);
      expect(syncCalls).toHaveLength(0);
    });
  });

  describe('403 when caller lacks group:manage', () => {
    it('returns 403 Forbidden for a non-captain user', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      const response = await callSyncRoleMembers(
        app.handler,
        TEST_TEAM_ID,
        TEST_GROUP_ID,
        'player-token',
      );
      expect(response.status).toBe(403);
    });
  });

  describe('404 when group belongs to different team', () => {
    it('returns 404 GroupNotFound when groupId team_id does not match path teamId', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      const response = await callSyncRoleMembers(
        app.handler,
        TEST_TEAM_ID,
        TEST_OTHER_TEAM_GROUP_ID,
      );
      expect(response.status).toBe(404);
    });
  });

  describe('ancestor cascade for adds, not for removes', () => {
    it('emits add events at leaf + 2 ancestors but remove events only at leaf', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupAncestors = [TEST_ANCESTOR_GROUP_ID, TEST_ANCESTOR_2_GROUP_ID];
      groupMembersWithDiscord = [{ teamMemberId: TEST_MEMBER_ID, discordUserId: 'discord-user-a' }];
      rosterByTeam = [
        { teamMemberId: TEST_MEMBER_ID, userId: TEST_USER_ID, discordId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, userId: TEST_USER_B_ID, discordId: 'discord-user-b' },
      ];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(1);
      expect(body.removedCount).toBe(1);

      const addedCalls = syncCalls.filter((c) => c.eventType === 'member_added');
      const removedCalls = syncCalls.filter((c) => c.eventType === 'member_removed');

      expect(addedCalls).toHaveLength(3);
      const addedGroupIds = new Set(addedCalls.map((c) => c.groupId));
      expect(addedGroupIds).toEqual(
        new Set([TEST_GROUP_ID, TEST_ANCESTOR_GROUP_ID, TEST_ANCESTOR_2_GROUP_ID]),
      );

      expect(removedCalls).toHaveLength(1);
      expect(removedCalls[0]?.groupId).toBe(TEST_GROUP_ID);
      expect(removedCalls[0]?.groupName).toBe('Test Group');
    });
  });

  describe('batched INSERT records all events', () => {
    it('all emitted events are captured by the recording mock', async () => {
      const app = HttpRouter.toWebHandler(buildTestLayer());
      disposeHandlers.push(app.dispose);

      groupAncestors = [TEST_ANCESTOR_GROUP_ID];
      groupMembersWithDiscord = [
        { teamMemberId: TEST_MEMBER_ID, discordUserId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, discordUserId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_C_ID, discordUserId: 'discord-user-c' },
      ];
      rosterByTeam = [
        { teamMemberId: TEST_MEMBER_ID, userId: TEST_USER_ID, discordId: 'discord-user-a' },
        { teamMemberId: TEST_MEMBER_B_ID, userId: TEST_USER_B_ID, discordId: 'discord-user-b' },
        { teamMemberId: TEST_MEMBER_C_ID, userId: TEST_USER_C_ID, discordId: 'discord-user-c' },
      ];

      const response = await callSyncRoleMembers(app.handler);
      expect(response.status).toBe(200);
      const body = await response.json();

      expect(body.addedCount).toBe(3);

      const addedCalls = syncCalls.filter((c) => c.eventType === 'member_added');
      expect(addedCalls).toHaveLength(6);

      const memberIds = addedCalls.map((c) => c.teamMemberId);
      expect(memberIds.filter((id) => id === TEST_MEMBER_ID)).toHaveLength(2);
      expect(memberIds.filter((id) => id === TEST_MEMBER_B_ID)).toHaveLength(2);
      expect(memberIds.filter((id) => id === TEST_MEMBER_C_ID)).toHaveLength(2);
    });
  });
});
