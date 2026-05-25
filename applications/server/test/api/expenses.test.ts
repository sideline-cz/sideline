import type { Auth, Role, Team, TeamMember } from '@sideline/domain';
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
import type { ExpenseWithNamesRow } from '~/repositories/ExpensesRepository.js';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
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
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';
import { MockWeeklyChallengeRepositoryLayer } from '../mocks/weeklyChallengeMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_TREASURER_USER_ID = '00000000-0000-0000-0001-000000000001' as Auth.UserId;
const TEST_VIEWER_USER_ID = '00000000-0000-0000-0001-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0001-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0001-000000000020' as Team.TeamId;
const TEST_TREASURER_MEMBER_ID = '00000000-0000-0000-0001-000000000011' as TeamMember.TeamMemberId;
const TEST_VIEWER_MEMBER_ID = '00000000-0000-0000-0001-000000000012' as TeamMember.TeamMemberId;

const MANAGE_FEES_PERMISSIONS: readonly Role.Permission[] = [
  'finance:view',
  'finance:manage_fees',
  'finance:record_payments',
];

const VIEW_ONLY_PERMISSIONS: readonly Role.Permission[] = ['finance:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const now = DateTime.nowUnsafe();

let expensesStore: Map<string, any>;
let nextExpenseId = 1;

const makeExpenseId = () => `00000000-0000-0000-0001-${String(nextExpenseId++).padStart(12, '0')}`;

const resetStores = () => {
  expensesStore = new Map();
  nextExpenseId = 1;
};

// ---------------------------------------------------------------------------
// Auth stores
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['treasurer-token', TEST_TREASURER_USER_ID],
  ['viewer-token', TEST_VIEWER_USER_ID],
]);

