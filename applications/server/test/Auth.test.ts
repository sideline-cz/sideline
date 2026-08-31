import type { Auth, Discord, Role, Team, TeamInvite, TeamMember } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import type {
  MembershipWithDiscordState,
  MembershipWithRole,
} from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordJoinEnforcementConfig } from '~/services/DiscordJoinEnforcementConfig.js';
import { DiscordOAuth, DiscordOAuthError } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from './mocks/playerRatingMocks.js';
import { MockRulesAttemptsRepositoryLayer } from './mocks/rulesTrainerMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_ROLE_ID = '00000000-0000-0000-0000-000000000040' as Role.RoleId;

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none(),
  is_profile_complete: false,
  is_global_admin: false,
  name: Option.none(),
  birth_date: Option.none(),
  gender: Option.none(),
  locale: 'en' as const,
  discord_display_name: Option.none(),
  discord_nickname: Option.none(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_USER_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('pre-existing-token', TEST_USER_ID);

const mockTokens = (access: string, refresh: string) =>
  new OAuth2Tokens({
    access_token: access,
    refresh_token: refresh,
    scope: 'identify guilds guilds.join',
  });

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: (code: string) =>
    code === 'valid-code'
      ? Effect.succeed(mockTokens('mock-access-token', 'mock-refresh-token'))
      : Effect.fail(new DiscordOAuthError({ cause: new Error('Invalid code') })),
});

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) =>
    Effect.succeed(id === TEST_USER_ID ? Option.some(testUser) : Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
  updateAdminProfile: () => Effect.succeed(testUser),
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

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            id: '12345',
            username: 'testuser',
            avatar: null,
            discriminator: '0',
            public_flags: 0,
            flags: 0,
            mfa_enabled: false,
            locale: 'en-US',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    ),
  ),
);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.succeed(testTeam),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: (input: { team_id: string; user_id: string }) =>
    Effect.succeed({
      id: '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId,
      team_id: input.team_id,
      user_id: input.user_id,
      active: true,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    }),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_ROLE_ID })),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () =>
    Effect.succeed({
      id: '00000000-0000-0000-0000-000000000030' as TeamInvite.TeamInviteId,
      team_id: TEST_TEAM_ID,
      code: 'test-code',
      active: true,
      created_by: TEST_USER_ID,
      created_at: DateTime.nowUnsafe(),
      expires_at: Option.none(),
    }),
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
  insert: () => Effect.die(new Error('Not implemented')),
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

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
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

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  _tag: 'api/OAuthConnectionsRepository',
  upsertConnection: () => Effect.succeed({} as never),
  upsert: () => Effect.succeed({} as never),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
  getGrantedScopes: () => Effect.succeed(Option.some('identify guilds guilds.join')),
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
  Layer.provide(MockRolesRepositoryLayer),
  Layer.provide(MockGroupsRepositoryLayer),
  Layer.provide(MockTrainingTypesRepositoryLayer),
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
          requeueFailedForUser: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {
          _tag: 'api/InviteAcceptancesRepository',
        } as never),
      ),
    ),
  ),
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
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
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

