// TDD mode — tests written BEFORE the listMemberAssignments handler exists.
// These tests WILL FAIL until the developer implements:
//   - applications/server/src/api/finance.ts: add .handle('listMemberAssignments', ...) which
//     requires finance:view and calls FeeAssignmentsRepository.findByTeamMember(memberId).
//
// The domain already has the endpoint defined at:
//   GET /teams/:teamId/members/:memberId/assignments → Schema.Array(FeeAssignmentView)
//
// Reuses the same TestLayer pattern as finance.test.ts (integration/api).

import type { Auth, Fee, FeeAssignment, Role, Team, TeamMember } from '@sideline/domain';
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
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import {
  type AssignmentViewRow,
  FeeAssignmentsRepository,
} from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
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
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_TREASURER_USER_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_PLAYER_USER_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const TEST_TREASURER_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;
const TEST_PLAYER_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_FOREIGN_MEMBER_ID = '00000000-0000-0000-0000-000000000055' as TeamMember.TeamMemberId;
const TEST_FEE_ID = '00000000-0000-0000-0000-000000000030' as Fee.FeeId;
const TEST_ASSIGNMENT_ID_1 =
  '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const TEST_ASSIGNMENT_ID_2 =
  '00000000-0000-0000-0000-000000000041' as FeeAssignment.FeeAssignmentId;

const TREASURER_PERMISSIONS: readonly Role.Permission[] = [
  'finance:view',
  'finance:manage_fees',
  'finance:record_payments',
];
const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['member:view', 'roster:view'];

// ---------------------------------------------------------------------------
// In-memory assignment store — controlled per test
// ---------------------------------------------------------------------------

type AssignmentRecord = AssignmentViewRow;

let assignmentsStore: Map<FeeAssignment.FeeAssignmentId, AssignmentRecord>;

const now = DateTime.nowUnsafe();

const sampleAssignment1: AssignmentRecord = {
  id: TEST_ASSIGNMENT_ID_1,
  fee_id: TEST_FEE_ID,
  team_member_id: TEST_PLAYER_MEMBER_ID,
  amount_minor: 5000 as Fee.AmountMinor,
  paid_minor: 0 as Fee.AmountMinor,
  due_at: Option.none(),
  stored_status: 'active' as FeeAssignment.StoredAssignmentStatus,
  waived_reason: Option.none(),
  created_at: now,
  updated_at: now,
  fee_name: 'Annual Fee',
  currency: 'CZK' as Fee.CurrencyCode,
  due_minor: 5000 as Fee.AmountMinor,
  effective_due_at: Option.none(),
  computed_status: 'pending' as FeeAssignment.FeeAssignmentStatus,
  member_name: Option.some('Player One'),
};

const sampleAssignment2: AssignmentRecord = {
  id: TEST_ASSIGNMENT_ID_2,
  fee_id: TEST_FEE_ID,
  team_member_id: TEST_PLAYER_MEMBER_ID,
  amount_minor: 2000 as Fee.AmountMinor,
  paid_minor: 2000 as Fee.AmountMinor,
  due_at: Option.none(),
  stored_status: 'active' as FeeAssignment.StoredAssignmentStatus,
  waived_reason: Option.none(),
  created_at: now,
  updated_at: now,
  fee_name: 'Equipment Fee',
  currency: 'CZK' as Fee.CurrencyCode,
  due_minor: 2000 as Fee.AmountMinor,
  effective_due_at: Option.none(),
  computed_status: 'paid' as FeeAssignment.FeeAssignmentStatus,
  member_name: Option.some('Player One'),
};

const resetStores = () => {
  assignmentsStore = new Map([
    [TEST_ASSIGNMENT_ID_1, sampleAssignment1],
    [TEST_ASSIGNMENT_ID_2, sampleAssignment2],
  ]);
};

// ---------------------------------------------------------------------------
// Auth stores
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['treasurer-token', TEST_TREASURER_USER_ID],
  ['player-token', TEST_PLAYER_USER_ID],
]);

