import type { Auth, Discord, Event, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
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
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
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
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from '../mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_EVENT_ID_A = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const TEST_EVENT_ID_B = '00000000-0000-0000-0000-000000000061' as Event.EventId;
const GROUP_A = 'group-a-id' as GroupModel.GroupId;
const GROUP_B = 'group-b-id' as GroupModel.GroupId;

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
  'event:create',
  'event:edit',
  'event:cancel',
];
const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Test User'),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
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
  birth_date: Option.none(),
  gender: Option.some('male' as const),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
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

const usersMap = new Map<Auth.UserId, typeof testUser>([
  [TEST_USER_ID, testUser],
  [TEST_ADMIN_ID, testAdmin],
]);

const sessionsStore = new Map<string, Auth.UserId>([
  ['user-token', TEST_USER_ID],
  ['admin-token', TEST_ADMIN_ID],
]);

const membersStore = new Map<string, MembershipWithRole>([
  [
    TEST_MEMBER_ID,
    {
      id: TEST_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    },
  ],
  [
    TEST_ADMIN_MEMBER_ID,
    {
      id: TEST_ADMIN_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_ADMIN_ID,
      active: true,
      role_names: ['Admin'],
      permissions: ADMIN_PERMISSIONS,
    },
  ],
]);

// Two events: event A restricted to GROUP_A, event B restricted to GROUP_B.
// The test non-admin member belongs to GROUP_A only.
const makeEventRow = (
  id: Event.EventId,
  memberGroupId: Option.Option<GroupModel.GroupId>,
  title: string,
) => ({
  id,
  team_id: TEST_TEAM_ID,
  training_type_id: Option.none(),
  event_type: 'tournament' as const,
  title,
  description: Option.none(),
  image_url: Option.none(),
  start_at: DateTime.makeUnsafe('2099-07-01T10:00:00Z'),
  end_at: Option.none(),
  location: Option.none(),
  location_url: Option.none(),
  status: 'active' as const,
  created_by: TEST_ADMIN_MEMBER_ID,
  training_type_name: Option.none(),
  created_by_name: Option.none(),
  series_id: Option.none(),
  series_modified: false,
  discord_target_channel_id: Option.none(),
  owner_group_id: Option.none(),
  owner_group_name: Option.none(),
  member_group_id: memberGroupId,
  member_group_name: Option.none(),
  reminder_sent_at: Option.none(),
  claimed_by: Option.none(),
  claimer_name: Option.none(),
  claim_discord_channel_id: Option.none(),
  claim_discord_message_id: Option.none(),
  all_day: false,
});

const EVENT_A = makeEventRow(TEST_EVENT_ID_A, Option.some(GROUP_A), 'Event A');
const EVENT_B = makeEventRow(TEST_EVENT_ID_B, Option.some(GROUP_B), 'Event B');

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  createAuthorizationURL: () =>
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
  create: (input: { token: string; user_id: Auth.UserId }) => {
    sessionsStore.set(input.token, input.user_id);
    return Effect.succeed({
      id: 'session-1',
      user_id: input.user_id,
      token: input.token,
      expires_at: DateTime.nowUnsafe(),
      created_at: DateTime.nowUnsafe(),
    });
  },
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
  findById: (id: Team.TeamId) =>
    Effect.succeed(id === TEST_TEAM_ID ? Option.some(testTeam) : Option.none()),
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
  findByUser: (userId: Auth.UserId) =>
    Effect.succeed(Array.from(membersStore.values()).filter((m) => m.user_id === userId)),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

// findEventsByTeamId returns EVENT_A and EVENT_B — two events in different groups
const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: (_teamId: Team.TeamId) => Effect.succeed([EVENT_A, EVENT_B]),
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
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findEventsByChannelId: () => Effect.succeed([]),
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findNonResponders: () => Effect.succeed([]),
} as any);

