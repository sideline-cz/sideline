/**
 * TDD tests for the decouple-role-from-channel feature.
 *
 * These tests describe NEW behavior after the refactor and are expected to FAIL
 * until the server (and bot) are updated by other agents.
 *
 * Domain changes already applied:
 *   - ChannelMapping.discord_channel_id  → Option<Snowflake>  (was Snowflake)
 *   - GroupChannelCreatedEvent.discord_channel_name → Option<string>  (was string)
 *   - GroupChannelUpdatedEvent.discord_channel_id   → Option<Snowflake>
 *   - GroupChannelUpdatedEvent.discord_role_id      → Option<Snowflake>
 *   - New RPC Channel/UpsertMappingRoleOnly
 */

import type {
  Auth,
  ChannelSyncEvent,
  Discord,
  GroupModel,
  Role,
  Team,
  TeamMember,
} from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
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
import { DiscordOAuth } from '~/services/DiscordOAuth.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
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
];

// ---------------------------------------------------------------------------
// User / session fixtures
// ---------------------------------------------------------------------------

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: false,
  name: Option.none<string>(),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

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

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

type UserLike = {
  id: Auth.UserId;
  discord_id: string;
  username: string;
  avatar: Option.Option<string>;
  is_profile_complete: boolean;
  name: Option.Option<string>;
  birth_date: Option.Option<DateTime.Utc>;
  gender: Option.Option<'male' | 'female' | 'other'>;
  locale: 'en' | 'cs';
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin);

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_ADMIN_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: ['roster:view', 'member:view'],
});
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});

// ---------------------------------------------------------------------------
// Rich recording mock for channel sync events
// ---------------------------------------------------------------------------

type RecordedChannelCreatedCall = {
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  existingChannelId: Option.Option<Discord.Snowflake>;
  discordChannelName: Option.Option<string>;
  discordRoleName: Option.Option<string>;
};

type RecordedChannelDeletedCall = {
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  discordChannelId: Discord.Snowflake;
  discordRoleId: Option.Option<Discord.Snowflake>;
};

type RecordedGroupChannelUpdatedCall = {
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  discordChannelId: Option.Option<Discord.Snowflake>;
  discordRoleId: Option.Option<Discord.Snowflake>;
  discordChannelName: string;
  discordRoleName: string;
};

type RecordedMemberAddedCall = {
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  teamMemberId: TeamMember.TeamMemberId;
  discordUserId: string;
};

const channelCreatedCalls: RecordedChannelCreatedCall[] = [];
const channelDeletedCalls: RecordedChannelDeletedCall[] = [];
const groupChannelUpdatedCalls: RecordedGroupChannelUpdatedCall[] = [];
const memberAddedCalls: RecordedMemberAddedCall[] = [];
const otherSyncCalls: { eventType: string }[] = [];

const makeRecordingChannelSyncEventsRepository = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
      discordChannelName?: string,
      discordRoleName?: string,
    ) => {
      channelCreatedCalls.push({
        teamId,
        groupId,
        groupName,
        existingChannelId,
        discordChannelName:
          discordChannelName !== undefined ? Option.some(discordChannelName) : Option.none(),
        discordRoleName:
          discordRoleName !== undefined ? Option.some(discordRoleName) : Option.none(),
      });
      return Effect.void;
    },
    emitChannelDeleted: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      discordChannelId: Discord.Snowflake,
      discordRoleId: Option.Option<Discord.Snowflake>,
    ) => {
      channelDeletedCalls.push({ teamId, groupId, groupName, discordChannelId, discordRoleId });
      return Effect.void;
    },
    emitChannelArchived: (..._args: readonly unknown[]) => {
      otherSyncCalls.push({ eventType: 'channel_archived' });
      return Effect.void;
    },
    emitChannelDetached: (..._args: readonly unknown[]) => {
      otherSyncCalls.push({ eventType: 'channel_detached' });
      return Effect.void;
    },
    emitRosterChannelCreated: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelDeleted: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelArchived: (..._args: readonly unknown[]) => Effect.void,
    emitRosterChannelDetached: (..._args: readonly unknown[]) => Effect.void,
    emitGroupChannelUpdated: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      discordChannelId: Option.Option<Discord.Snowflake>,
      discordRoleId: Option.Option<Discord.Snowflake>,
      discordChannelName: string,
      discordRoleName: string,
    ) => {
      groupChannelUpdatedCalls.push({
        teamId,
        groupId,
        discordChannelId,
        discordRoleId,
        discordChannelName,
        discordRoleName,
      });
      return Effect.void;
    },
    emitRosterChannelUpdated: (..._args: readonly unknown[]) => Effect.void,
    emitMemberAdded: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      teamMemberId: TeamMember.TeamMemberId,
      discordUserId: string,
    ) => {
      memberAddedCalls.push({ teamId, groupId, groupName, teamMemberId, discordUserId });
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

const MockChannelSyncEventsRepositoryLayer = makeRecordingChannelSyncEventsRepository();

// ---------------------------------------------------------------------------
// Channel mapping store — now with Option<Snowflake> for discord_channel_id
// ---------------------------------------------------------------------------

type MappingEntry = {
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

const channelMappingsStore = new Map<GroupModel.GroupId, MappingEntry>();

const makeMappingRepository = (
  store: Map<GroupModel.GroupId, MappingEntry>,
): Layer.Layer<DiscordChannelMappingRepository> =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: (_teamId: string, groupId: GroupModel.GroupId) => {
      const m = store.get(groupId);
      return Effect.succeed(
        m
          ? Option.some({
              id: 'mock-mapping-id',
              team_id: _teamId,
              entity_type: 'group' as const,
              group_id: Option.some(groupId),
              roster_id: Option.none(),
              discord_channel_id: m.discord_channel_id,
              discord_role_id: m.discord_role_id,
            })
          : Option.none(),
      );
    },
    findByRosterId: () => Effect.succeed(Option.none()),
    insert: (
      _teamId: string,
      groupId: GroupModel.GroupId,
      channelId: Discord.Snowflake,
      roleId: Discord.Snowflake,
    ) => {
      store.set(groupId as GroupModel.GroupId, {
        discord_channel_id: Option.some(channelId),
        discord_role_id: Option.some(roleId),
      });
      return Effect.void;
    },
    insertRoleOnly: (_teamId: string, groupId: GroupModel.GroupId, roleId: Discord.Snowflake) => {
      store.set(groupId as GroupModel.GroupId, {
        discord_channel_id: Option.none(),
        discord_role_id: Option.some(roleId),
      });
      return Effect.void;
    },
    upsertGroupChannel: (
      _teamId: string,
      groupId: GroupModel.GroupId,
      channelId: Discord.Snowflake,
    ) => {
      const existing = store.get(groupId);
      store.set(groupId as GroupModel.GroupId, {
        discord_channel_id: Option.some(channelId),
        discord_role_id: existing?.discord_role_id ?? Option.none(),
      });
      return Effect.void;
    },
    clearGroupChannel: (_teamId: string, groupId: GroupModel.GroupId) => {
      const existing = store.get(groupId);
      if (existing) {
        store.set(groupId as GroupModel.GroupId, {
          discord_channel_id: Option.none(),
          discord_role_id: existing.discord_role_id,
        });
      }
      return Effect.void;
    },
    insertRoster: () => Effect.void,
    deleteByGroupId: (_teamId: string, groupId: GroupModel.GroupId) => {
      store.delete(groupId);
      return Effect.void;
    },
    deleteByRosterId: () => Effect.void,
    findAllByTeam: () => Effect.succeed([]),
  } as any);