describe('Auth API', () => {
  it('GET /auth/me without token returns 401', async () => {
    const response = await handler(new Request('http://localhost/auth/me'));
    expect(response.status).toBe(401);
  });

  it('GET /auth/me with valid session returns user', async () => {
    const response = await handler(
      new Request('http://localhost/auth/me', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.username).toBe('testuser');
  });

  it('GET /auth/login redirects to Discord OAuth', async () => {
    const response = await handler(new Request('http://localhost/auth/login'));
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('discord.com/oauth2/authorize');
  });

  it('GET /auth/callback with no params redirects with reason=missing_params', async () => {
    const response = await handler(new Request('http://localhost/auth/callback'));
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('reason=missing_params');
  });

  it('GET /auth/callback?error=access_denied redirects with reason=access_denied', async () => {
    const response = await handler(
      new Request('http://localhost/auth/callback?error=access_denied'),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('reason=access_denied');
  });

  it('GET /auth/callback with bad code redirects with reason=oauth_failed', async () => {
    const response = await handler(
      new Request(
        'http://localhost/auth/callback?code=bad&state=%7B%22id%22%3A%22d5760fa3-5440-4f87-8136-f5c1109aaea0%22%2C%20%22redirectUrl%22%3A%22http%3A%2F%2Flocalhost%3A5173%2Fredirect%22%7D',
      ),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('reason=oauth_failed');
  });

  it('GET /auth/callback with valid code redirects with token', async () => {
    const response = await handler(
      new Request(
        'http://localhost/auth/callback?code=valid-code&state=%7B%22id%22%3A%22d5760fa3-5440-4f87-8136-f5c1109aaea0%22%2C%20%22redirectUrl%22%3A%22http%3A%2F%2Flocalhost%3A5173%2Fredirect%22%7D',
      ),
    );
    expect(response.status).toBe(302);
    const location = response.headers.get('Location');
    expect(location).toContain('http://localhost:5173/redirect?token=');
  });
});

// ---------------------------------------------------------------------------
// TDD: first registered user = global admin — isGlobalAdmin on /auth/me
// ---------------------------------------------------------------------------
// These tests verify the `isGlobalAdmin` flag on the CurrentUser returned by
// GET /auth/me. The flag is computed as:
//   user.is_global_admin || globalAdminDiscordIds.has(user.discord_id)
//
// We test:
//   1. db flag true  + env allowlist empty  → isGlobalAdmin true
//   2. db flag false + env does NOT contain id → isGlobalAdmin false
//   (env-allowlist case is covered in note below)
//
// Note: stubbing `globalAdminDiscordIds` (a module-level Set initialised at
// import time from process.env) requires rewiring the env before the module
// loads, which is invasive in this test suite. The two cases above
// (db-flag-true and db-flag-false+no-allowlist) are sufficient to verify the
// OR logic when the allowlist branch cannot be isolated cheaply.

describe('Auth API — isGlobalAdmin flag on GET /auth/me (TDD: first registered user = global admin)', () => {
  const buildLayerWithUser = (userOverrides: Partial<typeof testUser>) => {
    const customUser = { ...testUser, ...userOverrides };

    const CustomUsersRepositoryLayer = Layer.succeed(UsersRepository, {
      _tag: 'api/UsersRepository',
      findById: (id: Auth.UserId) =>
        Effect.succeed(id === TEST_USER_ID ? Option.some(customUser) : Option.none()),
      findByDiscordId: () => Effect.succeed(Option.none()),
      upsertFromDiscord: () => Effect.succeed(customUser),
      completeProfile: () => Effect.succeed(customUser),
      updateLocale: () => Effect.succeed(customUser),
      updateAdminProfile: () => Effect.succeed(customUser),
    } as any);

    return ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(CustomUsersRepositoryLayer),
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
      Layer.provide(MockRolesRepositoryLayer),
      Layer.provide(MockGroupsRepositoryLayer),
      Layer.provide(MockTrainingTypesRepositoryLayer),
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
              requeueFailedForUser: () => Effect.void,
            } as never),
            Layer.succeed(InviteAcceptancesRepository, {
              _tag: 'api/InviteAcceptancesRepository',
            } as never),
          ),
        ),
      ),
      Layer.provide(MockHttpClientLayer),
      Layer.provide(MockAgeCheckServiceLayer),
      Layer.provide(MockAgeThresholdRepositoryLayer),
      Layer.provide(
        Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer),
      ),
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
      .pipe(Layer.provide(MockTranslationsLayers))
      .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
      .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
      .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
      .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
      .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
      .pipe(Layer.provide(MockChannelManagementLayers))
      .pipe(Layer.provide(MockEmailLayers))
      .pipe(Layer.provide(MockEventRosterLayers))
      .pipe(Layer.provide(BotInfoStore.Default))
      .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
      .pipe(
        Layer.provide(
          Layer.succeed(GlobalAdminAllowlist, {
            asEffect: Effect.succeed(new Set<string>()),
          } as any),
        ),
      );
  };

  it('isGlobalAdmin true when db flag is true and env allowlist empty', async () => {
    // db row has is_global_admin: true — the CurrentUser.isGlobalAdmin must be true
    // regardless of the env allowlist (which is empty in test env)
    const testLayer = buildLayerWithUser({
      is_global_admin: true,
      discord_id: 'non-allowlisted-id',
    });
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request('http://localhost/auth/me', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isGlobalAdmin).toBe(true);
  });

  it('isGlobalAdmin false when neither db flag nor env allowlist match', async () => {
    // db row has is_global_admin: false and discord_id not in env allowlist
    const testLayer = buildLayerWithUser({
      is_global_admin: false,
      discord_id: 'not-in-allowlist',
    });
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request('http://localhost/auth/me', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.isGlobalAdmin).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TDD: Handle removing user — GET /auth/me/teams and autoJoinTeams behaviour
// ---------------------------------------------------------------------------
// These tests verify:
//   1. GET /auth/me/teams omits teams where the user has been deactivated
//      (findByUser now returns only active memberships)
//   2. autoJoinTeams does NOT auto-reactivate inactive memberships
//   3. autoJoinTeams keeps existing active membership (regression guard)
//   4. autoJoinTeams adds new user with no membership (regression guard)

describe('Auth API — removed-user behaviour (TDD: Handle removing user)', () => {
  const AUTH_TEAM_ID_A = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
  const AUTH_TEAM_ID_B = '00000000-0000-0000-0000-000000000012' as Team.TeamId;
  const AUTH_GUILD_A = '111111111111111111' as Discord.Snowflake;
  const AUTH_GUILD_B = '222222222222222222' as Discord.Snowflake;
  const AUTH_ROLE_ID = '00000000-0000-0000-0000-000000000050' as Role.RoleId;

  const teamA = {
    id: AUTH_TEAM_ID_A,
    name: 'Team A',
    guild_id: AUTH_GUILD_A,
    created_by: TEST_USER_ID,
    created_at: DateTime.nowUnsafe(),
    updated_at: DateTime.nowUnsafe(),
    logo_url: Option.none(),
    description: Option.none(),
    sport: Option.none(),
    welcome_channel_id: Option.none(),
    system_log_channel_id: Option.none(),
    welcome_message_template: Option.none(),
    rules_channel_id: Option.none(),
    achievement_channel_id: Option.none(),
    onboarding_rules_role_id: Option.none(),
    onboarding_rules_prompt_id: Option.none(),
    onboarding_locale: 'en' as const,
    onboarding_synced_at: Option.none(),
    onboarding_sync_status: 'pending' as const,
    onboarding_sync_error: Option.none(),
  };

  const activeMembershipA: MembershipWithDiscordState = {
    id: '00000000-0000-0000-0000-000000000060' as TeamMember.TeamMemberId,
    team_id: AUTH_TEAM_ID_A,
    user_id: TEST_USER_ID,
    active: true,
    role_names: ['Player'],
    permissions: ['roster:view'] as readonly Role.Permission[],
    discord_joined_at: Option.none(),
    members_backfilled_at: Option.none(),
  };

  const inactiveMembershipB: MembershipWithDiscordState = {
    id: '00000000-0000-0000-0000-000000000061' as TeamMember.TeamMemberId,
    team_id: AUTH_TEAM_ID_B,
    user_id: TEST_USER_ID,
    active: false,
    role_names: ['Player'],
    permissions: ['roster:view'] as readonly Role.Permission[],
    discord_joined_at: Option.none(),
    members_backfilled_at: Option.none(),
  };

  // Track addMember / reactivateMember calls in autoJoinTeams tests
  let autoJoinAddMemberCalled = false;
  let autoJoinReactivateCalled = false;

  // Helper to build a test layer with configurable findByUser and findMembershipByIds behaviour
  const buildAuthTestLayer = (opts: {
    findByUserResult: ReadonlyArray<MembershipWithDiscordState>;
    findMembershipByIdsResult: (
      teamId: Team.TeamId,
      userId: Auth.UserId,
      options?: { includeInactive?: boolean },
    ) => Option.Option<MembershipWithRole>;
    teamsToReturn?: ReadonlyArray<typeof teamA>;
    profileComplete?: boolean;
    guildIds?: ReadonlyArray<string>;
    // Blocker D — defaults to `true` (enforcement ON) so the pre-existing `discordJoined`
    // derivation tests below keep exercising `deriveDiscordJoined` for real. The kill-switch
    // tests explicitly pass `false`.
    discordJoinEnforcementEnabled?: boolean;
  }) => {
    const CustomMembersLayer = Layer.succeed(TeamMembersRepository, {
      _tag: 'api/TeamMembersRepository',
      addMember: (_input: any) => {
        autoJoinAddMemberCalled = true;
        return Effect.succeed({
          id: '00000000-0000-0000-0000-000000000062' as TeamMember.TeamMemberId,
          team_id: AUTH_TEAM_ID_A,
          user_id: TEST_USER_ID,
          active: true,
          jersey_number: Option.none(),
          joined_at: DateTime.nowUnsafe(),
        });
      },
      reactivateMember: (_memberId: any) => {
        autoJoinReactivateCalled = true;
        return Effect.succeed({
          id: '00000000-0000-0000-0000-000000000061' as TeamMember.TeamMemberId,
          team_id: AUTH_TEAM_ID_B,
          user_id: TEST_USER_ID,
          active: true,
          jersey_number: Option.none(),
          joined_at: DateTime.nowUnsafe(),
        });
      },
      findMembershipByIds: (
        teamId: Team.TeamId,
        userId: Auth.UserId,
        options?: { includeInactive?: boolean },
      ) => Effect.succeed(opts.findMembershipByIdsResult(teamId, userId, options)),
      findByTeam: () => Effect.succeed([]),
      findByUser: (_userId: string) => Effect.succeed(opts.findByUserResult),
      findRosterByTeam: () => Effect.succeed([]),
      findRosterMemberByIds: () => Effect.succeed(Option.none()),
      deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
      getPlayerRoleId: () => Effect.succeed(Option.some({ id: AUTH_ROLE_ID })),
      assignRole: () => Effect.void,
      unassignRole: () => Effect.void,
      setJerseyNumber: () => Effect.void,
    } as any);

    const CustomTeamsLayer = Layer.succeed(TeamsRepository, {
      _tag: 'api/TeamsRepository',
      findById: (id: Team.TeamId) => {
        const teams = opts.teamsToReturn ?? [teamA];
        const found = teams.find((t) => t.id === id);
        return Effect.succeed(found ? Option.some(found) : Option.none());
      },
      insert: () => Effect.succeed(teamA),
      findByGuildId: () => Effect.succeed(Option.none()),
      findByGuildIds: (guildIds: ReadonlyArray<Discord.Snowflake>) => {
        const teams = opts.teamsToReturn ?? [teamA];
        const matching = teams.filter((t) => guildIds.includes(t.guild_id as Discord.Snowflake));
        return Effect.succeed(matching);
      },
    } as any);

    const profileCompletedUser = { ...testUser, is_profile_complete: true };
    const CustomUsersLayer =
      opts.profileComplete === true
        ? Layer.succeed(UsersRepository, {
            _tag: 'api/UsersRepository',
            findById: (id: Auth.UserId) =>
              Effect.succeed(
                id === TEST_USER_ID ? Option.some(profileCompletedUser) : Option.none(),
              ),
            findByDiscordId: () => Effect.succeed(Option.none()),
            upsertFromDiscord: () => Effect.succeed(profileCompletedUser),
            completeProfile: () => Effect.succeed(profileCompletedUser),
            updateLocale: () => Effect.succeed(profileCompletedUser),
            updateAdminProfile: () => Effect.succeed(profileCompletedUser),
          } as any)
        : MockUsersRepositoryLayer;

    const guildList = (opts.guildIds ?? []).map((id) => ({
      id,
      name: `Guild ${id}`,
      owner: false,
      permissions: '0',
      features: [],
    }));
    const CustomHttpClientLayer =
      opts.guildIds !== undefined
        ? Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(JSON.stringify(guildList), {
                    status: 200,
                    headers: { 'Content-Type': 'application/json' },
                  }),
                ),
              ),
            ),
          )
        : MockHttpClientLayer;

    return ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(CustomUsersLayer),
      Layer.provide(MockSessionsRepositoryLayer),
      Layer.provide(CustomTeamsLayer),
      Layer.provide(CustomMembersLayer),
      Layer.provide(
        Layer.merge(
          Layer.merge(
            Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
            MockActivityTypesRepositoryLayer,
          ),
          MockLeaderboardRepositoryLayer,
        ),
      ),
      Layer.provide(MockRolesRepositoryLayer),
      Layer.provide(MockGroupsRepositoryLayer),
      Layer.provide(MockTrainingTypesRepositoryLayer),
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
              requeueFailedForUser: () => Effect.void,
            } as never),
            Layer.succeed(InviteAcceptancesRepository, {
              _tag: 'api/InviteAcceptancesRepository',
            } as never),
          ),
        ),
      ),
      Layer.provide(CustomHttpClientLayer),
      Layer.provide(MockAgeCheckServiceLayer),
      Layer.provide(MockAgeThresholdRepositoryLayer),
      Layer.provide(
        Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer),
      ),
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
          Layer.succeed(OAuthConnectionsRepository, {
            _tag: 'api/OAuthConnectionsRepository',
            upsertConnection: () => Effect.succeed({} as never),
            upsert: () => Effect.succeed({} as never),
            findByUserAndProvider: () => Effect.succeed(Option.none()),
            findByUser: () => Effect.succeed(Option.none()),
            findAccessToken: () =>
              Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
            getAccessToken: () => Effect.succeed(Option.some('mock-access-token')),
            getGrantedScopes: () => Effect.succeed(Option.some('identify guilds guilds.join')),
          } as any),
        ),
      ),
      Layer.provide(MockAchievementAdminLayers),
    )
      .pipe(Layer.provide(MockFinanceLayers))
      .pipe(Layer.provide(MockTranslationsLayers))
      .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
      .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
      .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
      .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
      .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
      .pipe(Layer.provide(MockChannelManagementLayers))
      .pipe(Layer.provide(MockEmailLayers))
      .pipe(Layer.provide(MockEventRosterLayers))
      .pipe(Layer.provide(BotInfoStore.Default))
      .pipe(
        Layer.provide(
          Layer.succeed(DiscordJoinEnforcementConfig, {
            asEffect: Effect.succeed(opts.discordJoinEnforcementEnabled ?? true),
          } as any),
        ),
      )
      .pipe(
        Layer.provide(
          Layer.succeed(GlobalAdminAllowlist, {
            asEffect: Effect.succeed(new Set<string>()),
          } as any),
        ),
      );
  };

  it('GET /auth/me/teams omits teams where user has been deactivated (findByUser returns only active)', async () => {
    // After the fix: findByUser returns only active memberships.
    // We mock it to return only activeMembershipA (team B's inactive row is excluded).
    const testLayer = buildAuthTestLayer({
      findByUserResult: [activeMembershipA],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;
    const response = await handler(
      new Request('http://localhost/auth/me/teams', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    // Only Team A (active membership) should be present
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
    expect(body[0].teamId).toBe(AUTH_TEAM_ID_A);
    // Team B must NOT be in the list (inactive membership excluded by findByUser)
    const hasTeamB = body.some((t: { teamId: string }) => t.teamId === AUTH_TEAM_ID_B);
    expect(hasTeamB).toBe(false);
  });

  // PR-9 (Discord onboarding fix), CC-15 — the tri-state gate. `discordJoined` is derived purely
  // from the two columns `findByUser` now selects; these three tests exercise it end-to-end
  // through the real HTTP handler (the pure derivation itself is unit-tested in
  // `test/unit/discordJoinedState.test.ts`).
  it("myTeams returns discordJoined 'connected' for a member with discord_joined_at set", async () => {
    const testLayer = buildAuthTestLayer({
      findByUserResult: [
        { ...activeMembershipA, discord_joined_at: Option.some(DateTime.nowUnsafe()) },
      ],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;
    const response = await handler(
      new Request('http://localhost/auth/me/teams', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].discordJoined).toBe('connected');
  });

  it("myTeams returns 'not_connected' only when the guild has members_backfilled_at set", async () => {
    const testLayer = buildAuthTestLayer({
      findByUserResult: [
        {
          ...activeMembershipA,
          discord_joined_at: Option.none(),
          members_backfilled_at: Option.some(DateTime.nowUnsafe()),
        },
      ],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;
    const response = await handler(
      new Request('http://localhost/auth/me/teams', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].discordJoined).toBe('not_connected');
  });

  // Blocker D (whole-series review) — the kill switch the PR-9 rollout plan requires before the
  // enforcement redirect goes live: a server-side flag that forces `discordJoined` to 'unknown'
  // for every team, instantly removing the redirect, the card, and the badge on the client.
  // Deliberately reuses the exact fixture from the 'not_connected' test above (backfilled guild,
  // no `discord_joined_at`) — the case the anti-lockout guard already protects — to prove the
  // kill switch overrides `deriveDiscordJoined` entirely rather than merely agreeing with it in
  // the 'unknown' case by coincidence.
  it("myTeams forces discordJoined to 'unknown' when the kill switch is off, even for a backfilled guild with no discord_joined_at", async () => {
    const testLayer = buildAuthTestLayer({
      findByUserResult: [
        {
          ...activeMembershipA,
          discord_joined_at: Option.none(),
          members_backfilled_at: Option.some(DateTime.nowUnsafe()),
        },
      ],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
      discordJoinEnforcementEnabled: false,
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;
    const response = await handler(
      new Request('http://localhost/auth/me/teams', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].discordJoined).toBe('unknown');
  });

  // The anti-lockout guard: a guild whose backfill never completed must NEVER read as
  // 'not_connected' — that would be a hard gate on an unknown signal, which is what turns this
  // gate into a lockout for an existing, working user base.
  it("myTeams returns 'unknown' for a guild whose backfill never completed", async () => {
    const testLayer = buildAuthTestLayer({
      findByUserResult: [
        {
          ...activeMembershipA,
          discord_joined_at: Option.none(),
          members_backfilled_at: Option.none(),
        },
      ],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;
    const response = await handler(
      new Request('http://localhost/auth/me/teams', {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body[0].discordJoined).toBe('unknown');
  });

  it('autoJoinTeams does NOT call addMember or reactivateMember for inactive membership', async () => {
    autoJoinAddMemberCalled = false;
    autoJoinReactivateCalled = false;

    // Profile complete + Discord OAuth token + guild matches teamB
    // findMembershipByIds({ includeInactive: true }) returns inactiveMembershipB
    // → tryJoinTeam must return Option.none and NOT call addMember or reactivateMember
    const testLayer = buildAuthTestLayer({
      findByUserResult: [],
      findMembershipByIdsResult: (
        _teamId: Team.TeamId,
        _userId: Auth.UserId,
        options?: { includeInactive?: boolean },
      ) => (options?.includeInactive === true ? Option.some(inactiveMembershipB) : Option.none()),
      teamsToReturn: [{ ...teamA, id: AUTH_TEAM_ID_B, guild_id: AUTH_GUILD_B, name: 'Team B' }],
      profileComplete: true,
      guildIds: [AUTH_GUILD_B],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;

    const response = await handler(
      new Request('http://localhost/auth/me/teams/auto-join', {
        method: 'POST',
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    // The removed team must NOT appear in the auto-join result
    const hasTeamB = body.some((t: { teamId: string }) => t.teamId === AUTH_TEAM_ID_B);
    expect(hasTeamB).toBe(false);
    // addMember and reactivateMember must NOT have been called
    expect(autoJoinAddMemberCalled).toBe(false);
    expect(autoJoinReactivateCalled).toBe(false);
  });

  it('autoJoinTeams keeps existing active membership and does NOT call addMember or reactivateMember (regression guard)', async () => {
    autoJoinAddMemberCalled = false;
    autoJoinReactivateCalled = false;

    // Profile complete + Discord OAuth token + guild matches teamA
    // findMembershipByIds({ includeInactive: true }) returns activeMembershipA (active: true)
    // → onSome branch returns Option.none (no join needed), addMember/reactivateMember NOT called
    const testLayer = buildAuthTestLayer({
      findByUserResult: [activeMembershipA],
      findMembershipByIdsResult: (
        _teamId: Team.TeamId,
        _userId: Auth.UserId,
        options?: { includeInactive?: boolean },
      ) => (options?.includeInactive === true ? Option.some(activeMembershipA) : Option.none()),
      teamsToReturn: [teamA],
      profileComplete: true,
      guildIds: [AUTH_GUILD_A],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;

    const response = await handler(
      new Request('http://localhost/auth/me/teams/auto-join', {
        method: 'POST',
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    // addMember and reactivateMember must NOT have been called
    expect(autoJoinAddMemberCalled).toBe(false);
    expect(autoJoinReactivateCalled).toBe(false);
  });

  it('autoJoinTeams calls addMember when user has no existing membership', async () => {
    autoJoinAddMemberCalled = false;
    autoJoinReactivateCalled = false;

    // Profile complete + Discord OAuth token + guild matches teamA
    // findMembershipByIds returns None (even with includeInactive: true)
    // → tryJoinTeam must call addMember and return the new team
    const testLayer = buildAuthTestLayer({
      findByUserResult: [],
      findMembershipByIdsResult: () => Option.none(),
      teamsToReturn: [teamA],
      profileComplete: true,
      guildIds: [AUTH_GUILD_A],
    });

    const app = HttpRouter.toWebHandler(testLayer);
    const handler = app.handler as (...args: any[]) => Promise<Response>;

    const response = await handler(
      new Request('http://localhost/auth/me/teams/auto-join', {
        method: 'POST',
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    // addMember should have been called
    expect(autoJoinAddMemberCalled).toBe(true);
    expect(autoJoinReactivateCalled).toBe(false);
    // The newly joined team should appear in the result
    const hasTeamA = body.some((t: { teamId: string }) => t.teamId === AUTH_TEAM_ID_A);
    expect(hasTeamA).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// TDD: Global admin read access
// ---------------------------------------------------------------------------
// These tests verify that a global admin user who is NOT a member of a team
// can still access read-only endpoints (member:view, roster:view, role:view)
// but is denied access to write endpoints.

describe('Global admin read access', () => {
  const globalAdminUser = {
    ...testUser,
    is_global_admin: true,
    discord_id: 'global-admin-discord-id',
  };

  const GlobalAdminUsersRepositoryLayer = Layer.succeed(UsersRepository, {
    _tag: 'api/UsersRepository',
    findById: (id: Auth.UserId) =>
      Effect.succeed(id === TEST_USER_ID ? Option.some(globalAdminUser) : Option.none()),
    findByDiscordId: () => Effect.succeed(Option.none()),
    upsertFromDiscord: () => Effect.succeed(globalAdminUser),
    completeProfile: () => Effect.succeed(globalAdminUser),
    updateLocale: () => Effect.succeed(globalAdminUser),
    updateAdminProfile: () => Effect.succeed(globalAdminUser),
  } as any);

  // TeamMembersRepository where the global admin is NOT a member
  const GlobalAdminNonMemberLayer = Layer.succeed(TeamMembersRepository, {
    _tag: 'api/TeamMembersRepository',
    addMember: () => Effect.die(new Error('Not implemented')),
    findMembershipByIds: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findRosterMemberByIds: () => Effect.succeed(Option.none()),
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_ROLE_ID })),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
  } as any);

  const buildGlobalAdminLayer = () =>
    ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(GlobalAdminUsersRepositoryLayer),
      Layer.provide(MockSessionsRepositoryLayer),
      Layer.provide(MockTeamsRepositoryLayer),
      Layer.provide(GlobalAdminNonMemberLayer),
      Layer.provide(
        Layer.merge(
          Layer.merge(
            Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
            MockActivityTypesRepositoryLayer,
          ),
          MockLeaderboardRepositoryLayer,
        ),
      ),
      Layer.provide(MockRolesRepositoryLayer),
      Layer.provide(MockGroupsRepositoryLayer),
      Layer.provide(MockTrainingTypesRepositoryLayer),
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
              requeueFailedForUser: () => Effect.void,
            } as never),
            Layer.succeed(InviteAcceptancesRepository, {
              _tag: 'api/InviteAcceptancesRepository',
            } as never),
          ),
        ),
      ),
      Layer.provide(MockHttpClientLayer),
      Layer.provide(MockAgeCheckServiceLayer),
      Layer.provide(MockAgeThresholdRepositoryLayer),
      Layer.provide(
        Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer),
      ),
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
      .pipe(Layer.provide(MockTranslationsLayers))
      .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
      .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
      .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
      .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
      .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
      .pipe(Layer.provide(MockChannelManagementLayers))
      .pipe(Layer.provide(MockEmailLayers))
      .pipe(Layer.provide(MockEventRosterLayers))
      .pipe(Layer.provide(BotInfoStore.Default))
      .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
      .pipe(
        Layer.provide(
          Layer.succeed(GlobalAdminAllowlist, {
            asEffect: Effect.succeed(new Set<string>()),
          } as any),
        ),
      );

  it('global admin non-member can GET /teams/:id/members → 200', async () => {
    const testLayer = buildGlobalAdminLayer();
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members`, {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
  });

  it('non-admin non-member → 403 (regression guard)', async () => {
    // The base TestLayer uses MockTeamMembersRepositoryLayer which returns Option.none() for findMembershipByIds
    // and testUser has is_global_admin: false → should get 403
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members`, {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );

    expect(response.status).toBe(403);
  });

  it('global admin non-member calling write endpoint POST /teams/:id/roles → 403', async () => {
    const testLayer = buildGlobalAdminLayer();
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer pre-existing-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'Test Role', permissions: [] }),
      }),
    );
    await app.dispose();

    expect(response.status).toBe(403);
  });

  it('global admin non-member can GET /teams/:id/roles → 200', async () => {
    const testLayer = buildGlobalAdminLayer();
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles`, {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
  });

  it('global admin non-member can GET /teams/:id/fees → 200', async () => {
    const testLayer = buildGlobalAdminLayer();
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/fees`, {
        headers: { Authorization: 'Bearer pre-existing-token' },
      }),
    );
    await app.dispose();

    expect(response.status).toBe(200);
  });

  it('global admin non-member calling POST /teams/:id/fees → 403', async () => {
    const testLayer = buildGlobalAdminLayer();
    const app = HttpRouter.toWebHandler(testLayer);
    const h = app.handler as (...args: any[]) => Promise<Response>;

    const response = await h(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/fees`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer pre-existing-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Test Fee',
          description: null,
          amountMinor: 1000,
          currency: 'CZK',
          dueAt: null,
          targetScope: 'custom',
        }),
      }),
    );
    await app.dispose();

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// TDD for PR-4 (Discord onboarding fix), CC-6/S5 — `auth.ts`'s requeue condition is too
// narrow. Today it gates `requeueFailedForUser` on `hasScopeNow && !hadScopeBefore` (a scope
// *transition*). But the dominant auto-join failure is a 401 on an expired OAuth access
// token (S2 — tokens are never refreshed, and expire in ~7 days while sessions last 30), and
// that user already had `guilds.join` before this login — so the transition is false and the
// requeue never fires on the exact login that just wrote a fresh token. PR-4 fixes this by
// dropping the transition condition: requeue whenever `hasScopeNow` is true, unconditionally
// on `hadScopeBefore`.
//
// `MockOAuthConnectionsRepositoryLayer.getGrantedScopes` (used by `TestLayer` above and
// reused here) always returns 'identify guilds guilds.join' for BOTH the "previous" and
// "current" scope reads, so `hasScopeNow === hadScopeBefore === true` — an unchanged-scope
// login. This test MUST FAIL against current code: `hasScopeNow && !hadScopeBefore` is false,
// so `requeueFailedForUser` is never called.
// See `.work-plans/discord-onboarding-fix-plan.md`, PR-4 test list item 17.
// ---------------------------------------------------------------------------
describe('Auth API — requeueFailedForUser widening (TDD: PR-4 CC-6/S5)', () => {
  let requeueCalls: Array<Auth.UserId>;
  // BLOCKER 3 / should-fix 10: lets individual tests drive the two mocks that gate/guard the
  // requeue tap without duplicating the whole layer stack per scenario.
  let s5RequeueShouldDie: boolean;
  let s5OAuthScope: string;

  const S5DiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
    createAuthorizationURL: (_state: string) =>
      Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
    validateAuthorizationCode: (code: string) =>
      code === 'valid-code'
        ? Effect.succeed(
            new OAuth2Tokens({
              access_token: 'mock-access-token',
              refresh_token: 'mock-refresh-token',
              scope: s5OAuthScope,
            }),
          )
        : Effect.fail(new DiscordOAuthError({ cause: new Error('Invalid code') })),
  });

  const S5TestLayer = ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(S5DiscordOAuthLayer),
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
    Layer.provide(MockRolesRepositoryLayer),
    Layer.provide(MockGroupsRepositoryLayer),
    Layer.provide(MockTrainingTypesRepositoryLayer),
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
            requeueFailedForUser: (userId: Auth.UserId) => {
              requeueCalls.push(userId);
              // BLOCKER 3: simulates `catchSqlErrors` turning a `SqlError` into a `LogicError`
              // defect — exactly what a failing UPDATE looks like in production.
              return s5RequeueShouldDie
                ? Effect.die(new Error('simulated requeueFailedForUser failure'))
                : Effect.void;
            },
          } as never),
          Layer.succeed(InviteAcceptancesRepository, {
            _tag: 'api/InviteAcceptancesRepository',
          } as never),
        ),
      ),
    ),
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
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
      ),
    );

  let s5Handler: (...args: any[]) => Promise<Response>;
  let s5Dispose: () => Promise<void>;

  beforeAll(() => {
    const app = HttpRouter.toWebHandler(S5TestLayer);
    s5Handler = app.handler;
    s5Dispose = app.dispose;
  });

  afterAll(async () => {
    await s5Dispose();
  });

  it('a login with an unchanged guilds.join scope still requeues failed guild joins', async () => {
    requeueCalls = [];
    s5RequeueShouldDie = false;
    s5OAuthScope = 'identify guilds guilds.join';

    const response = await s5Handler(
      new Request(
        'http://localhost/auth/callback?code=valid-code&state=%7B%22id%22%3A%22d5760fa3-5440-4f87-8136-f5c1109aaea0%22%2C%20%22redirectUrl%22%3A%22http%3A%2F%2Flocalhost%3A5173%2Fredirect%22%7D',
      ),
    );

    expect(response.status).toBe(302);
    expect(requeueCalls.length).toBe(1);
    expect(requeueCalls[0]).toBe(TEST_USER_ID);
  });

  // Should-fix 10: the negative case the tester flagged as missing — `requeueFailedForUser`
  // must NOT be called at all when the OAuth response does not grant `guilds.join`.
  it('does NOT call requeueFailedForUser when hasScopeNow is false', async () => {
    requeueCalls = [];
    s5RequeueShouldDie = false;
    s5OAuthScope = 'identify guilds'; // no guilds.join

    const response = await s5Handler(
      new Request(
        'http://localhost/auth/callback?code=valid-code&state=%7B%22id%22%3A%22d5760fa3-5440-4f87-8136-f5c1109aaea0%22%2C%20%22redirectUrl%22%3A%22http%3A%2F%2Flocalhost%3A5173%2Fredirect%22%7D',
      ),
    );

    expect(response.status).toBe(302);
    expect(requeueCalls.length).toBe(0);
  });

  // BLOCKER 3 (review of PR-4): the requeue tap sits in an `Effect.tap` BEFORE `sessions.create`,
  // and `catchSqlErrors` converts a `SqlError` into a `LogicError` DEFECT, not a typed error — so
  // any failure of this best-effort UPDATE kills the whole request and nobody logs in. This ran
  // roughly once per user ever before CC-6/S5 widened the condition to fire on every login with
  // `guilds.join`, so it is now a much larger blast radius. FAILS before the fix (the defect
  // propagates and the response is a 500, not the 302 redirect a successful login produces).
  it('a login still succeeds even when requeueFailedForUser fails', async () => {
    requeueCalls = [];
    s5RequeueShouldDie = true;
    s5OAuthScope = 'identify guilds guilds.join';

    const response = await s5Handler(
      new Request(
        'http://localhost/auth/callback?code=valid-code&state=%7B%22id%22%3A%22d5760fa3-5440-4f87-8136-f5c1109aaea0%22%2C%20%22redirectUrl%22%3A%22http%3A%2F%2Flocalhost%3A5173%2Fredirect%22%7D',
      ),
    );

    expect(response.status).toBe(302);
    expect(requeueCalls.length).toBe(1);
  });
});