const usersMap = new Map<Auth.UserId, any>([
  [
    TEST_TREASURER_USER_ID,
    {
      id: TEST_TREASURER_USER_ID,
      discord_id: '111',
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
    TEST_VIEWER_USER_ID,
    {
      id: TEST_VIEWER_USER_ID,
      discord_id: '222',
      username: 'viewer',
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
      permissions: MANAGE_FEES_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
  [
    TEST_VIEWER_MEMBER_ID,
    {
      id: TEST_VIEWER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_VIEWER_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: VIEW_ONLY_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
]);

// ---------------------------------------------------------------------------
// Noop builder
// ---------------------------------------------------------------------------

const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

// ---------------------------------------------------------------------------
// Mock ExpensesRepository
// ---------------------------------------------------------------------------

// Returns an ExpenseWithNamesRow-shaped object (snake_case, matching the real repository output).
const makeExpenseRow = (
  id: string,
  teamId: string,
  userId: Auth.UserId,
  overrides: Partial<ExpenseWithNamesRow> = {},
): ExpenseWithNamesRow =>
  ({
    id,
    team_id: teamId,
    amount_minor: 5000,
    currency: 'CZK',
    spent_at: now,
    category: 'fields',
    description: 'Test expense',
    created_by_user_id: userId,
    created_by_name: Option.none<string>(),
    updated_by_user_id: userId,
    updated_by_name: Option.none<string>(),
    created_at: now,
    updated_at: now,
    ...overrides,
  }) as ExpenseWithNamesRow;

const MockExpensesRepositoryLayer = Layer.succeed(ExpensesRepository, {
  _tag: 'api/ExpensesRepository' as const,
  insert: (input: any) => {
    const id = makeExpenseId();
    const row = {
      id,
      team_id: input.team_id,
      amount_minor: input.amount_minor,
      currency: input.currency,
      spent_at: input.spent_at,
      category: input.category,
      description: input.description,
      created_by_user_id: input.created_by_user_id,
      updated_by_user_id: input.updated_by_user_id,
      created_by_name: Option.none<string>(),
      updated_by_name: Option.none<string>(),
      created_at: now,
      updated_at: now,
    };
    expensesStore.set(id, row);
    return Effect.succeed(makeExpenseRow(id, input.team_id, input.created_by_user_id));
  },
  findById: (expenseId: string, teamId: string) => {
    const row = expensesStore.get(expenseId);
    if (!row || row.team_id !== teamId) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(makeExpenseRow(expenseId, teamId, row.created_by_user_id)));
  },
  listByTeam: (teamId: string) => {
    const rows = Array.from(expensesStore.values())
      .filter((r) => r.team_id === teamId)
      .map((r) => makeExpenseRow(r.id, teamId, r.created_by_user_id));
    return Effect.succeed(rows);
  },
  update: (expenseId: string, teamId: string, updatedBy: Auth.UserId, patch: any) => {
    const row = expensesStore.get(expenseId);
    if (!row || row.team_id !== teamId) return Effect.succeed(Option.none());
    const updated = {
      ...row,
      amount_minor: Option.isSome(patch.amount_minor) ? patch.amount_minor.value : row.amount_minor,
      currency: Option.isSome(patch.currency) ? patch.currency.value : row.currency,
      description: Option.isSome(patch.description) ? patch.description.value : row.description,
      category: Option.isSome(patch.category) ? patch.category.value : row.category,
      updated_by_user_id: updatedBy,
    };
    expensesStore.set(expenseId, updated);
    return Effect.succeed(
      Option.some(makeExpenseRow(expenseId, teamId, updated.updated_by_user_id)),
    );
  },
  delete: (expenseId: string, teamId: string, _userId: Auth.UserId) => {
    const row = expensesStore.get(expenseId);
    if (!row || row.team_id !== teamId) return Effect.succeed(false);
    expensesStore.delete(expenseId);
    return Effect.succeed(true);
  },
  balanceSummaryByTeam: (_teamId: string) => {
    return Effect.succeed([
      {
        currency: 'CZK',
        incomeMinor: 10000,
        expensesMinor: 5000,
        netMinor: 5000,
        byCategory: [],
      },
    ]);
  },
  countHistoryRows: () => Effect.succeed(0),
} as never);

// ---------------------------------------------------------------------------
// Standard mocks
// ---------------------------------------------------------------------------

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
  name: 'Expense Test Team',
  guild_id: '888888888888888888',
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
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = Array.from(membersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
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
  Layer.provide(MockExpensesRepositoryLayer),
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
      FeeAssignmentsRepository,
      buildNoop('api/FeeAssignmentsRepository', {
        findById: () => Effect.succeed(Option.none()),
        findByFee: () => Effect.succeed([]),
        findByTeamMember: () => Effect.succeed([]),
        findByFeeAndMember: () => Effect.succeed(Option.none()),
        bulkInsert: () => Effect.succeed([]),
        update: () => Effect.die(new Error('Not implemented')),
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
        myStatus: () => Effect.succeed([]),
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
)
  .pipe(
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
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockWeeklyChallengeRepositoryLayer))
  .pipe(Layer.provide(BotInfoStore.Default));

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const listUrl = `http://localhost/teams/${TEST_TEAM_ID}/expenses`;
const createUrl = `http://localhost/teams/${TEST_TEAM_ID}/expenses`;
const balanceUrl = `http://localhost/teams/${TEST_TEAM_ID}/finances/balance-summary`;

const getUrl = (expenseId: string) =>
  `http://localhost/teams/${TEST_TEAM_ID}/expenses/${expenseId}`;

const patchUrl = (expenseId: string) =>
  `http://localhost/teams/${TEST_TEAM_ID}/expenses/${expenseId}`;

const deleteUrl = (expenseId: string) =>
  `http://localhost/teams/${TEST_TEAM_ID}/expenses/${expenseId}`;

const validCreateBody = JSON.stringify({
  amountMinor: 5000,
  currency: 'CZK',
  spentAt: '2025-05-01T12:00:00Z',
  category: 'fields',
  description: 'Pitch rental',
});

// ---------------------------------------------------------------------------
// listExpenses
// ---------------------------------------------------------------------------

describe('Expense API — listExpenses', () => {
  it('GET /teams/:teamId/expenses → 200 with array for member with finance:view', async () => {
    const response = await handler(
      new Request(listUrl, {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /teams/:teamId/expenses → 200 for viewer with finance:view', async () => {
    const response = await handler(
      new Request(listUrl, {
        headers: { Authorization: 'Bearer viewer-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('GET /teams/:teamId/expenses → 403 for non-member (no token)', async () => {
    const response = await handler(new Request(listUrl));
    expect(response.status).toBe(401);
  });

  it('GET /teams/:teamId/expenses → 403 ExpenseForbidden for non-team-member', async () => {
    // Outsider has no session
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_OTHER_TEAM_ID}/expenses`, {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    // User is not a member of TEST_OTHER_TEAM_ID
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// createExpense
// ---------------------------------------------------------------------------

describe('Expense API — createExpense', () => {
  it('POST /teams/:teamId/expenses → 201 with ExpenseView for user with finance:manage_fees', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: validCreateBody,
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toHaveProperty('expenseId');
    expect(body).toHaveProperty('amountMinor');
  });

  it('POST /teams/:teamId/expenses → 403 for member with only finance:view', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer viewer-token',
          'Content-Type': 'application/json',
        },
        body: validCreateBody,
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseForbidden/i);
  });

  it('POST /teams/:teamId/expenses → 400 InvalidExpenseAmount when amountMinor <= 0', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 0,
          currency: 'CZK',
          spentAt: '2025-05-01T12:00:00Z',
          category: 'fields',
          description: 'Zero amount',
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/InvalidExpenseAmount/i);
  });

  it('POST /teams/:teamId/expenses → 400 ParseError when category is invalid', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 1000,
          currency: 'CZK',
          spentAt: '2025-05-01T12:00:00Z',
          category: 'food',
          description: 'Invalid category',
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('POST /teams/:teamId/expenses → 400 ParseError when description > 500 chars', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 1000,
          currency: 'CZK',
          spentAt: '2025-05-01T12:00:00Z',
          category: 'fields',
          description: 'a'.repeat(501),
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  it('POST /teams/:teamId/expenses → 201 when spent_at is within +365 days', async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 364);
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 1000,
          currency: 'CZK',
          spentAt: futureDate.toISOString(),
          category: 'fields',
          description: 'Future expense',
        }),
      }),
    );
    expect(response.status).toBe(201);
  });

  it('POST /teams/:teamId/expenses → 201 when spent_at is within -365 days', async () => {
    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 364);
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          amountMinor: 1000,
          currency: 'CZK',
          spentAt: pastDate.toISOString(),
          category: 'fields',
          description: 'Past expense',
        }),
      }),
    );
    expect(response.status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// getExpense
// ---------------------------------------------------------------------------

describe('Expense API — getExpense', () => {
  it('GET /teams/:teamId/expenses/:expenseId → 200 for own team', async () => {
    // Pre-seed the store
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(getUrl(id), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.expenseId).toBe(id);
  });

  it('GET /teams/:teamId/expenses/:expenseId → 404 when expense not found', async () => {
    const response = await handler(
      new Request(getUrl('00000000-0000-0000-0000-000000000101'), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseNotFound/i);
  });

  it('GET /teams/:teamId/expenses/:expenseId → 404 when expense belongs to other team', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_OTHER_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(getUrl(id), {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// updateExpense (PATCH)
// ---------------------------------------------------------------------------

describe('Expense API — updateExpense', () => {
  it('PATCH → 200 with updated view and populates updated_by_user_id', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      description: 'Original',
      category: 'fields',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(patchUrl(id), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'Updated description' }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toHaveProperty('expenseId');
    expect(body).toHaveProperty('updatedByUserId');
  });

  it('PATCH → 404 when expense missing or wrong team', async () => {
    const response = await handler(
      new Request(patchUrl('00000000-0000-0000-0000-000000000102'), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'New description' }),
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseNotFound/i);
  });

  it('PATCH → 403 without finance:manage_fees', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      description: 'Original',
      category: 'fields',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(patchUrl(id), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer viewer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ description: 'Unauthorized' }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseForbidden/i);
  });

  it('PATCH → 400 InvalidExpenseAmount when amountMinor is provided as 0', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      description: 'Original',
      category: 'fields',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(patchUrl(id), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amountMinor: 0 }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/InvalidExpenseAmount/i);
  });

  it('PATCH → 400 ParseError when amountMinor is provided as negative (schema rejects < 0)', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      description: 'Original',
      category: 'fields',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(patchUrl(id), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer treasurer-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amountMinor: -500 }),
      }),
    );
    // AmountMinor schema enforces >= 0; -500 fails at schema decode → 400 ParseError
    expect(response.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// deleteExpense
// ---------------------------------------------------------------------------

describe('Expense API — deleteExpense', () => {
  it('DELETE → 204 and the row is gone', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(deleteUrl(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(204);
    expect(expensesStore.has(id)).toBe(false);
  });

  it('DELETE → 404 for non-existent id (NOT idempotent)', async () => {
    const response = await handler(
      new Request(deleteUrl('00000000-0000-0000-0000-000000000103'), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseNotFound/i);
  });

  it('DELETE → 404 for cross-team id', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_OTHER_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(deleteUrl(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('DELETE → 403 without finance:manage_fees', async () => {
    const id = makeExpenseId();
    expensesStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      amount_minor: 5000,
      currency: 'CZK',
      created_by_user_id: TEST_TREASURER_USER_ID,
      updated_by_user_id: TEST_TREASURER_USER_ID,
    });

    const response = await handler(
      new Request(deleteUrl(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer viewer-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/ExpenseForbidden/i);
  });
});

// ---------------------------------------------------------------------------
// balanceSummary
// ---------------------------------------------------------------------------

describe('Expense API — balanceSummary', () => {
  it('GET /teams/:teamId/finances/balance-summary → 200 with array for finance:view', async () => {
    const response = await handler(
      new Request(balanceUrl, {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    if (body.length > 0) {
      expect(body[0]).toHaveProperty('currency');
      expect(body[0]).toHaveProperty('incomeMinor');
      expect(body[0]).toHaveProperty('expensesMinor');
      expect(body[0]).toHaveProperty('netMinor');
    }
  });

  it('GET /teams/:teamId/finances/balance-summary → 200 for viewer with finance:view', async () => {
    const response = await handler(
      new Request(balanceUrl, {
        headers: { Authorization: 'Bearer viewer-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('GET /teams/:teamId/finances/balance-summary → 403 ExpenseForbidden without finance:view', async () => {
    // No token = unauthenticated
    const response = await handler(new Request(balanceUrl));
    expect(response.status).toBe(401);
  });

  it('GET /teams/:teamId/finances/balance-summary → 403 for non-team-member', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_OTHER_TEAM_ID}/finances/balance-summary`, {
        headers: { Authorization: 'Bearer treasurer-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});