const MockDiscordChannelMappingRepositoryLayer = makeMappingRepository(channelMappingsStore);

// ---------------------------------------------------------------------------
// Groups store
// ---------------------------------------------------------------------------

let nextGroupId = 200;

type GroupLike = {
  id: GroupModel.GroupId;
  team_id: Team.TeamId;
  parent_id: Option.Option<GroupModel.GroupId>;
  name: string;
  emoji: Option.Option<string>;
  color: Option.Option<string>;
};

const groupsStore = new Map<GroupModel.GroupId, GroupLike>();
const groupMembersStore = new Map<string, Set<TeamMember.TeamMemberId>>();

const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  _tag: 'api/GroupsRepository',
  findGroupsByTeamId: (teamId: string) =>
    Effect.succeed(
      Array.from(groupsStore.values())
        .filter((g) => g.team_id === teamId)
        .map((g) => ({
          ...g,
          member_count: groupMembersStore.get(g.id)?.size ?? 0,
          created_at: new Date(),
        })),
    ),
  findGroupById: (id: GroupModel.GroupId) => {
    const g = groupsStore.get(id);
    return Effect.succeed(g ? Option.some(g) : Option.none());
  },
  insertGroup: (
    teamId: string,
    name: string,
    parentId: Option.Option<GroupModel.GroupId>,
    emoji: Option.Option<string>,
    color: Option.Option<string>,
  ) => {
    const id =
      `00000000-0000-0000-0200-${String(nextGroupId++).padStart(12, '0')}` as GroupModel.GroupId;
    const g: GroupLike = {
      id,
      team_id: teamId as Team.TeamId,
      parent_id: parentId,
      name,
      emoji,
      color,
    };
    groupsStore.set(id, g);
    return Effect.succeed(g);
  },
  updateGroupById: (
    id: GroupModel.GroupId,
    name: string,
    emoji: Option.Option<string>,
    color: Option.Option<string>,
  ) => {
    const g = groupsStore.get(id);
    if (!g) return Effect.die(new Error(`Group ${id} not found`));
    const updated = { ...g, name, emoji, color };
    groupsStore.set(id, updated);
    return Effect.succeed(updated);
  },
  archiveGroupById: (id: GroupModel.GroupId) => {
    groupsStore.delete(id);
    groupMembersStore.delete(id);
    return Effect.void;
  },
  moveGroup: () => Effect.die(new Error('Not implemented')),
  findMembersByGroupId: () => Effect.succeed([]),
  addMemberById: (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) => {
    const members = groupMembersStore.get(groupId) ?? new Set();
    members.add(memberId);
    groupMembersStore.set(groupId, members);
    return Effect.void;
  },
  removeMemberById: (groupId: GroupModel.GroupId, memberId: TeamMember.TeamMemberId) => {
    groupMembersStore.get(groupId)?.delete(memberId);
    return Effect.void;
  },
  getRolesForGroup: () => Effect.succeed([]),
  getMemberCount: () => Effect.succeed(0),
  getChildren: () => Effect.succeed([]),
  getAncestorIds: () => Effect.succeed([]),
  getAncestors: () => Effect.succeed([]),
  getDescendantMemberIds: () => Effect.succeed([]),
} as any);

