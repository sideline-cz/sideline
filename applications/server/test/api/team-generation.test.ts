// Team-generation handler tests.
// Covers: generateTeams, getGenerationConfig, updateGenerationConfig, postTeamsToDiscord.
// Uses the same HttpRouter.toWebHandler harness as test/api/player-rating.test.ts.

import type { Auth, Discord, Event, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { Elo, TeamGenerationConfig } from '@sideline/domain';
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
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamGenerationRepository } from '~/repositories/TeamGenerationRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingGamesRepository } from '~/repositories/TrainingGamesRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-4000-a000-000000000101' as Auth.UserId;
const TEST_CAPTAIN_USER_ID = '00000000-0000-4000-a000-000000000102' as Auth.UserId;
const TEST_GLOBAL_ADMIN_USER_ID = '00000000-0000-4000-a000-000000000103' as Auth.UserId;

const TEST_TEAM_ID = '00000000-0000-4000-b000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-4000-b000-000000000099' as Team.TeamId;

const TEST_EVENT_ID = '00000000-0000-4000-d000-000000000001' as Event.EventId;
const OTHER_EVENT_ID = '00000000-0000-4000-d000-000000000099' as Event.EventId;

const TEST_PLAYER_MEMBER_ID = '00000000-0000-4000-c000-000000000101' as TeamMember.TeamMemberId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-4000-c000-000000000102' as TeamMember.TeamMemberId;
const TEST_MEMBER_A = '00000000-0000-4000-c000-000000000103' as TeamMember.TeamMemberId;
const TEST_MEMBER_B = '00000000-0000-4000-c000-000000000104' as TeamMember.TeamMemberId;

const TEST_GUILD_ID = '900000000000000001' as Discord.Snowflake;
const TEST_CHANNEL_ID = '900000000000000002' as Discord.Snowflake;
const TEST_GROUP_ID = '00000000-0000-4000-e000-000000000001' as GroupModel.GroupId;

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'team:manage',
];

// ---------------------------------------------------------------------------
// User / session rows
// ---------------------------------------------------------------------------

const now = DateTime.nowUnsafe();

const makeUser = (id: Auth.UserId, discordId: string, username: string, isGlobalAdmin = false) => ({
  id,
  discord_id: discordId,
  username,
  avatar: Option.none<string>(),
  is_profile_complete: true,
  is_global_admin: isGlobalAdmin,
  name: Option.some(username),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: now,
  updated_at: now,
});

const testPlayer = makeUser(TEST_USER_ID, '11101', 'player');
const testCaptain = makeUser(TEST_CAPTAIN_USER_ID, '11102', 'captain');
const testGlobalAdmin = makeUser(TEST_GLOBAL_ADMIN_USER_ID, '11103', 'globaladmin', true);

const usersMap = new Map<Auth.UserId, ReturnType<typeof makeUser>>([
  [TEST_USER_ID, testPlayer],
  [TEST_CAPTAIN_USER_ID, testCaptain],
  [TEST_GLOBAL_ADMIN_USER_ID, testGlobalAdmin],
]);

const sessionsStore = new Map<string, Auth.UserId>([
  ['player-token', TEST_USER_ID],
  ['captain-token', TEST_CAPTAIN_USER_ID],
  ['global-admin-token', TEST_GLOBAL_ADMIN_USER_ID],
]);

// ---------------------------------------------------------------------------
// Team members store
// ---------------------------------------------------------------------------

const membersStore = new Map<TeamMember.TeamMemberId, MembershipWithRole>([
  [
    TEST_PLAYER_MEMBER_ID,
    {
      id: TEST_PLAYER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    } as MembershipWithRole,
  ],
  [
    TEST_CAPTAIN_MEMBER_ID,
    {
      id: TEST_CAPTAIN_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_CAPTAIN_USER_ID,
      active: true,
      role_names: ['Captain'],
      permissions: CAPTAIN_PERMISSIONS,
    } as MembershipWithRole,
  ],
]);

// ---------------------------------------------------------------------------
// Mutable state reset between tests
// ---------------------------------------------------------------------------