// getDescendantMemberIds: GROUP_A contains TEST_MEMBER_ID, GROUP_B does not.
// This means the non-admin user can see Event A but not Event B.
const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  _tag: 'api/GroupsRepository',
  findGroupsByTeamId: () => Effect.succeed([]),
  findGroupById: () => Effect.succeed(Option.none()),
  insertGroup: () => Effect.die(new Error('Not implemented')),
  updateGroupById: () => Effect.die(new Error('Not implemented')),
  archiveGroupById: () => Effect.void,
  moveGroup: () => Effect.die(new Error('Not implemented')),
  findMembersByGroupId: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
  getRolesForGroup: () => Effect.succeed([]),
  getMemberCount: () => Effect.succeed(0),
  getChildren: () => Effect.succeed([]),
  getAncestorIds: () => Effect.succeed([]),
  getDescendantMemberIds: (groupId: GroupModel.GroupId) => {
    // GROUP_A contains both the regular member and the admin member
    if (groupId === GROUP_A) return Effect.succeed([TEST_MEMBER_ID, TEST_ADMIN_MEMBER_ID]);
    // GROUP_B contains neither — so filtering always hides Event B
    return Effect.succeed([]);
  },
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

const MockEventRostersRepositoryLayer = Layer.succeed(EventRostersRepository, {
  findByEventId: () => Effect.succeed(Option.none()),
  link: () => Effect.die(new Error('Not implemented')),
  unlink: () => Effect.void,
  setAutoApprove: () => Effect.void,
  saveThreadIfAbsent: () => Effect.succeed(Option.none()),
  clearThread: () => Effect.void,
} as any);

const MockEventRosterRequestsRepositoryLayer = Layer.succeed(EventRosterRequestsRepository, {
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findById: () => Effect.succeed(Option.none()),
  upsertApproved: () => Effect.die(new Error('Not implemented')),
  upsertPending: () => Effect.die(new Error('Not implemented')),
  claimDecision: () => Effect.succeed(Option.none()),
  cancel: () => Effect.succeed(Option.none()),
  saveMessageId: () => Effect.void,
  findPendingByEvent: () => Effect.succeed([]),
  wasMemberBefore: () => Effect.succeed(false),
  findPendingByRoster: () => Effect.succeed([]),
} as any);

const MockEventRosterProvisioningServiceLayer = Layer.succeed(EventRosterProvisioningService, {
  onRsvp: () => Effect.void,
  approve: () => Effect.die(new Error('Not implemented')),
  decline: () => Effect.die(new Error('Not implemented')),
  backfill: () => Effect.die(new Error('Not implemented')),
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

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  _tag: 'api/TrainingTypesRepository',
  findByTeamId: () => Effect.succeed([]),
  findTrainingTypesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findTrainingTypeById: () => Effect.succeed(Option.none()),
  findByIdWithGroup: () => Effect.succeed(Option.none()),
  findTrainingTypeByIdWithGroup: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  insertTrainingType: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateTrainingType: () => Effect.die(new Error('Not implemented')),
  deleteTrainingType: () => Effect.void,
  deleteTrainingTypeById: () => Effect.void,
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
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

const MockRolesRepositoryLayer = Layer.succeed(RolesRepository, {
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

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  emitEventRosterApprovalCancel: () => Effect.void,
  emitEventRosterThreadDelete: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  emitChannelCreated: () => Effect.void,
  emitChannelDeleted: () => Effect.void,
  emitMemberAdded: () => Effect.void,
  emitMemberRemoved: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
  hasUnprocessedForGroups: () => Effect.succeed([]),
  hasUnprocessedForRosters: () => Effect.succeed([]),
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

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
  evaluateTeam: () => Effect.succeed([]),
  evaluate: () => Effect.succeed([]),
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
  insert: () => Effect.die(new Error('Not implemented')),
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
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

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
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
  insert: () =>
    Effect.succeed({
      id: 'log-id',
      activity_type_id: 'type-id',
      logged_at: new Date().toISOString(),
      source: 'auto',
    }),
  findByTeamMember: () => Effect.succeed([]),
} as any);

const MockLeaderboardRepositoryLayer = Layer.succeed(LeaderboardRepository, {
  getLeaderboard: () => Effect.succeed([]),
} as any);

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  findBySlug: () =>
    Effect.succeed(
      Option.some({ id: 'mock-type-id', name: 'Training', slug: Option.some('training') }),
    ),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
} as any);

const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  syncChannels: () => Effect.void,
  findByGuildId: () => Effect.succeed([]),
} as any);

const MockDiscordRolesRepositoryLayer = Layer.succeed(
  DiscordRolesRepository,
  new Proxy({} as any, { get: () => () => Effect.void }),
);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
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

const MockChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