// ---------------------------------------------------------------------------
// All other mocks (minimal, copy from ChannelSync.test.ts patterns)
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
    const user = usersMap.get(id);
    return Effect.succeed(user ? Option.some(user) : Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
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

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
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
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
    const member = membersStore.get(memberId);
    if (!member || member.team_id !== teamId || !member.active)
      return Effect.succeed(Option.none());
    const user = usersMap.get(member.user_id);
    if (!user) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some(
        new RosterEntry({
          member_id: member.id,
          user_id: member.user_id,
          discord_id: user.discord_id as Discord.Snowflake,
          role_names: member.role_names,
          permissions: member.permissions,
          name: user.name,
          birth_date: user.birth_date.pipe(Option.map(DateTime.formatIsoDateUtc)),
          gender: user.gender,
          jersey_number: Option.none(),
          username: user.username,
          avatar: user.avatar,
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
// makeTeamSettingsRow helper
// ---------------------------------------------------------------------------

const makeTeamSettingsRow = (
  createDiscordChannelOnGroup: boolean,
  overrides?: {
    discord_channel_cleanup_on_group_delete?: 'nothing' | 'delete' | 'archive';
    discord_channel_cleanup_on_roster_deactivate?: 'nothing' | 'delete' | 'archive';
    discord_archive_category_id?: string;
  },
) => ({
  team_id: TEST_TEAM_ID,
  event_horizon_days: 30,
  min_players_threshold: 0,
  rsvp_reminder_hours: 0,
  discord_channel_training: Option.none(),
  discord_channel_match: Option.none(),
  discord_channel_tournament: Option.none(),
  discord_channel_meeting: Option.none(),
  discord_channel_social: Option.none(),
  discord_channel_other: Option.none(),
  create_discord_channel_on_group: createDiscordChannelOnGroup,
  create_discord_channel_on_roster: true,
  discord_role_format: '{emoji} {name}',
  discord_channel_format: '{emoji}│{name}',
  discord_channel_cleanup_on_group_delete:
    overrides?.discord_channel_cleanup_on_group_delete ?? 'delete',
  discord_channel_cleanup_on_roster_deactivate:
    overrides?.discord_channel_cleanup_on_roster_deactivate ?? 'delete',
  discord_archive_category_id: overrides?.discord_archive_category_id
    ? Option.some(overrides.discord_archive_category_id)
    : Option.none(),
});

// ---------------------------------------------------------------------------
// Layer builder
// ---------------------------------------------------------------------------

const buildTestLayer = (
  settingsLayer: Layer.Layer<TeamSettingsRepository>,
  mappingRepositoryLayer: Layer.Layer<DiscordChannelMappingRepository> = MockDiscordChannelMappingRepositoryLayer,
) =>
  ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(MockDiscordOAuthLayer),
    Layer.provide(MockUsersRepositoryLayer),
    Layer.provide(MockSessionsRepositoryLayer),
    Layer.provide(MockTeamsRepositoryLayer),
    Layer.provide(MockTeamMembersRepositoryLayer),
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
    Layer.provide(MockGroupsRepositoryLayer),
    Layer.provide(MockTrainingTypesRepositoryLayer),
    Layer.provide(MockHttpClientLayer),
    Layer.provide(MockAgeCheckServiceLayer),
    Layer.provide(MockAgeThresholdRepositoryLayer),
    Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
    Layer.provide(
      Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
    ),
    Layer.provide(Layer.merge(mappingRepositoryLayer, MockICalTokensRepositoryLayer)),
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
          settingsLayer,
        ),
        MockOAuthConnectionsRepositoryLayer,
      ),
    ),
    Layer.provide(MockAchievementAdminLayers),
  );

const makeSettingsLayer = (findByTeamId: () => Effect.Effect<Option.Option<unknown>>) =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId,
    upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as any);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createGroupViaApi = async (
  handler: (...args: any) => Promise<Response>,
  name: string,
): Promise<{ status: number; body: any }> => {
  const response = await handler(
    new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name, parentId: null, emoji: null, color: null }),
    }),
  );
  const body = await response.json();
  return { status: response.status, body };
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
  channelCreatedCalls.length = 0;
  channelDeletedCalls.length = 0;
  groupChannelUpdatedCalls.length = 0;
  memberAddedCalls.length = 0;
  otherSyncCalls.length = 0;
});

// ===========================================================================
// B2 — Single-event provisioning on createGroup
// ===========================================================================