type EventStub = {
  id: Event.EventId;
  team_id: Team.TeamId;
  event_type: string;
  status: string;
  title: string;
  owner_group_id: Option.Option<GroupModel.GroupId>;
};

type RsvpYesMemberStub = {
  team_member_id: TeamMember.TeamMemberId;
  display_name: Option.Option<string>;
  discord_id: Option.Option<Discord.Snowflake>;
  avatar: Option.Option<string>;
  rating: number;
  games_played: number;
  role_name: Option.Option<string>;
  jersey_number: Option.Option<number>;
  gender: Option.Option<string>;
};

type TeamGenerationConfigStub = {
  team_id: Team.TeamId;
  weight_elo: number;
  weight_size: number;
  weight_gender: number;
  default_team_count: number;
  max_iterations: number;
};

// Mutable stores
let eventStore: Map<Event.EventId, EventStub>;
let rsvpYesMembers: RsvpYesMemberStub[];
let configStore: Map<Team.TeamId, TeamGenerationConfigStub>;
let upsertConfigCalls: TeamGenerationConfigStub[];
let emitTeamsGeneratedCalls: Array<{
  teamId: Team.TeamId;
  guildId: Discord.Snowflake;
  eventId: Event.EventId;
  title: string;
  channelId: Option.Option<Discord.Snowflake>;
  teams: unknown[];
}>;
let hasPendingTeamsGenerated: boolean;

// Mapping store: group_id -> discord_channel_id (Option)
let channelMappingStore: Map<GroupModel.GroupId, Option.Option<Discord.Snowflake>>;

const makeRsvpYesMember = (
  memberId: TeamMember.TeamMemberId,
  rating = Elo.DEFAULT_RATING,
  gamesPlayed = 5,
): RsvpYesMemberStub => ({
  team_member_id: memberId,
  display_name: Option.some(`Member ${memberId}`),
  discord_id: Option.none(),
  avatar: Option.none(),
  rating,
  games_played: gamesPlayed,
  role_name: Option.none(),
  jersey_number: Option.none(),
  gender: Option.none(),
});

const resetState = () => {
  upsertConfigCalls = [];
  emitTeamsGeneratedCalls = [];
  hasPendingTeamsGenerated = false;

  eventStore = new Map([
    [
      TEST_EVENT_ID,
      {
        id: TEST_EVENT_ID,
        team_id: TEST_TEAM_ID,
        event_type: 'training',
        status: 'active',
        title: 'Training session',
        owner_group_id: Option.some(TEST_GROUP_ID),
      },
    ],
  ]);

  // Two members with RSVP=yes (enough for teamCount=2)
  rsvpYesMembers = [
    makeRsvpYesMember(TEST_MEMBER_A, 1300, 12),
    makeRsvpYesMember(TEST_MEMBER_B, 1100, 8),
  ];

  configStore = new Map();

  channelMappingStore = new Map([[TEST_GROUP_ID, Option.some(TEST_CHANNEL_ID)]]);
};

// ---------------------------------------------------------------------------
// Controlled mock layers
// ---------------------------------------------------------------------------

const makeControlledTeamGenerationRepositoryLayer = () =>
  Layer.succeed(TeamGenerationRepository, {
    _tag: 'api/TeamGenerationRepository' as const,
    findConfigByTeamId: (teamId: Team.TeamId) => {
      const row = configStore.get(teamId);
      return Effect.succeed(row ? Option.some(row) : Option.none());
    },
    upsertConfig: (params: {
      teamId: Team.TeamId;
      weightElo: number;
      weightSize: number;
      weightGender: number;
      defaultTeamCount: number;
      maxIterations: number;
    }) => {
      const row: TeamGenerationConfigStub = {
        team_id: params.teamId,
        weight_elo: params.weightElo,
        weight_size: params.weightSize,
        weight_gender: params.weightGender,
        default_team_count: params.defaultTeamCount,
        max_iterations: params.maxIterations,
      };
      configStore.set(params.teamId, row);
      upsertConfigCalls.push(row);
      return Effect.succeed(row);
    },
    findYesMembersForEvent: (_eventId: Event.EventId) => Effect.succeed(rsvpYesMembers),
  } as never);