const usersMap = new Map<Auth.UserId, any>([
  [
    TEST_TREASURER_USER_ID,
    {
      id: TEST_TREASURER_USER_ID,
      discord_id: '333',
      username: 'treasurer',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    TEST_PLAYER_USER_ID,
    {
      id: TEST_PLAYER_USER_ID,
      discord_id: '222',
      username: 'player',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
]);

const membersStore = new Map<TeamMember.TeamMemberId, MembershipWithRole>([
  [
    TEST_TREASURER_MEMBER_ID,
    {
      id: TEST_TREASURER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_TREASURER_USER_ID,
      active: true,
      role_names: ['Treasurer'],
      permissions: TREASURER_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
  [
    TEST_PLAYER_MEMBER_ID,
    {
      id: TEST_PLAYER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_PLAYER_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
]);

// Simple team-member-by-id store for cross-team guard testing
const teamMemberById = new Map<
  TeamMember.TeamMemberId,
  { id: TeamMember.TeamMemberId; team_id: Team.TeamId; active: boolean }
>([
  [TEST_TREASURER_MEMBER_ID, { id: TEST_TREASURER_MEMBER_ID, team_id: TEST_TEAM_ID, active: true }],
  [TEST_PLAYER_MEMBER_ID, { id: TEST_PLAYER_MEMBER_ID, team_id: TEST_TEAM_ID, active: true }],
  [
    TEST_FOREIGN_MEMBER_ID,
    { id: TEST_FOREIGN_MEMBER_ID, team_id: TEST_OTHER_TEAM_ID, active: true },
  ],
]);

// ---------------------------------------------------------------------------
// Mock repositories
// ---------------------------------------------------------------------------

const MockFeeAssignmentsRepositoryLayer = Layer.succeed(FeeAssignmentsRepository, {
  _tag: 'api/FeeAssignmentsRepository',
  findById: (id: FeeAssignment.FeeAssignmentId) =>
    Effect.succeed(
      assignmentsStore.has(id) ? Option.some(assignmentsStore.get(id)!) : Option.none(),
    ),
  findByFee: (feeId: Fee.FeeId) =>
    Effect.succeed(Array.from(assignmentsStore.values()).filter((a) => a.fee_id === feeId)),
  findByTeamMember: (memberId: TeamMember.TeamMemberId) =>
    Effect.succeed(
      Array.from(assignmentsStore.values()).filter((a) => a.team_member_id === memberId),
    ),
  findByFeeAndMember: (feeId: Fee.FeeId, memberId: TeamMember.TeamMemberId) =>
    Effect.succeed(
      Array.from(assignmentsStore.values()).find(
        (a) => a.fee_id === feeId && a.team_member_id === memberId,
      )
        ? Option.some(
            Array.from(assignmentsStore.values()).find(
              (a) => a.fee_id === feeId && a.team_member_id === memberId,
            )!,
          )
        : Option.none(),
    ),
  bulkInsert: () => Effect.succeed([]),
  update: () => Effect.die(new Error('Not implemented')),
} as any);

// Minimal stubs
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: () =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(new OAuth2Tokens({ access_token: 'mock', refresh_token: 'mock' })),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) =>
    Effect.succeed(usersMap.has(id) ? Option.some(usersMap.get(id)!) : Option.none()),
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
      Option.some({ id: 'session-1', user_id: userId, token, expires_at: now, created_at: now }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Finance Test Team',
  guild_id: '999',
  created_by: TEST_TREASURER_USER_ID,
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
  findById: (id: TeamMember.TeamMemberId) =>
    Effect.succeed(teamMemberById.has(id) ? Option.some(teamMemberById.get(id)!) : Option.none()),
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

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockFeeAssignmentsRepositoryLayer),
  Layer.provide(
    Layer.succeed(
      FeesRepository,
      buildNoop('api/FeesRepository', {
        insert: () => Effect.die(new Error('Not implemented')),
        findById: () => Effect.succeed(Option.none()),
        findByIdAny: () => Effect.succeed(Option.none()),
        findWithCountsById: () => Effect.succeed(Option.none()),
        listByTeam: () => Effect.succeed([]),
        update: () => Effect.die(new Error('Not implemented')),
        archive: () => Effect.void,
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      PaymentsRepository,
      buildNoop('api/PaymentsRepository', {
        insert: () => Effect.die(new Error('Not implemented')),
        findById: () => Effect.succeed(Option.none()),
        findActiveById: () => Effect.succeed(Option.none()),
        findActiveByIdAndTeam: () => Effect.succeed(Option.none()),
        void_: () => Effect.void,
        listByTeam: () => Effect.succeed([]),
        hardDeleteForTest: () => Effect.void,
      }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      FinanceOverviewRepository,
      buildNoop('api/FinanceOverviewRepository', {
        overviewByTeam: () => Effect.succeed([]),
      }),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ActivityLogsRepository,
        buildNoop('api/ActivityLogsRepository', { findByTeamMember: () => Effect.succeed([]) }),
      ),
      Layer.succeed(
        ActivityTypesRepository,
        buildNoop('api/ActivityTypesRepository', {
          findBySlug: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findByIdScoped: () => Effect.succeed(Option.none()),
          findByNameInScope: () => Effect.succeed(Option.none()),
          countLogsForType: () => Effect.succeed(0),
        }),
      ),
      Layer.succeed(
        LeaderboardRepository,
        buildNoop('api/LeaderboardRepository', { getLeaderboard: () => Effect.succeed([]) }),
      ),
      Layer.succeed(
        RostersRepository,
        buildNoop('api/RostersRepository', {
          findByTeamId: () => Effect.succeed([]),
          findRosterById: () => Effect.succeed(Option.none()),
          findMemberEntriesById: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        TeamInvitesRepository,
        buildNoop('api/TeamInvitesRepository', {
          findByCode: () => Effect.succeed(Option.none()),
          findByTeam: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        PendingGuildJoinsRepository,
        buildNoop('api/PendingGuildJoinsRepository', {
          listPending: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(InviteAcceptancesRepository, buildNoop('api/InviteAcceptancesRepository')),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        RolesRepository,
        buildNoop('api/RolesRepository', {
          findRolesByTeamId: () => Effect.succeed([]),
          findRoleById: () => Effect.succeed(Option.none()),
          getPermissionsForRoleId: () => Effect.succeed([]),
          findRoleByTeamAndName: () => Effect.succeed(Option.none()),
          seedTeamRolesWithPermissions: () => Effect.succeed([]),
          getMemberCountForRole: () => Effect.succeed(0),
          findGroupsForRole: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        GroupsRepository,
        buildNoop('api/GroupsRepository', {
          findGroupsByTeamId: () => Effect.succeed([]),
          findGroupById: () => Effect.succeed(Option.none()),
          findMembersByGroupId: () => Effect.succeed([]),
          getMemberCount: () => Effect.succeed(0),
          getChildren: () => Effect.succeed([]),
          getAncestorIds: () => Effect.succeed([]),
          getDescendantMemberIds: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        TrainingTypesRepository,
        buildNoop('api/TrainingTypesRepository', {
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findByIdWithGroup: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        AgeCheckService,
        buildNoop('AgeCheckService', {
          evaluateTeam: () => Effect.succeed([]),
          evaluate: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        AgeThresholdRepository,
        buildNoop('api/AgeThresholdRepository', {
          findByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findAllTeamsWithRules: () => Effect.succeed([]),
          findMembersWithBirthYears: () => Effect.succeed([]),
          findRulesByTeamId: () => Effect.succeed([]),
          findRuleById: () => Effect.succeed(Option.none()),
          getAllTeamsWithRules: () => Effect.succeed([]),
          getMembersForAutoAssignment: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        NotificationsRepository,
        buildNoop('api/NotificationsRepository', {
          findByUserId: () => Effect.succeed([]),
          findOneById: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        RoleSyncEventsRepository,
        buildNoop('api/RoleSyncEventsRepository', {
          findUnprocessed: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        ChannelSyncEventsRepository,
        buildNoop('api/ChannelSyncEventsRepository', {
          findUnprocessed: () => Effect.succeed([]),
          hasUnprocessedForGroups: () => Effect.succeed([]),
          hasUnprocessedForRosters: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        EventSyncEventsRepository,
        buildNoop('api/EventSyncEventsRepository', {
          findUnprocessed: () => Effect.succeed([]),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        DiscordChannelMappingRepository,
        buildNoop('api/DiscordChannelMappingRepository', {
          findByGroupId: () => Effect.succeed(Option.none()),
          findAllByTeamId: () => Effect.succeed([]),
          findAllByTeam: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        ICalTokensRepository,
        buildNoop('api/ICalTokensRepository', {
          findByToken: () => Effect.succeed(Option.none()),
          findByUserId: () => Effect.succeed(Option.none()),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        EventsRepository,
        buildNoop('api/EventsRepository', {
          findByTeamId: () => Effect.succeed([]),
          findEventsByTeamId: () => Effect.succeed([]),
          findByIdWithDetails: () => Effect.succeed(Option.none()),
          findEventByIdWithDetails: () => Effect.succeed(Option.none()),
          findScopedTrainingTypeIds: () => Effect.succeed([]),
          getScopedTrainingTypeIds: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        EventRsvpsRepository,
        buildNoop('api/EventRsvpsRepository', {
          findByEventId: () => Effect.succeed([]),
          findRsvpsByEventId: () => Effect.succeed([]),
          findByEventAndMember: () => Effect.succeed(Option.none()),
          findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
          countByEventId: () => Effect.succeed([]),
          countRsvpsByEventId: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        BotGuildsRepository,
        buildNoop('api/BotGuildsRepository', {
          exists: () => Effect.succeed(false),
          findAll: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        DiscordChannelsRepository,
        buildNoop('api/DiscordChannelsRepository', {
          findByGuildId: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(DiscordRolesRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      Layer.succeed(
        EventSeriesRepository,
        buildNoop('api/EventSeriesRepository', {
          findByTeamId: () => Effect.succeed([]),
          findSeriesByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findSeriesById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        TeamSettingsRepository,
        buildNoop('api/TeamSettingsRepository', {
          findByTeam: () => Effect.succeed(Option.none()),
          findByTeamId: () => Effect.succeed(Option.none()),
          getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
          getHorizonDays: () => Effect.succeed(30),
        }),
      ),
      Layer.succeed(
        OAuthConnectionsRepository,
        buildNoop('api/OAuthConnectionsRepository', {
          findByUserAndProvider: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed(Option.none()),
          findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock' })),
          getAccessToken: () => Effect.succeed('mock'),
        }),
      ),
    ),
  ),
  Layer.provide(
    Layer.mergeAll(
      Layer.succeed(
        AchievementRoleMappingsRepository,
        buildNoop('api/AchievementRoleMappingsRepository', {
          findAllByTeam: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        AchievementSettingsRepository,
        buildNoop('api/AchievementSettingsRepository', {
          findOverridesByTeam: () => Effect.succeed(new Map()),
        }),
      ),
      Layer.succeed(
        CustomAchievementsRepository,
        buildNoop('api/CustomAchievementsRepository', {
          findByTeam: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        DiscordRoleProvisionEventsRepository,
        buildNoop('api/DiscordRoleProvisionEventsRepository', {
          findUnprocessed: () => Effect.succeed([]),
        }),
      ),
      Layer.succeed(
        AchievementPreview,
        buildNoop('AchievementPreview', {
          preview: () =>
            Effect.succeed({ qualifyingCount: 0, removedMembers: [], botCanManageRoles: true }),
        }),
      ),
    ),
  ),
)
  .pipe(Layer.provide(Layer.succeed(ExpensesRepository, buildNoop('api/ExpensesRepository'))))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(BotInfoStore.Default));

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
  resetStores();
});

const memberAssignmentsUrl = (memberId: TeamMember.TeamMemberId) =>
  `http://localhost/teams/${TEST_TEAM_ID}/members/${memberId}/assignments`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Finance API — listMemberAssignments', () => {
  it('happy path: returns FeeAssignmentView[] for the given member', async () => {
    const response = await handler(
      new Request(memberAssignmentsUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);
    // Verify view shape
    expect(body[0].assignmentId).toBeTruthy();
    expect(body[0].feeId).toBe(TEST_FEE_ID);
    expect(body[0].teamMemberId).toBe(TEST_PLAYER_MEMBER_ID);
    expect(body[0].feeName).toBeTruthy();
    expect(typeof body[0].dueMinor).toBe('number');
    expect(typeof body[0].paidMinor).toBe('number');
    expect(body[0].status).toBeTruthy();
  });

  it('returns empty array (not 404) when member has no assignments', async () => {
    // Clear the assignments for the player
    assignmentsStore.clear();

    const response = await handler(
      new Request(memberAssignmentsUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('permission gate: player without finance:view gets 403 FinanceForbidden', async () => {
    const response = await handler(
      new Request(memberAssignmentsUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/FinanceForbidden/i);
  });

  it('unauthenticated request returns 401', async () => {
    const response = await handler(new Request(memberAssignmentsUrl(TEST_PLAYER_MEMBER_ID)));
    expect(response.status).toBe(401);
  });

  it('foreign team member (belongs to another team) returns empty array', async () => {
    const response = await handler(
      new Request(memberAssignmentsUrl(TEST_FOREIGN_MEMBER_ID), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('mapped view contains correct assignment data (status, amounts, names)', async () => {
    const response = await handler(
      new Request(memberAssignmentsUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body: any[] = await response.json();

    const pending = body.find((a: any) => a.assignmentId === TEST_ASSIGNMENT_ID_1);
    const paid = body.find((a: any) => a.assignmentId === TEST_ASSIGNMENT_ID_2);

    expect(pending).toBeDefined();
    expect(pending.status).toBe('pending');
    expect(pending.dueMinor).toBe(5000);
    expect(pending.feeName).toBe('Annual Fee');

    expect(paid).toBeDefined();
    expect(paid.status).toBe('paid');
    expect(paid.dueMinor).toBe(2000);
    expect(paid.paidMinor).toBe(2000);
    expect(paid.feeName).toBe('Equipment Fee');
  });
});