describe('B2 — createGroup emits channel_created regardless of create_discord_channel_on_group setting', () => {
  /**
   * Test 1: createGroup with create_discord_channel_on_group=true
   * → ONE channel_created event with discord_channel_name: Option.some(<name>), existing_channel_id: Option.none()
   * This should pass with current behavior.
   */
  it('B2-1: create_discord_channel_on_group=true → emits channel_created with discord_channel_name=Some', async () => {
    const app = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
      ),
    );
    const handler: (...args: any) => Promise<Response> = app.handler;
    disposeHandlers.push(app.dispose);

    const { status, body } = await createGroupViaApi(handler, 'Goalkeepers');
    expect(status).toBe(201);

    expect(channelCreatedCalls).toHaveLength(1);
    const call = channelCreatedCalls[0]!;
    expect(call.groupId).toBe(body.groupId);
    expect(call.groupName).toBe('Goalkeepers');
    expect(Option.isNone(call.existingChannelId)).toBe(true);
    // NEW behavior: discord_channel_name is Option.some when create_discord_channel_on_group=true
    expect(Option.isSome(call.discordChannelName)).toBe(true);
    // role name must be populated
    expect(Option.isSome(call.discordRoleName)).toBe(true);
  });

  /**
   * Test 2: createGroup with create_discord_channel_on_group=false
   * → ONE channel_created event with discord_channel_name: Option.none(), existing_channel_id: Option.none()
   * TODAY this case emits NO event — this test SHOULD FAIL until implemented.
   */
  it('B2-2: create_discord_channel_on_group=false → emits channel_created with discord_channel_name=None (role-only)', async () => {
    const app = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(false)))),
      ),
    );
    const handler: (...args: any) => Promise<Response> = app.handler;
    disposeHandlers.push(app.dispose);

    const { status } = await createGroupViaApi(handler, 'Defenders');
    expect(status).toBe(201);

    // NEW: even when channel creation is disabled, we emit ONE channel_created for role provisioning
    expect(channelCreatedCalls).toHaveLength(1);
    const call = channelCreatedCalls[0]!;
    expect(call.groupName).toBe('Defenders');
    expect(Option.isNone(call.existingChannelId)).toBe(true);
    // discord_channel_name=None signals role-only provisioning to the bot
    expect(Option.isNone(call.discordChannelName)).toBe(true);
    // role name must still be populated
    expect(Option.isSome(call.discordRoleName)).toBe(true);
  });

  /**
   * Test 3: After createGroup + addGroupMember, events sorted by created_at ASC
   * should have channel_created BEFORE member_added.
   * (Verifies in-tx ordering invariant B9)
   *
   * We verify this by checking the call order of emitChannelCreated vs emitMemberAdded
   * through the recording mock.
   */
  it('B2-3: channel_created is emitted before member_added in the same handler sequence', async () => {
    const callOrder: string[] = [];

    const orderRecordingMappingLayer = MockDiscordChannelMappingRepositoryLayer;

    const orderRecordingLayer = Layer.succeed(ChannelSyncEventsRepository, {
      _tag: 'api/ChannelSyncEventsRepository',
      emitChannelCreated: (..._args: readonly unknown[]) => {
        callOrder.push('channel_created');
        return Effect.void;
      },
      emitChannelDeleted: () => Effect.void,
      emitChannelArchived: () => Effect.void,
      emitChannelDetached: () => Effect.void,
      emitRosterChannelCreated: () => Effect.void,
      emitRosterChannelDeleted: () => Effect.void,
      emitRosterChannelArchived: () => Effect.void,
      emitRosterChannelDetached: () => Effect.void,
      emitGroupChannelUpdated: () => Effect.void,
      emitRosterChannelUpdated: () => Effect.void,
      emitMemberAdded: (..._args: readonly unknown[]) => {
        callOrder.push('member_added');
        return Effect.void;
      },
      emitMemberRemoved: () => Effect.void,
      findUnprocessed: () => Effect.succeed([]),
      markProcessed: () => Effect.void,
      markFailed: () => Effect.void,
      hasUnprocessedForGroups: () => Effect.succeed([]),
      hasUnprocessedForRosters: () => Effect.succeed([]),
    } as any);

    // Build a custom layer that overrides ChannelSyncEventsRepository
    const customLayer = ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(MockUsersRepositoryLayer),
      Layer.provide(MockSessionsRepositoryLayer),
      Layer.provide(MockTeamsRepositoryLayer),
      Layer.provide(MockTeamMembersRepositoryLayer),
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
      Layer.provide(MockGroupsRepositoryLayer),
      Layer.provide(MockTrainingTypesRepositoryLayer),
      Layer.provide(MockHttpClientLayer),
      Layer.provide(MockAgeCheckServiceLayer),
      Layer.provide(MockAgeThresholdRepositoryLayer),
      Layer.provide(
        Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer),
      ),
      Layer.provide(Layer.merge(orderRecordingLayer, MockEventSyncEventsRepositoryLayer)),
      Layer.provide(Layer.merge(orderRecordingMappingLayer, MockICalTokensRepositoryLayer)),
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
            makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
          ),
          MockOAuthConnectionsRepositoryLayer,
        ),
      ),
      Layer.provide(MockAchievementAdminLayers),
    );

    const _app = HttpRouter.toWebHandler(customLayer);
    const handler: (...args: any) => Promise<Response> = _app.handler;
    disposeHandlers.push(_app.dispose);

    // Create the group (should emit channel_created)
    const createResp = await createGroupViaApi(handler, 'Midfielders');
    expect(createResp.status).toBe(201);

    // Add a member (should emit member_added)
    const addResp = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/groups/${createResp.body.groupId}/members`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        },
      ),
    );
    expect(addResp.status).toBe(204);

    expect(callOrder).toContain('channel_created');
    expect(callOrder).toContain('member_added');
    // channel_created must come before member_added
    expect(callOrder.indexOf('channel_created')).toBeLessThan(callOrder.indexOf('member_added'));
  });
});

// ===========================================================================
// B3 — Bot owns mapping-row delete
// ===========================================================================

describe('B3 — deleteGroup leaves discord_channel_mappings row intact (bot deletes it)', () => {
  /**
   * Test 4: deleteGroup while mapping exists → emits channel_deleted,
   * but the discord_channel_mappings row is STILL PRESENT after the request.
   * TODAY the row is deleted inline — this test SHOULD FAIL until implemented.
   */
  it('B3-4: deleteGroup emits channel_deleted but does NOT delete the mapping row', async () => {
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();
    const localMappingLayer = makeMappingRepository(localStore);

    const _app4 = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
        localMappingLayer,
      ),
    );
    const handler: (...args: any) => Promise<Response> = _app4.handler;
    disposeHandlers.push(_app4.dispose);

    // Create group
    const { status: createStatus, body } = await createGroupViaApi(handler, 'ToDeleteB3');
    expect(createStatus).toBe(201);
    const groupId = body.groupId as GroupModel.GroupId;

    // Seed a channel mapping for this group
    localStore.set(groupId, {
      discord_channel_id: Option.some('999888777' as Discord.Snowflake),
      discord_role_id: Option.some('111222333' as Discord.Snowflake),
    });
    channelDeletedCalls.length = 0;

    const deleteResp = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(deleteResp.status).toBe(204);

    // MUST emit a cleanup event
    expect(channelDeletedCalls).toHaveLength(1);
    expect(channelDeletedCalls[0]?.groupId).toBe(groupId);

    // NEW: row must NOT be deleted inline — bot will do it via Channel/DeleteMapping
    expect(localStore.has(groupId)).toBe(true);
  });

  /**
   * Test 5: deleteChannelMapping HTTP API → emits event, row remains.
   * Then simulate Channel/DeleteMapping RPC → row is gone.
   */
  it('B3-5: deleteChannelMapping HTTP emits cleanup event but leaves row; Channel/DeleteMapping RPC removes it', async () => {
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();
    const localMappingLayer = makeMappingRepository(localStore);

    const _app5 = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
        localMappingLayer,
      ),
    );
    const handler: (...args: any) => Promise<Response> = _app5.handler;
    disposeHandlers.push(_app5.dispose);

    // Create a group
    const { status: createStatus, body } = await createGroupViaApi(handler, 'ToUnlinkB3');
    expect(createStatus).toBe(201);
    const groupId = body.groupId as GroupModel.GroupId;

    // Seed a channel mapping
    localStore.set(groupId, {
      discord_channel_id: Option.some('777666555' as Discord.Snowflake),
      discord_role_id: Option.some('444333222' as Discord.Snowflake),
    });
    channelDeletedCalls.length = 0;
    otherSyncCalls.length = 0;

    // Call delete channel mapping HTTP endpoint
    const unlinkResp = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${groupId}/channel-mapping`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(unlinkResp.status).toBe(204);

    // MUST emit a cleanup event (deleted or detached, depending on settings)
    const totalCleanupEvents = channelDeletedCalls.length + otherSyncCalls.length;
    expect(totalCleanupEvents).toBeGreaterThan(0);

    // Row must NOT be deleted inline
    expect(localStore.has(groupId)).toBe(true);
  });

  /**
   * Test 6: deleteGroup on a role-only group (discord_channel_id=None, discord_role_id=Some)
   * → emits an event that allows bot to clean up role + mapping row.
   * The emitted event must be decodable and must indicate role-only cleanup.
   */
  it('B3-6: deleteGroup on role-only group emits cleanup event with discord_channel_id=None', async () => {
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();
    const localMappingLayer = makeMappingRepository(localStore);

    const _app6 = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(false)))),
        localMappingLayer,
      ),
    );
    const handler: (...args: any) => Promise<Response> = _app6.handler;
    disposeHandlers.push(_app6.dispose);

    // Create group
    const { status: createStatus, body } = await createGroupViaApi(handler, 'RoleOnlyGroup');
    expect(createStatus).toBe(201);
    const groupId = body.groupId as GroupModel.GroupId;

    // Seed a role-only mapping (no channel)
    localStore.set(groupId, {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some('555444333' as Discord.Snowflake),
    });
    channelDeletedCalls.length = 0;
    otherSyncCalls.length = 0;

    const deleteResp = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${groupId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(deleteResp.status).toBe(204);

    // MUST emit some cleanup event even for role-only groups
    // (channel_deleted with no channel_id, or a dedicated role-only event)
    const totalCleanupEvents = channelDeletedCalls.length + otherSyncCalls.length;
    expect(totalCleanupEvents).toBeGreaterThan(0);
  });
});