const makeControlledEventsRepositoryLayer = () =>
  Layer.succeed(EventsRepository, {
    _tag: 'api/EventsRepository',
    findByTeamId: () => Effect.succeed([]),
    findEventsByTeamId: () => Effect.succeed([]),
    findByIdWithDetails: (eventId: Event.EventId) => {
      const ev = eventStore.get(eventId);
      return Effect.succeed(ev ? Option.some(ev) : Option.none());
    },
    findEventByIdWithDetails: (eventId: Event.EventId) => {
      const ev = eventStore.get(eventId);
      return Effect.succeed(ev ? Option.some(ev) : Option.none());
    },
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

const makeControlledEventSyncEventsRepositoryLayer = () =>
  Layer.succeed(EventSyncEventsRepository, {
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitEventStarted: () => Effect.void,
    emitTrainingClaimRequest: () => Effect.void,
    emitTrainingClaimUpdate: () => Effect.void,
    emitUnclaimedTrainingReminder: () => Effect.void,
    emitCoachingStatus: () => Effect.void,
    emitTeamsGenerated: (
      teamId: Team.TeamId,
      guildId: Discord.Snowflake,
      eventId: Event.EventId,
      title: string,
      channelId: Option.Option<Discord.Snowflake>,
      teams: unknown[],
    ) => {
      // Atomic insert-if-not-pending: returns false (skipped) when a post is already pending,
      // true (inserted) otherwise. Only record the call when a row is actually inserted.
      if (hasPendingTeamsGenerated) return Effect.succeed(false);
      emitTeamsGeneratedCalls.push({ teamId, guildId, eventId, title, channelId, teams });
      return Effect.succeed(true);
    },
    emitEventRosterApprovalRequest: () => Effect.void,
    emitEventRosterApprovalCancel: () => Effect.void,
    emitEventRosterThreadDelete: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeControlledDiscordChannelMappingRepositoryLayer = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: (teamId: Team.TeamId, groupId: GroupModel.GroupId) => {
      if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
      const channelId = channelMappingStore.get(groupId);
      if (!channelId) return Effect.succeed(Option.none());
      return Effect.succeed(Option.some({ discord_channel_id: channelId }));
    },
    insert: () => Effect.void,
    insertWithoutRole: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    findAllByTeamId: () => Effect.succeed([]),
    findAllByTeam: () => Effect.succeed([]),
  } as any);

// ---------------------------------------------------------------------------
// Static mocks (same structure as player-rating.test.ts)
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
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
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
        expires_at: now,
        created_at: now,
      }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: TEST_GUILD_ID,
  created_by: TEST_CAPTAIN_USER_ID,
  created_at: now,
  updated_at: now,
};

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
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
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

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: '11101', username: 'player', avatar: null }), {
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
  getDescendantMemberIds: () => Effect.succeed([]),
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
    Effect.succeed({ id: 'ical-id', user_id: 'user-id', token: 'ical-token', created_at: now }),
  regenerate: () =>
    Effect.succeed({
      id: 'ical-id',
      user_id: 'user-id',
      token: 'ical-token-new',
      created_at: now,
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
  findBySlug: () => Effect.succeed(Option.none()),
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

const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  emitRoleAssigned: () => Effect.void,
  emitRoleUnassigned: () => Effect.void,
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

const MockChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

const MockPlayerRatingsRepositoryLayer = Layer.succeed(PlayerRatingsRepository, {
  _tag: 'api/PlayerRatingsRepository' as const,
  getMemberRating: () => Effect.succeed(Option.none()),
  getTeamRatings: () => Effect.succeed([]),
  findHistoryByMember: () => Effect.succeed([]),
  getOrInitMany: () => Effect.succeed([]),
  applyGameUpdates: () => Effect.void,
} as never);

const MockTrainingGamesRepositoryLayer = Layer.succeed(TrainingGamesRepository, {
  _tag: 'api/TrainingGamesRepository',
  findByEventId: () => Effect.succeed([]),
  insertGame: () => Effect.succeed({ id: 'game-id' }),
  insertAutoIgnoreConflict: () => Effect.void,
  getByEventId: () => Effect.succeed([]),
} as any);

// ---------------------------------------------------------------------------
// Build the full test layer (with controlled mocks)
// ---------------------------------------------------------------------------

const buildTestLayer = (
  options: {
    eventsRepo?: Layer.Layer<EventsRepository>;
    teamGenRepo?: Layer.Layer<TeamGenerationRepository>;
    eventSyncRepo?: Layer.Layer<EventSyncEventsRepository>;
    channelMappingRepo?: Layer.Layer<DiscordChannelMappingRepository>;
  } = {},
) => {
  const eventsRepo = options.eventsRepo ?? makeControlledEventsRepositoryLayer();
  const teamGenRepo = options.teamGenRepo ?? makeControlledTeamGenerationRepositoryLayer();
  const eventSyncRepo = options.eventSyncRepo ?? makeControlledEventSyncEventsRepositoryLayer();
  const channelMappingRepo =
    options.channelMappingRepo ?? makeControlledDiscordChannelMappingRepositoryLayer();

  return ApiLive.pipe(
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
        Layer.merge(eventsRepo, MockEventSeriesRepositoryLayer),
        MockEventRsvpsRepositoryLayer,
      ),
    ),
    Layer.provide(MockHttpClientLayer),
    Layer.provide(MockAgeCheckServiceLayer),
    Layer.provide(MockAgeThresholdRepositoryLayer),
    Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
    Layer.provide(
      Layer.merge(
        Layer.merge(MockChannelSyncEventsRepositoryLayer, eventSyncRepo),
        MockICalTokensRepositoryLayer,
      ),
    ),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              channelMappingRepo,
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
    .pipe(Layer.provide(MockEventRosterLayers))
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
    .pipe(Layer.provide(teamGenRepo))
    .pipe(Layer.provide(MockTrainingGamesRepositoryLayer))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, {
          asEffect: Effect.succeed(new Set<string>()),
        } as any),
      ),
    );
};

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const TEAM_BASE = (teamId: string) => `http://localhost/teams/${teamId}`;
const generateTeamsUrl = (teamId: string, eventId: string) =>
  `${TEAM_BASE(teamId)}/events/${eventId}/generate-teams`;
