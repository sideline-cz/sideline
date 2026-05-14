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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

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

// Recording mock for channel sync events
type ChannelSyncEventCall = {
  teamId: Team.TeamId;
  eventType: ChannelSyncEvent.ChannelSyncEventType;
  groupId: GroupModel.GroupId;
  groupName: string;
  teamMemberId: TeamMember.TeamMemberId | undefined;
  discordUserId: string | undefined;
  discordChannelName: string | undefined;
  discordRoleName: string | undefined;
};

const channelSyncEventCalls: ChannelSyncEventCall[] = [];

const recordChannelCreatedCall = (
  teamId: Team.TeamId,
  groupId: GroupModel.GroupId,
  groupName: string,
  _existingChannelId?: unknown,
  discordChannelName?: string,
  discordRoleName?: string,
) => {
  channelSyncEventCalls.push({
    teamId,
    eventType: 'channel_created',
    groupId,
    groupName,
    teamMemberId: undefined,
    discordUserId: undefined,
    discordChannelName,
    discordRoleName,
  });
  return Effect.void;
};

const recordCall =
  (eventType: ChannelSyncEvent.ChannelSyncEventType) =>
  (...args: readonly unknown[]) => {
    const [teamId, groupId, groupName, teamMemberId, discordUserId] = args as [
      Team.TeamId,
      GroupModel.GroupId,
      string,
      TeamMember.TeamMemberId?,
      string?,
    ];
    channelSyncEventCalls.push({
      teamId,
      eventType,
      groupId,
      groupName,
      teamMemberId,
      discordUserId,
      discordChannelName: undefined,
      discordRoleName: undefined,
    });
    return Effect.void;
  };

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  _tag: 'api/ChannelSyncEventsRepository',
  emitChannelCreated: recordChannelCreatedCall,
  emitChannelDeleted: recordCall('channel_deleted'),
  emitChannelArchived: recordCall('channel_archived'),
  emitChannelDetached: recordCall('channel_detached'),
  emitRosterChannelCreated: recordCall('channel_created'),
  emitRosterChannelDeleted: recordCall('channel_deleted'),
  emitRosterChannelArchived: recordCall('channel_archived'),
  emitRosterChannelDetached: recordCall('channel_detached'),
  emitGroupChannelUpdated: recordCall('channel_updated'),
  emitRosterChannelUpdated: recordCall('channel_updated'),
  emitMemberAdded: recordCall('member_added'),
  emitMemberRemoved: recordCall('member_removed'),
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
  markPermanentlyFailed: () => Effect.void,
  hasUnprocessedForGroups: () => Effect.succeed([]),
  hasUnprocessedForRosters: () => Effect.succeed([]),
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

let nextGroupId = 100;

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
      `00000000-0000-0000-0000-${String(nextGroupId++).padStart(12, '0')}` as GroupModel.GroupId;
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
  updateGroupById: () => Effect.die(new Error('Not implemented')),
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
    if (!member || member.team_id !== teamId || !member.active) {
      return Effect.succeed(Option.none());
    }
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

const channelMappingsStore = new Map<
  string,
  { discord_channel_id: Option.Option<string>; discord_role_id: Option.Option<string> }
>();

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: (_teamId: string, groupId: string) => {
    const mapping = channelMappingsStore.get(groupId);
    return Effect.succeed(
      mapping
        ? Option.some({
            id: 'mock-mapping-id',
            team_id: _teamId,
            entity_type: 'group' as const,
            group_id: Option.some(groupId),
            roster_id: Option.none(),
            discord_channel_id: mapping.discord_channel_id,
            discord_role_id: mapping.discord_role_id,
          })
        : Option.none(),
    );
  },
  findByRosterId: () => Effect.succeed(Option.none()),
  insert: (_teamId: string, groupId: string, channelId: string, roleId: string) => {
    channelMappingsStore.set(groupId, {
      discord_channel_id: Option.some(channelId),
      discord_role_id: Option.some(roleId),
    });
    return Effect.void;
  },
  insertRoleOnly: (_teamId: string, groupId: string, roleId: string) => {
    channelMappingsStore.set(groupId, {
      discord_channel_id: Option.none(),
      discord_role_id: Option.some(roleId),
    });
    return Effect.void;
  },
  upsertGroupChannel: (_teamId: string, groupId: string, channelId: string) => {
    const existing = channelMappingsStore.get(groupId);
    channelMappingsStore.set(groupId, {
      discord_channel_id: Option.some(channelId),
      discord_role_id: existing?.discord_role_id ?? Option.none(),
    });
    return Effect.void;
  },
  clearGroupChannel: (_teamId: string, groupId: string) => {
    const existing = channelMappingsStore.get(groupId);
    if (existing) {
      channelMappingsStore.set(groupId, {
        discord_channel_id: Option.none(),
        discord_role_id: existing.discord_role_id,
      });
    }
    return Effect.void;
  },
  insertRoster: () => Effect.void,
  deleteByGroupId: (_teamId: string, groupId: string) => {
    channelMappingsStore.delete(groupId);
    return Effect.void;
  },
  deleteByRosterId: () => Effect.void,
  findAllByTeam: () => Effect.succeed([]),
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