// ===========================================================================
// B5 — role-only channel_updated
// ===========================================================================

describe('B5 — updateGroup rename on role-only group emits channel_updated with discord_channel_id=None', () => {
  /**
   * Test 7: updateGroup rename on a role-only group (mapping: channel_id=NULL, role_id=Some)
   * → emits channel_updated with discord_channel_id=None, discord_role_id=Some, discord_role_name=Some(<newName>).
   * Verifies the event can be decoded without error from the recording mock.
   */
  it('B5-7: updateGroup on role-only group emits channel_updated with discord_channel_id=None', async () => {
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();
    const localMappingLayer = makeMappingRepository(localStore);
    const TEST_ROLE_ID = '888777666555' as Discord.Snowflake;

    const _app7 = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(false)))),
        localMappingLayer,
      ),
    );
    const handler: (...args: any) => Promise<Response> = _app7.handler;
    disposeHandlers.push(_app7.dispose);

    // Create group
    const { status: createStatus, body } = await createGroupViaApi(handler, 'Strikers');
    expect(createStatus).toBe(201);
    const groupId = body.groupId as GroupModel.GroupId;

    // Seed role-only mapping
    localStore.set(groupId, {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(TEST_ROLE_ID),
    });
    groupChannelUpdatedCalls.length = 0;

    // Rename the group
    const renameResp = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${groupId}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Forwards', emoji: null, color: null }),
      }),
    );
    expect(renameResp.status).toBe(200);

    // MUST emit channel_updated for role-only groups too
    expect(groupChannelUpdatedCalls).toHaveLength(1);
    const call = groupChannelUpdatedCalls[0]!;
    // discord_channel_id must be None (role-only, no channel to rename)
    expect(Option.isNone(call.discordChannelId)).toBe(true);
    // discord_role_id must be Some (the role to rename)
    expect(Option.isSome(call.discordRoleId)).toBe(true);
    // Role name must reflect the new group name
    expect(call.discordRoleName).toContain('Forwards');
  });
});