const generationConfigUrl = (teamId: string) => `${TEAM_BASE(teamId)}/generation-config`;
const postTeamsToDiscordUrl = (teamId: string, eventId: string) =>
  `${TEAM_BASE(teamId)}/events/${eventId}/post-teams-to-discord`;

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const TestLayer = buildTestLayer();
  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetState();
});

// ===========================================================================
// 1. generateTeams — error paths
// ===========================================================================

describe('generateTeams — non-training event → 409 EventNotGeneratable', () => {
  it('event_type != training → 409', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: TEST_TEAM_ID,
      event_type: 'match',
      status: 'active',
      title: 'Match',
      owner_group_id: Option.none(),
    });

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationEventNotGeneratable');
  });

  it('event not found → 409', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, OTHER_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationEventNotGeneratable');
  });

  it('event belongs to another team → 409', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: OTHER_TEAM_ID,
      event_type: 'training',
      status: 'active',
      title: 'Training',
      owner_group_id: Option.none(),
    });

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(409);
  });

  it('cancelled event → 409', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: TEST_TEAM_ID,
      event_type: 'training',
      status: 'cancelled',
      title: 'Training',
      owner_group_id: Option.none(),
    });

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(409);
  });
});

describe('generateTeams — fewer than 2 RSVP-yes members → 422 InsufficientPlayers', () => {
  it('only 1 member RSVP yes → 422', async () => {
    rsvpYesMembers = [makeRsvpYesMember(TEST_MEMBER_A, 1300, 10)];

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationInsufficientPlayers');
  });

  it('zero members RSVP yes → 422', async () => {
    rsvpYesMembers = [];

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(422);
  });
});

describe('generateTeams — missing member:edit permission → 403 Forbidden', () => {
  it('player (no member:edit) → 403', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationForbidden');
  });

  it('unauthenticated → 401', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(401);
  });
});