const TestLayer = ApiLive.pipe(
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
        Layer.succeed(TeamSettingsRepository, {
          _tag: 'api/TeamSettingsRepository',
          findByTeam: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed(Option.none()),
          upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
          getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
          getHorizonDays: () => Effect.succeed(30),
        } as any),
      ),
      MockOAuthConnectionsRepositoryLayer,
    ),
  ),
  Layer.provide(MockAchievementAdminLayers),
)
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers));

const makeTestSettingsLayer = (findByTeamId: () => Effect.Effect<Option.Option<unknown>>) =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId,
    upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as any);

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

const buildTestLayer = (settingsLayer: Layer.Layer<TeamSettingsRepository>) =>
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
          settingsLayer,
        ),
        MockOAuthConnectionsRepositoryLayer,
      ),
    ),
    Layer.provide(MockAchievementAdminLayers),
  )
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  channelSyncEventCalls.length = 0;
});

describe('Channel Sync Events', () => {
  describe('createGroup', () => {
    it('emits channel_created sync event', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Goalkeepers', parentId: null, emoji: null, color: null }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();

      expect(channelSyncEventCalls).toHaveLength(1);
      expect(channelSyncEventCalls[0]).toEqual({
        teamId: TEST_TEAM_ID,
        eventType: 'channel_created',
        groupId: body.groupId,
        groupName: 'Goalkeepers',
        teamMemberId: undefined,
        discordUserId: undefined,
        discordChannelName: 'Goalkeepers',
        discordRoleName: 'Goalkeepers',
      });
    });
  });

  describe('deleteGroup', () => {
    it('emits channel_deleted sync event', async () => {
      const createResponse = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'ToDelete', parentId: null, emoji: null, color: null }),
        }),
      );
      const created = await createResponse.json();

      // Set up a channel mapping so the delete emits a channel_deleted event
      channelMappingsStore.set(created.groupId, {
        discord_channel_id: Option.some('999888777'),
        discord_role_id: Option.some('111222333'),
      });
      channelSyncEventCalls.length = 0;

      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${created.groupId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);

      expect(channelSyncEventCalls).toHaveLength(1);
      expect(channelSyncEventCalls[0]).toMatchObject({
        teamId: TEST_TEAM_ID,
        eventType: 'channel_deleted',
        groupId: created.groupId,
        groupName: 'ToDelete',
      });
    });
  });

  describe('deleteGroup — archive cleanup mode', () => {
    let archiveHandler: (...args: any) => Promise<Response>;
    let archiveDispose: () => Promise<void>;

    beforeAll(() => {
      const layer = buildTestLayer(
        makeTestSettingsLayer(() =>
          Effect.succeed(
            Option.some(
              makeTeamSettingsRow(true, {
                discord_channel_cleanup_on_group_delete: 'archive',
                discord_archive_category_id: '888777666',
              }),
            ),
          ),
        ),
      );
      const app = HttpRouter.toWebHandler(layer);
      archiveHandler = app.handler;
      archiveDispose = app.dispose;
    });

    afterAll(async () => {
      await archiveDispose();
    });

    beforeEach(() => {
      channelSyncEventCalls.length = 0;
    });

    it('emits channel_archived sync event and deletes mapping', async () => {
      const createResponse = await archiveHandler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'ToArchive', parentId: null, emoji: null, color: null }),
        }),
      );
      const created = await createResponse.json();

      // Set up a channel mapping
      channelMappingsStore.set(created.groupId, {
        discord_channel_id: Option.some('999888777'),
        discord_role_id: Option.some('111222333'),
      });
      channelSyncEventCalls.length = 0;

      const response = await archiveHandler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${created.groupId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);

      expect(channelSyncEventCalls).toHaveLength(1);
      expect(channelSyncEventCalls[0]).toMatchObject({
        teamId: TEST_TEAM_ID,
        eventType: 'channel_archived',
        groupId: created.groupId,
        groupName: 'ToArchive',
      });

      // Verify the channel mapping was NOT deleted inline (bot owns the delete via Channel/DeleteMapping RPC)
      expect(channelMappingsStore.has(created.groupId)).toBe(true);
    });
  });

  describe('addGroupMember', () => {
    it('emits member_added sync event with discord_user_id', async () => {
      const createResponse = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'WithMembers', parentId: null, emoji: null, color: null }),
        }),
      );
      const created = await createResponse.json();
      channelSyncEventCalls.length = 0;

      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${created.groupId}/members`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      expect(response.status).toBe(204);

      expect(channelSyncEventCalls).toHaveLength(1);
      expect(channelSyncEventCalls[0]).toEqual({
        teamId: TEST_TEAM_ID,
        eventType: 'member_added',
        groupId: created.groupId,
        groupName: 'WithMembers',
        teamMemberId: TEST_MEMBER_ID,
        discordUserId: '12345',
      });
    });
  });

  describe('removeGroupMember', () => {
    it('emits member_removed sync event with discord_user_id', async () => {
      const createResponse = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'ForRemoval', parentId: null, emoji: null, color: null }),
        }),
      );
      const created = await createResponse.json();

      // Add member first
      await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups/${created.groupId}/members`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      channelSyncEventCalls.length = 0;

      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/groups/${created.groupId}/members/${TEST_MEMBER_ID}`,
          {
            method: 'DELETE',
            headers: { Authorization: 'Bearer admin-token' },
          },
        ),
      );
      expect(response.status).toBe(204);

      expect(channelSyncEventCalls).toHaveLength(1);
      expect(channelSyncEventCalls[0]).toEqual({
        teamId: TEST_TEAM_ID,
        eventType: 'member_removed',
        groupId: created.groupId,
        groupName: 'ForRemoval',
        teamMemberId: TEST_MEMBER_ID,
        discordUserId: '12345',
      });
    });
  });

  describe('sync event failure does not break primary operation', () => {
    it('createGroup succeeds even if sync event emission fails', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Resilient', parentId: null, emoji: null, color: null }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Resilient');
    });
  });

  describe('createGroup — conditional Discord channel creation based on team settings', () => {
    describe('when create_discord_channel_on_group is true', () => {
      let settingsHandler: (...args: any) => Promise<Response>;
      let settingsDispose: () => Promise<void>;

      beforeAll(() => {
        const layer = buildTestLayer(
          makeTestSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(true)))),
        );
        const app = HttpRouter.toWebHandler(layer);
        settingsHandler = app.handler;
        settingsDispose = app.dispose;
      });

      afterAll(async () => {
        await settingsDispose();
      });

      beforeEach(() => {
        channelSyncEventCalls.length = 0;
      });

      it('emits channel_created', async () => {
        const response = await settingsHandler(
          new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer admin-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'DiscordEnabled',
              parentId: null,
              emoji: null,
              color: null,
            }),
          }),
        );
        expect(response.status).toBe(201);
        expect(channelSyncEventCalls).toHaveLength(1);
        expect(channelSyncEventCalls[0]?.eventType).toBe('channel_created');
      });
    });

    describe('when create_discord_channel_on_group is false', () => {
      let settingsHandler: (...args: any) => Promise<Response>;
      let settingsDispose: () => Promise<void>;

      beforeAll(() => {
        const layer = buildTestLayer(
          makeTestSettingsLayer(() => Effect.succeed(Option.some(makeTeamSettingsRow(false)))),
        );
        const app = HttpRouter.toWebHandler(layer);
        settingsHandler = app.handler;
        settingsDispose = app.dispose;
      });

      afterAll(async () => {
        await settingsDispose();
      });

      beforeEach(() => {
        channelSyncEventCalls.length = 0;
      });

      it('emits channel_created with no discordChannelName (role-only)', async () => {
        const response = await settingsHandler(
          new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer admin-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              name: 'DiscordDisabled',
              parentId: null,
              emoji: null,
              color: null,
            }),
          }),
        );
        expect(response.status).toBe(201);
        expect(channelSyncEventCalls).toHaveLength(1);
        expect(channelSyncEventCalls[0]?.eventType).toBe('channel_created');
        expect(channelSyncEventCalls[0]?.discordChannelName).toBeUndefined();
      });
    });

    describe('when no settings row exists (Option.none)', () => {
      let settingsHandler: (...args: any) => Promise<Response>;
      let settingsDispose: () => Promise<void>;

      beforeAll(() => {
        const layer = buildTestLayer(makeTestSettingsLayer(() => Effect.succeed(Option.none())));
        const app = HttpRouter.toWebHandler(layer);
        settingsHandler = app.handler;
        settingsDispose = app.dispose;
      });

      afterAll(async () => {
        await settingsDispose();
      });

      beforeEach(() => {
        channelSyncEventCalls.length = 0;
      });

      it('emits channel_created (default behavior)', async () => {
        const response = await settingsHandler(
          new Request(`http://localhost/teams/${TEST_TEAM_ID}/groups`, {
            method: 'POST',
            headers: {
              Authorization: 'Bearer admin-token',
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ name: 'NoSettings', parentId: null, emoji: null, color: null }),
          }),
        );
        expect(response.status).toBe(201);
        expect(channelSyncEventCalls).toHaveLength(1);
        expect(channelSyncEventCalls[0]?.eventType).toBe('channel_created');
      });
    });
  });
});