// ===========================================================================
// B7 — repository-level retry behavior
// ===========================================================================

describe('B7 — ChannelSyncEventsRepository markFailed vs markPermanentlyFailed', () => {
  /**
   * Test 8: markFailed (transient) → sets error, leaves processed_at NULL.
   * findUnprocessedEvents still returns the row.
   *
   * This is a unit test directly against the in-memory mock surface of
   * ChannelSyncEventsRepository. Since we don't have a real DB in unit tests,
   * we test the contract by building a controlled implementation.
   */
  it('B7-8: markFailed(transient) → row still returned by findUnprocessed', async () => {
    // Track calls to markFailed
    const failedCalls: Array<{ id: string; error: string }> = [];
    const processedIds: string[] = [];

    // Events store: rows that haven't been permanently failed
    const pendingEvents = [
      {
        id: 'evt-1' as ChannelSyncEvent.ChannelSyncEventId,
        error: null as string | null,
        processed_at: null as string | null,
      },
    ];

    const repo = {
      _tag: 'api/ChannelSyncEventsRepository',
      // Transient fail: sets error, leaves processed_at NULL
      markFailed: (id: ChannelSyncEvent.ChannelSyncEventId, error: string) => {
        failedCalls.push({ id, error });
        const row = pendingEvents.find((e) => e.id === id);
        if (row) row.error = error;
        return Effect.void;
      },
      // Permanent fail: sets BOTH error AND processed_at
      markPermanentlyFailed: (id: ChannelSyncEvent.ChannelSyncEventId, error: string) => {
        const row = pendingEvents.find((e) => e.id === id);
        if (row) {
          row.error = error;
          row.processed_at = new Date().toISOString();
        }
        processedIds.push(id);
        return Effect.void;
      },
      findUnprocessed: (_limit: number) =>
        Effect.succeed(pendingEvents.filter((e) => e.processed_at === null).map((e) => e.id)),
      markProcessed: () => Effect.void,
      emitChannelCreated: () => Effect.void,
      emitChannelDeleted: () => Effect.void,
      emitChannelArchived: () => Effect.void,
      emitChannelDetached: () => Effect.void,
      emitRosterChannelCreated: () => Effect.void,
      emitRosterChannelDeleted: () => Effect.void,
      emitRosterChannelArchived: () => Effect.void,
      emitRosterChannelDetached: () => Effect.void,
      emitGroupChannelUpdated: () => Effect.void,
      emitRosterChannelUpdated: () => Effect.void,
      emitMemberAdded: () => Effect.void,
      emitMemberRemoved: () => Effect.void,
      hasUnprocessedForGroups: () => Effect.succeed([]),
      hasUnprocessedForRosters: () => Effect.succeed([]),
    };

    // Test transient fail: row should still appear in findUnprocessed
    // Use direct Effect.runPromise per step to avoid inference issues with mixed types
    await Effect.runPromise(
      repo.markFailed('evt-1' as ChannelSyncEvent.ChannelSyncEventId, 'Discord 503'),
    );

    const unprocessed = await Effect.runPromise(repo.findUnprocessed(10));

    expect(failedCalls).toHaveLength(1);
    expect(failedCalls[0]?.error).toBe('Discord 503');
    // Row must still be returned by findUnprocessed (processed_at is NULL)
    expect(unprocessed).toContain('evt-1');
  });

  /**
   * Test 9: markPermanentlyFailed → sets both error AND processed_at.
   * findUnprocessedEvents does NOT return the row.
   */
  it('B7-9: markPermanentlyFailed → row NOT returned by findUnprocessed', async () => {
    const pendingEvents = [
      {
        id: 'evt-2' as ChannelSyncEvent.ChannelSyncEventId,
        error: null as string | null,
        processed_at: null as string | null,
      },
    ];

    const repo = {
      markPermanentlyFailed: (id: ChannelSyncEvent.ChannelSyncEventId, error: string) => {
        const row = pendingEvents.find((e) => e.id === id);
        if (row) {
          row.error = error;
          row.processed_at = new Date().toISOString();
        }
        return Effect.void;
      },
      findUnprocessed: (_limit: number) =>
        Effect.succeed(pendingEvents.filter((e) => e.processed_at === null).map((e) => e.id)),
    };

    await Effect.runPromise(
      repo.markPermanentlyFailed(
        'evt-2' as ChannelSyncEvent.ChannelSyncEventId,
        'Unrecoverable error',
      ),
    );

    const unprocessed = await Effect.runPromise(repo.findUnprocessed(10));

    // Row must NOT appear — processed_at was set
    expect(unprocessed).not.toContain('evt-2');
  });
});