describe('generateTeams — happy path', () => {
  it('captain with 2 RSVP-yes members → 200 with 2 teams partitioning the roster', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    // Shape checks
    expect(Array.isArray(body.teams)).toBe(true);
    expect(body.teams).toHaveLength(2);
    expect(typeof body.maxRatingSpread).toBe('number');
    expect(typeof body.iterationsUsed).toBe('number');
    expect(Array.isArray(body.warnings)).toBe(true);

    // Each team has enriched member fields
    const allMembers = body.teams.flatMap((t: any) => t.members);
    expect(allMembers).toHaveLength(2); // 2 RSVP members across 2 teams

    for (const m of allMembers) {
      expect(typeof m.teamMemberId).toBe('string');
      expect(typeof m.displayName).toBe('string');
      expect(typeof m.rating).toBe('number');
      expect(typeof m.isCalibrating).toBe('boolean');
    }

    // The two member IDs partition exactly the two RSVP-yes members
    const memberIds = new Set(allMembers.map((m: any) => m.teamMemberId));
    expect(memberIds.has(TEST_MEMBER_A)).toBe(true);
    expect(memberIds.has(TEST_MEMBER_B)).toBe(true);
  });

  it('member with < 10 games played → isCalibrating = true', async () => {
    rsvpYesMembers = [
      makeRsvpYesMember(TEST_MEMBER_A, 1300, 5), // 5 games → calibrating
      makeRsvpYesMember(TEST_MEMBER_B, 1100, 12), // 12 games → not calibrating
    ];

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const allMembers = body.teams.flatMap((t: any) => t.members);

    const memberA = allMembers.find((m: any) => m.teamMemberId === TEST_MEMBER_A);
    const memberB = allMembers.find((m: any) => m.teamMemberId === TEST_MEMBER_B);

    expect(memberA).toBeDefined();
    expect(memberB).toBeDefined();
    expect(memberA.isCalibrating).toBe(true);
    expect(memberB.isCalibrating).toBe(false);
  });

  it('member with no rating row → defaulted to 1200 (Elo.DEFAULT_RATING)', async () => {
    // Set rating = Elo.DEFAULT_RATING to simulate the SQL COALESCE(pr.rating, 1200)
    rsvpYesMembers = [
      makeRsvpYesMember(TEST_MEMBER_A, Elo.DEFAULT_RATING, 0),
      makeRsvpYesMember(TEST_MEMBER_B, Elo.DEFAULT_RATING, 0),
    ];

    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    const allMembers = body.teams.flatMap((t: any) => t.members);

    for (const m of allMembers) {
      expect(m.rating).toBe(Elo.DEFAULT_RATING);
    }
  });

  it('global admin (not a team member) → 200 via isGlobalAdmin bypass', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer global-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({}),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.teams)).toBe(true);
  });
});

// ===========================================================================
// 2. getGenerationConfig
// ===========================================================================

describe('getGenerationConfig — permission gate', () => {
  it('player (no member:edit) → 403', async () => {
    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationForbidden');
  });

  it('unauthenticated → 401', async () => {
    const response = await handler(new Request(generationConfigUrl(TEST_TEAM_ID)));
    expect(response.status).toBe(401);
  });
});

describe('getGenerationConfig — no config row → defaults', () => {
  it('returns defaults when no row exists for the team', async () => {
    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.teamId).toBe(TEST_TEAM_ID);
    expect(body.weightElo).toBe(TeamGenerationConfig.DEFAULT_WEIGHT_ELO);
    expect(body.weightSize).toBe(TeamGenerationConfig.DEFAULT_WEIGHT_SIZE);
    expect(body.weightGender).toBe(TeamGenerationConfig.DEFAULT_WEIGHT_GENDER);
    expect(body.defaultTeamCount).toBe(TeamGenerationConfig.DEFAULT_TEAM_COUNT);
    expect(body.maxIterations).toBe(TeamGenerationConfig.DEFAULT_MAX_ITERATIONS);
    expect(body.canManage).toBe(true); // captain has member:edit
  });

  it('global admin → canManage = true', async () => {
    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer global-admin-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canManage).toBe(true);
  });
});