// ---------------------------------------------------------------------------
// TestLayer — mirrors the eventRoster.test.ts harness exactly
// ---------------------------------------------------------------------------

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
          enqueue: () => Effect.void,
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {} as never),
      ),
    ),
  ),
  Layer.provide(MockRolesRepositoryLayer),
  Layer.provide(MockGroupsRepositoryLayer),
  Layer.provide(MockTrainingTypesRepositoryLayer),
  Layer.provide(
    Layer.merge(
      Layer.merge(MockEventsRepositoryLayer, MockEventSeriesRepositoryLayer),
      MockEventRsvpsRepositoryLayer,
    ),
  ),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockAgeCheckServiceLayer),
  Layer.provide(MockAgeThresholdRepositoryLayer),
  Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
  Layer.provide(
    Layer.merge(
      Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
      MockICalTokensRepositoryLayer,
    ),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            MockDiscordChannelMappingRepositoryLayer,
            Layer.succeed(BotGuildsRepository, {
              upsert: () => Effect.void,
              remove: () => Effect.void,
              exists: () => Effect.succeed(false),
              findAll: () => Effect.succeed([]),
            } as any),
          ),
          Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
        ),
        Layer.succeed(TeamSettingsRepository, {
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
  .pipe(Layer.provide(MockEventRostersRepositoryLayer))
  .pipe(Layer.provide(MockEventRosterRequestsRepositoryLayer))
  .pipe(Layer.provide(MockEventRosterProvisioningServiceLayer))
  .pipe(Layer.provide(MockChannelEventDividersRepositoryLayer))
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(
    Layer.provide(
      Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
    ),
  );

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
  // No mutable state to reset in this test file — the mock layers are stateless
});

const EVENTS_BASE = `http://localhost/teams/${TEST_TEAM_ID}/events`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Event List API — admin with ?all=true', () => {
  it('returns both events and canViewAll=true', async () => {
    const response = await handler(
      new Request(`${EVENTS_BASE}?all=true`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canViewAll).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(2);
    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain(TEST_EVENT_ID_A);
    expect(eventIds).toContain(TEST_EVENT_ID_B);
  });
});

describe('Event List API — admin without ?all flag', () => {
  it('returns only group-filtered events and canViewAll=true', async () => {
    const response = await handler(
      new Request(EVENTS_BASE, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canViewAll).toBe(true);
    // Admin is in GROUP_A (getDescendantMemberIds returns [TEST_MEMBER_ID, TEST_ADMIN_MEMBER_ID])
    // Admin is NOT in GROUP_B (getDescendantMemberIds returns [])
    // So group-filtering returns only Event A
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain(TEST_EVENT_ID_A);
    expect(eventIds).not.toContain(TEST_EVENT_ID_B);
  });
});

describe('Event List API — admin with ?all=false', () => {
  it('returns only group-filtered events (same as no flag) and canViewAll=true', async () => {
    const response = await handler(
      new Request(`${EVENTS_BASE}?all=false`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canViewAll).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain(TEST_EVENT_ID_A);
    expect(eventIds).not.toContain(TEST_EVENT_ID_B);
  });
});

describe('Event List API — non-admin with ?all=true (core security assertion)', () => {
  it('returns only group-filtered events and canViewAll=false — does NOT leak Event B', async () => {
    const response = await handler(
      new Request(`${EVENTS_BASE}?all=true`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canViewAll).toBe(false);
    expect(Array.isArray(body.events)).toBe(true);
    // Non-admin member belongs to GROUP_A only, so only Event A is visible
    expect(body.events).toHaveLength(1);
    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain(TEST_EVENT_ID_A);
    expect(eventIds).not.toContain(TEST_EVENT_ID_B);
  });
});

describe('Event List API — non-admin without ?all flag', () => {
  it('returns only group-filtered events and canViewAll=false', async () => {
    const response = await handler(
      new Request(EVENTS_BASE, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canViewAll).toBe(false);
    expect(Array.isArray(body.events)).toBe(true);
    expect(body.events).toHaveLength(1);
    const eventIds = body.events.map((e: { eventId: string }) => e.eventId);
    expect(eventIds).toContain(TEST_EVENT_ID_A);
    expect(eventIds).not.toContain(TEST_EVENT_ID_B);
  });
});

describe('Event List API — unauthenticated request', () => {
  it('returns 401 when no auth token is provided', async () => {
    const response = await handler(new Request(EVENTS_BASE));
    expect(response.status).toBe(401);
  });
});