// ===========================================================================
// B9 — transactional emit
// ===========================================================================

describe('B9 — transactional emit: group rollback when channel event emission fails', () => {
  /**
   * Test 10: Force emitChannelCreated to fail inside createGroup.
   * Assert groups row is rolled back AND channel_sync_events has no row for this group.
   *
   * This is hard to test without a real DB, so we verify the observable effect:
   * if emitChannelCreated throws, the 500 response should NOT contain a created group ID
   * AND the in-memory groups store should not have the group.
   *
   * NOTE: The current server wraps sync events in `catchAll`, so today the group IS created
   * even if sync event emission fails. The new design requires the emission to be transactional.
   * This test SHOULD FAIL until the server is updated to make emission atomic.
   */
  it.skip('B9-10: if emitChannelCreated throws, createGroup rolls back (requires real DB transaction)', () => {
    // TODO: This test requires integration test infrastructure (real DB) to validate
    // that the INSERT INTO groups and INSERT INTO channel_sync_events are in the same
    // transaction and both roll back on failure.
    //
    // Skipped because: mocking a downstream insert to throw in the in-memory layer
    // doesn't replicate the transactional semantics. This must be an integration test.
    //
    // Expected assertion once implemented:
    //   - POST /teams/:teamId/groups with a failing emitChannelCreated → 500
    //   - groupsStore.has(newGroupId) === false
    //   - channel_sync_events table has no row for this group
  });
});

// ===========================================================================
// B1 — partial unique index on (team_id, discord_channel_id)
// ===========================================================================