describe('getGenerationConfig — existing config row', () => {
  it('returns stored config values', async () => {
    configStore.set(TEST_TEAM_ID, {
      team_id: TEST_TEAM_ID,
      weight_elo: 80,
      weight_size: 40,
      weight_gender: 15,
      default_team_count: 2,
      max_iterations: 500,
    });

    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.weightElo).toBe(80);
    expect(body.weightSize).toBe(40);
    expect(body.weightGender).toBe(15);
    expect(body.maxIterations).toBe(500);
  });
});

// ===========================================================================
// 3. updateGenerationConfig
// ===========================================================================

describe('updateGenerationConfig — permission gate', () => {
  it('player (no member:edit) → 403', async () => {
    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weightElo: 80 }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationForbidden');
  });

  it('unauthenticated → 401', async () => {
    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ weightElo: 80 }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe('updateGenerationConfig — GET→PATCH→GET round-trip', () => {
  it('PATCH updates stored config and subsequent GET reflects new values', async () => {
    // 1. Initial GET → defaults
    const getResponse1 = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(getResponse1.status).toBe(200);
    const before = await getResponse1.json();
    expect(before.weightElo).toBe(TeamGenerationConfig.DEFAULT_WEIGHT_ELO);

    // 2. PATCH with new weightElo
    const patchResponse = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weightElo: 75 }),
      }),
    );
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody.weightElo).toBe(75);
    // Unset fields fall back to defaults
    expect(patchBody.weightSize).toBe(TeamGenerationConfig.DEFAULT_WEIGHT_SIZE);
    expect(patchBody.canManage).toBe(true);

    // 3. Verify upsertConfig was called once
    expect(upsertConfigCalls).toHaveLength(1);
    expect(upsertConfigCalls[0].weight_elo).toBe(75);

    // 4. Subsequent GET → reflects the patched value (store updated in-memory)
    const getResponse2 = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(getResponse2.status).toBe(200);
    const after = await getResponse2.json();
    expect(after.weightElo).toBe(75);
  });
});

describe('updateGenerationConfig — partial PATCH merges with existing config', () => {
  it('PATCH with only weightGender → other fields inherit existing stored values', async () => {
    // Seed an existing config
    configStore.set(TEST_TEAM_ID, {
      team_id: TEST_TEAM_ID,
      weight_elo: 90,
      weight_size: 45,
      weight_gender: 10,
      default_team_count: 2,
      max_iterations: 800,
    });

    const response = await handler(
      new Request(generationConfigUrl(TEST_TEAM_ID), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ weightGender: 30 }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();

    // Updated field
    expect(body.weightGender).toBe(30);
    // Fields not in PATCH → should come from existing config
    expect(body.weightElo).toBe(90);
    expect(body.maxIterations).toBe(800);
  });
});

// ===========================================================================
// 4. postTeamsToDiscord — error paths
// ===========================================================================

describe('postTeamsToDiscord — permission gate', () => {
  it('player (no member:edit) → 403', async () => {
    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationForbidden');
  });
});

describe('postTeamsToDiscord — team not found → 502 DiscordPostFailed', () => {
  it('unknown teamId → 502', async () => {
    const response = await handler(
      new Request(postTeamsToDiscordUrl(OTHER_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer global-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );
    // Not in TEST_TEAM_ID → member gate for global admin succeeds (no membership lookup fails),
    // but TeamsRepository.findById returns None for OTHER_TEAM_ID → DiscordPostFailed
    expect(response.status).toBe(502);
  });
});

describe('postTeamsToDiscord — no channel mapping → 502 DiscordPostFailed', () => {
  it('event has owner_group_id with no Discord channel mapped → 502', async () => {
    // Clear the channel mapping so the lookup returns None for the channel id
    channelMappingStore.set(TEST_GROUP_ID, Option.none());

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(502);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationDiscordPostFailed');
  });

  it('event has no owner_group_id → 502 (no channel can be resolved)', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: TEST_TEAM_ID,
      event_type: 'training',
      status: 'active',
      title: 'Training',
      owner_group_id: Option.none(), // no group → no channel
    });

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(502);
  });
});