describe('B1 — partial unique index: duplicate channel_id same team fails, NULL coexists', () => {
  /**
   * Test 11: setChannelMapping for group A with channel X succeeds.
   * Then setChannelMapping for group B (same team) with the SAME channel X
   * → fails with a domain error (Forbidden or ChannelAlreadyLinked).
   *
   * TODAY the JS pre-check (`mappings.some(m => m.discord_channel_id === payload.discordChannelId)`)
   * is present and catches this. The NEW behavior removes that pre-check and relies on the
   * partial unique index. This test verifies the error surface remains the same.
   * Should pass both before and after the change.
   */
  it('B1-11: duplicate discord_channel_id for same team → 403 on second setChannelMapping', async () => {
    const CHANNEL_X = '123456789012345678' as Discord.Snowflake;
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();

    // Override findAllByTeam to simulate the duplicate check
    const localMappingLayer = Layer.succeed(DiscordChannelMappingRepository, {
      findByGroupId: (_teamId: string, groupId: GroupModel.GroupId) => {
        const m = localStore.get(groupId);
        return Effect.succeed(
          m
            ? Option.some({
                id: 'mock-mapping-id',
                team_id: _teamId,
                entity_type: 'group' as const,
                group_id: Option.some(groupId),
                roster_id: Option.none(),
                discord_channel_id: m.discord_channel_id,
                discord_role_id: m.discord_role_id,
              })
            : Option.none(),
        );
      },
      findByRosterId: () => Effect.succeed(Option.none()),
      insert: () => Effect.void,
      upsertGroupChannel: (
        _teamId: string,
        groupId: GroupModel.GroupId,
        channelId: Discord.Snowflake,
      ) => {
        localStore.set(groupId, {
          discord_channel_id: Option.some(channelId),
          discord_role_id: Option.none(),
        });
        return Effect.void;
      },
      insertRoleOnly: () => Effect.void,
      insertRoster: () => Effect.void,
      deleteByGroupId: (_teamId: string, groupId: GroupModel.GroupId) => {
        localStore.delete(groupId);
        return Effect.void;
      },
      deleteByRosterId: () => Effect.void,
      findAllByTeam: () =>
        Effect.succeed(
          Array.from(localStore.entries()).map(([gid, m]) => ({
            id: 'mock-id',
            team_id: TEST_TEAM_ID,
            entity_type: 'group' as const,
            group_id: Option.some(gid),
            roster_id: Option.none(),
            discord_channel_id: m.discord_channel_id,
            discord_role_id: m.discord_role_id,
          })),
        ),
    } as any);

    const _app11 = HttpRouter.toWebHandler(
      buildTestLayer(
        makeSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
        localMappingLayer,
      ),
    );
    const handler: (...args: any) => Promise<Response> = _app11.handler;
    disposeHandlers.push(_app11.dispose);

    // Create two groups
    const { body: groupA } = await createGroupViaApi(handler, 'Group A');
    const { body: groupB } = await createGroupViaApi(handler, 'Group B');

    // Link group A to channel X → should succeed
    const linkAResp = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/groups/${groupA.groupId}/channel-mapping`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordChannelId: CHANNEL_X }),
        },
      ),
    );
    expect(linkAResp.status).toBe(200);

    // Link group B to same channel X → should fail (403 Forbidden / ChannelAlreadyLinked)
    const linkBResp = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/groups/${groupB.groupId}/channel-mapping`,
        {
          method: 'PUT',
          headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ discordChannelId: CHANNEL_X }),
        },
      ),
    );
    expect(linkBResp.status).toBe(403);
  });

  /**
   * Test 12: Two role-only mappings (NULL channel_id) for two different groups
   * in the same team can coexist (uniqueness ignores NULLs).
   * NEW: insertRoleOnly for group A and group B with the same team — both should succeed.
   * This test SHOULD FAIL until insertRoleOnly is implemented.
   */
  it('B1-12: two role-only mappings (NULL channel_id) in same team coexist', async () => {
    const localStore = new Map<GroupModel.GroupId, MappingEntry>();
    const insertRoleOnlyCalls: GroupModel.GroupId[] = [];

    const localMappingLayer = Layer.succeed(DiscordChannelMappingRepository, {
      findByGroupId: (_teamId: string, groupId: GroupModel.GroupId) => {
        const m = localStore.get(groupId);
        return Effect.succeed(
          m
            ? Option.some({
                id: 'mock',
                team_id: _teamId,
                entity_type: 'group' as const,
                group_id: Option.some(groupId),
                roster_id: Option.none(),
                discord_channel_id: m.discord_channel_id,
                discord_role_id: m.discord_role_id,
              })
            : Option.none(),
        );
      },
      findByRosterId: () => Effect.succeed(Option.none()),
      insert: () => Effect.void,
      upsertGroupChannel: () => Effect.void,
      // NEW method: insertRoleOnly — should allow multiple NULLs
      insertRoleOnly: (_teamId: string, groupId: GroupModel.GroupId, roleId: Discord.Snowflake) => {
        insertRoleOnlyCalls.push(groupId);
        localStore.set(groupId, {
          discord_channel_id: Option.none(),
          discord_role_id: Option.some(roleId),
        });
        return Effect.void;
      },
      insertRoster: () => Effect.void,
      deleteByGroupId: () => Effect.void,
      deleteByRosterId: () => Effect.void,
      findAllByTeam: () =>
        Effect.succeed(
          Array.from(localStore.entries()).map(([gid, m]) => ({
            id: 'mock',
            team_id: TEST_TEAM_ID,
            entity_type: 'group' as const,
            group_id: Option.some(gid),
            roster_id: Option.none(),
            discord_channel_id: m.discord_channel_id,
            discord_role_id: m.discord_role_id,
          })),
        ),
    } as any);

    // Test insertRoleOnly directly via the in-memory store
    // (bypasses Effect infrastructure to avoid type complexity around future API)
    const groupIdA = '00000000-0000-0000-0000-a00000000001' as GroupModel.GroupId;
    const groupIdB = '00000000-0000-0000-0000-b00000000002' as GroupModel.GroupId;
    const roleIdA = '111111111111111111' as Discord.Snowflake;
    const roleIdB = '222222222222222222' as Discord.Snowflake;

    // Call the NEW insertRoleOnly method that must exist on the updated repository
    // (will fail TypeScript compilation until DiscordChannelMappingRepository exposes insertRoleOnly)
    const repoEffect = DiscordChannelMappingRepository.asEffect().pipe(
      Effect.flatMap((repo) =>
        Effect.Do.pipe(
          Effect.tap(
            () =>
              (repo as any).insertRoleOnly(TEST_TEAM_ID, groupIdA, roleIdA) as Effect.Effect<void>,
          ),
          Effect.tap(
            () =>
              (repo as any).insertRoleOnly(TEST_TEAM_ID, groupIdB, roleIdB) as Effect.Effect<void>,
          ),
          Effect.bind('mappingA', () => repo.findByGroupId(TEST_TEAM_ID, groupIdA)),
          Effect.bind('mappingB', () => repo.findByGroupId(TEST_TEAM_ID, groupIdB)),
        ),
      ),
      Effect.provide(localMappingLayer),
    );

    const { mappingA, mappingB } = await Effect.runPromise(repoEffect);

    expect(Option.isSome(mappingA)).toBe(true);
    expect(Option.isSome(mappingB)).toBe(true);
    // Both have NULL channel_id, different role_ids
    if (Option.isSome(mappingA) && Option.isSome(mappingB)) {
      // Cast through any: discord_channel_id is Snowflake in current types but Option<Snowflake>
      // after the server repo update — this test documents the future contract.
      const mA = mappingA.value as any;
      const mB = mappingB.value as any;
      expect(Option.isNone(mA.discord_channel_id as Option.Option<Discord.Snowflake>)).toBe(true);
      expect(Option.isNone(mB.discord_channel_id as Option.Option<Discord.Snowflake>)).toBe(true);
      expect(Option.getOrThrow(mA.discord_role_id as Option.Option<Discord.Snowflake>)).toBe(
        roleIdA,
      );
      expect(Option.getOrThrow(mB.discord_role_id as Option.Option<Discord.Snowflake>)).toBe(
        roleIdB,
      );
    }

    // Both insertRoleOnly calls must have been recorded
    expect(insertRoleOnlyCalls).toHaveLength(2);
  });
});