describe('postTeamsToDiscord — event validity guard → 409 EventNotGeneratable', () => {
  it('non-training event type → 409', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: TEST_TEAM_ID,
      event_type: 'match',
      status: 'active',
      title: 'Match',
      owner_group_id: Option.some(TEST_GROUP_ID),
    });

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationEventNotGeneratable');
  });

  it('cancelled event → 409', async () => {
    eventStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ID,
      team_id: TEST_TEAM_ID,
      event_type: 'training',
      status: 'cancelled',
      title: 'Training',
      owner_group_id: Option.some(TEST_GROUP_ID),
    });

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationEventNotGeneratable');
  });
});

describe('postTeamsToDiscord — roster mismatch → 409 TeamGenerationRosterChanged', () => {
  it('submitted id not in RSVP-yes roster → 409', async () => {
    // TEST_MEMBER_A and TEST_MEMBER_B are in rsvpYesMembers but we submit TEST_CAPTAIN_MEMBER_ID
    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_CAPTAIN_MEMBER_ID] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationRosterChanged');
  });

  it('submitted ids do not cover full roster → 409', async () => {
    // Only submitting TEST_MEMBER_A but roster has TEST_MEMBER_A and TEST_MEMBER_B
    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationRosterChanged');
  });

  it('duplicate member id across teams → 409', async () => {
    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A, TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationRosterChanged');
  });
});

describe('postTeamsToDiscord — post already pending → 409 TeamGenerationPostPending', () => {
  it('unprocessed teams_generated already exists → 409', async () => {
    hasPendingTeamsGenerated = true;

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationPostPending');
  });
});

describe('postTeamsToDiscord — happy path', () => {
  it('captain with valid event+channel → 204 and emitTeamsGenerated called with server-derived payload', async () => {
    // New membership-only payload — no displayName/rating/isCalibrating from client
    const teamsPayload = [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }];

    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ teams: teamsPayload }),
      }),
    );

    expect(response.status).toBe(204);

    // Verify emitTeamsGenerated was called with correct args
    expect(emitTeamsGeneratedCalls).toHaveLength(1);
    const call = emitTeamsGeneratedCalls[0];
    expect(call.teamId).toBe(TEST_TEAM_ID);
    expect(call.guildId).toBe(TEST_GUILD_ID);
    expect(call.eventId).toBe(TEST_EVENT_ID);
    expect(call.title).toBe('Training session');
    expect(Option.isSome(call.channelId)).toBe(true);
    expect(Option.getOrUndefined(call.channelId)).toBe(TEST_CHANNEL_ID);
    expect(Array.isArray(call.teams)).toBe(true);
    expect(call.teams).toHaveLength(2);

    // Server derives names/ratings from DB — should be stable server-side labels
    const teams = call.teams as Array<{
      name: string;
      avg_rating: number;
      members: Array<{ display_name: string; rating: number; is_calibrating: boolean }>;
    }>;
    expect(teams[0].name).toBe('Team 1');
    expect(teams[1].name).toBe('Team 2');

    // avg_rating is computed server-side from DB ratings (1300 and 1100)
    expect(typeof teams[0].avg_rating).toBe('number');
    expect(typeof teams[1].avg_rating).toBe('number');

    // display_name comes from DB (makeRsvpYesMember sets "Member <id>")
    expect(typeof teams[0].members[0].display_name).toBe('string');
    expect(typeof teams[0].members[0].rating).toBe('number');
    expect(typeof teams[0].members[0].is_calibrating).toBe('boolean');
  });

  it('global admin → 204', async () => {
    const response = await handler(
      new Request(postTeamsToDiscordUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer global-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teams: [{ memberIds: [TEST_MEMBER_A] }, { memberIds: [TEST_MEMBER_B] }],
        }),
      }),
    );
    expect(response.status).toBe(204);
  });
});

describe('generateTeams — unsupported team count → 422 UnsupportedTeamCount', () => {
  it('teamCount=3 → 422 UnsupportedTeamCount', async () => {
    const response = await handler(
      new Request(generateTeamsUrl(TEST_TEAM_ID, TEST_EVENT_ID), {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ teamCount: 3 }),
      }),
    );

    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('TeamGenerationUnsupportedTeamCount');
  });
});
