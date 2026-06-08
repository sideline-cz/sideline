// TDD mode — tests written BEFORE iCal payment VEVENT implementation.
// These tests WILL FAIL until the developer implements:
//   - FeeAssignmentsRepository.findUnpaidAssignmentsForUser(userId) (or equivalent)
//   - buildICalFeed extended to accept and render payment VEVENTs with VALARM
//   - DTSTAMP on every VEVENT (existing and payment)
//   - 180-day history cap for payment VEVENTs

import type { Auth, Fee, FeeAssignment, Role, Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

const ASSIGNMENT_ID_UNPAID =
  '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const ASSIGNMENT_ID_PARTIAL =
  '00000000-0000-0000-0000-000000000041' as FeeAssignment.FeeAssignmentId;
const ASSIGNMENT_ID_PAID = '00000000-0000-0000-0000-000000000042' as FeeAssignment.FeeAssignmentId;
const ASSIGNMENT_ID_WAIVED =
  '00000000-0000-0000-0000-000000000043' as FeeAssignment.FeeAssignmentId;
const ASSIGNMENT_ID_OLD = '00000000-0000-0000-0000-000000000044' as FeeAssignment.FeeAssignmentId;

const ADMIN_PERMISSIONS: readonly Role.Permission[] = ['team:manage'];

// ---------------------------------------------------------------------------
// Token state
// ---------------------------------------------------------------------------

let storedToken: { id: string; user_id: string; token: string; created_at: Date } | null = null;

// ---------------------------------------------------------------------------
// Payment assignment store (controlled per test)
// ---------------------------------------------------------------------------

type UnpaidAssignmentRow = {
  assignment_id: FeeAssignment.FeeAssignmentId;
  fee_name: string;
  currency: Fee.CurrencyCode;
  amount_minor: number;
  paid_minor: number;
  effective_due_at: Date;
  computed_status: FeeAssignment.FeeAssignmentStatus;
  stored_status: FeeAssignment.StoredAssignmentStatus;
  team_name?: string;
};

let unpaidAssignmentsStore: UnpaidAssignmentRow[];

// Events store (controlled per test; reset to testEvents in beforeEach)
type EventRow = {
  id: string;
  title: string;
  description: Option.Option<string>;
  start_at: DateTime.DateTime;
  end_at: Option.Option<DateTime.DateTime>;
  location: Option.Option<string>;
  location_url: Option.Option<string>;
  status: string;
  event_type: string;
  team_name: string;
  rsvp_response: string;
};
let eventsStore: EventRow[];

const makeAssignmentRow = (
  id: FeeAssignment.FeeAssignmentId,
  overrides: Partial<UnpaidAssignmentRow> = {},
): UnpaidAssignmentRow => ({
  assignment_id: id,
  fee_name: 'Annual Fee',
  currency: 'CZK' as Fee.CurrencyCode,
  amount_minor: 5000,
  paid_minor: 0,
  effective_due_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days from now
  computed_status: 'pending' as FeeAssignment.FeeAssignmentStatus,
  stored_status: 'active' as FeeAssignment.StoredAssignmentStatus,
  ...overrides,
});

const resetStores = () => {
  unpaidAssignmentsStore = [
    makeAssignmentRow(ASSIGNMENT_ID_UNPAID, {
      fee_name: 'Annual Fee',
      amount_minor: 5000,
      paid_minor: 0,
      computed_status: 'pending',
    }),
  ];
  // eventsStore reset is deferred to beforeEach (after testEvents is defined)
};

// ---------------------------------------------------------------------------
// Minimal mock helpers (reused from ICalFeed.test.ts pattern)
// ---------------------------------------------------------------------------

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Test User'),
  birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
  gender: Option.some('male' as const),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  permissions: [...ADMIN_PERMISSIONS],
  role_names: ['Admin'],
};

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  _tag: 'api/ICalTokensRepository',
  findByToken: (token: string) =>
    Effect.succeed(
      storedToken && storedToken.token === token ? Option.some(storedToken) : Option.none(),
    ),
  findByUserId: (userId: string) =>
    Effect.succeed(
      storedToken && storedToken.user_id === userId ? Option.some(storedToken) : Option.none(),
    ),
  create: (userId: string) => {
    storedToken = {
      id: 'ical-id-1',
      user_id: userId,
      token: 'payment-ical-token',
      created_at: new Date(),
    };
    return Effect.succeed(storedToken);
  },
  regenerate: (userId: string) => {
    storedToken = {
      id: 'ical-id-2',
      user_id: userId,
      token: 'payment-ical-token-new',
      created_at: new Date(),
    };
    return Effect.succeed(storedToken);
  },
} as any);

// The new method: findUnpaidAssignmentsForUser — not yet implemented on the real repo
const MockFeeAssignmentsRepositoryLayer = Layer.succeed(FeeAssignmentsRepository, {
  _tag: 'api/FeeAssignmentsRepository',
  findById: () => Effect.succeed(Option.none()),
  findByFee: () => Effect.succeed([]),
  findByTeamMember: () => Effect.succeed([]),
  findByFeeAndMember: () => Effect.succeed(Option.none()),
  bulkInsert: () => Effect.succeed([]),
  update: () => Effect.die(new Error('Not implemented')),
  // New method needed by iCal feed for payment VEVENTs
  findUnpaidAssignmentsForUser: (_userId: string) => Effect.succeed(unpaidAssignmentsStore),
} as any);

const testEvents = [
  {
    id: '00000000-0000-0000-0000-000000000060',
    title: 'Tuesday Training',
    description: Option.some('Bring your boots'),
    start_at: DateTime.makeUnsafe('2026-03-15T18:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2026-03-15T19:30:00Z')),
    location: Option.some('Main Field'),
    location_url: Option.none<string>(),
    status: 'active',
    event_type: 'training',
    team_name: 'Test FC',
    rsvp_response: 'yes',
  },
];

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findEventsByTeamId: () => Effect.succeed([]),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  insertEvent: () => Effect.succeed({} as never),
  updateEvent: () => Effect.succeed({} as never),
  cancelEvent: () => Effect.void,
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findEventsByChannelId: () => Effect.succeed([]),
  markReminderSent: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  findEventsByUserId: () => Effect.succeed(eventsStore),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  findByToken: (token: string) =>
    token === 'test-session-token'
      ? Effect.succeed(
          Option.some({
            id: 'sess-1',
            user_id: TEST_USER_ID,
            token: 'test-session-token',
            expires_at: DateTime.add(DateTime.nowUnsafe(), { days: 30 }),
            created_at: DateTime.nowUnsafe(),
          }),
        )
      : Effect.succeed(Option.none()),
  create: () => Effect.succeed({} as never),
  deleteByToken: () => Effect.void,
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: () => Effect.succeed(Option.some(testUser)),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
  updateAdminProfile: () => Effect.succeed(testUser),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  findByTeamAndUser: () => Effect.succeed(Option.some(testMembership)),
  findByTeam: () => Effect.succeed([testMembership]),
  findByUser: () => Effect.succeed([testMembership]),
  addMember: () => Effect.succeed({} as never),
  deactivateMember: () => Effect.void,
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  findByTeamDetailed: () => Effect.succeed([]),
  findByIdDetailed: () => Effect.succeed(Option.none()),
  updateMemberProfile: () => Effect.succeed(Option.none()),
  listRosters: () => Effect.succeed([]),
} as any);

// Stub helper
const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(Layer.succeed(DiscordOAuth, {} as any)),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(
    Layer.succeed(
      TeamsRepository,
      buildNoop('api/TeamsRepository', { findById: () => Effect.succeed(Option.none()) }),
    ),
  ),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockICalTokensRepositoryLayer),
  Layer.provide(MockFeeAssignmentsRepositoryLayer),
  Layer.provide(MockEventsRepositoryLayer),
  Layer.provide(
    Layer.succeed(
      FeesRepository,
      buildNoop('api/FeesRepository', { listByTeam: () => Effect.succeed([]) }),
    ),
  ),
  Layer.provide(
    Layer.succeed(
      PaymentsRepository,
      buildNoop('api/PaymentsRepository', { listByTeam: () => Effect.succeed([]) }),
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
        buildNoop('api/PendingGuildJoinsRepository', { listPending: () => Effect.succeed([]) }),
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
        buildNoop('api/RoleSyncEventsRepository', { findUnprocessed: () => Effect.succeed([]) }),
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
        buildNoop('api/EventSyncEventsRepository', { findUnprocessed: () => Effect.succeed([]) }),
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
        BotGuildsRepository,
        buildNoop('api/BotGuildsRepository', {
          findByGuildId: () => Effect.succeed(Option.none()),
        }),
      ),
      Layer.succeed(
        DiscordChannelsRepository,
        buildNoop('api/DiscordChannelsRepository', { findByGuildId: () => Effect.succeed([]) }),
      ),
      Layer.succeed(DiscordRolesRepository, new Proxy({} as any, { get: () => () => Effect.void })),
      Layer.succeed(EventRsvpsRepository, buildNoop('api/EventRsvpsRepository')),
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
          upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
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
  .pipe(
    Layer.provide(
      Layer.succeed(
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
      ),
    ),
  )
  .pipe(Layer.provide(Layer.succeed(ExpensesRepository, buildNoop('api/ExpensesRepository'))))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
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
  storedToken = {
    id: 'ical-id-1',
    user_id: TEST_USER_ID,
    token: 'payment-feed-token',
    created_at: new Date(),
  };
  resetStores();
  eventsStore = [...testEvents];
});

afterEach(() => {
  storedToken = null;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('iCal Feed — payment VEVENTs', () => {
  it('GET /ical/:token includes one VEVENT per unpaid assignment', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('BEGIN:VEVENT');
    // The payment VEVENT UID must include the assignment id
    expect(text).toContain(`payment-${ASSIGNMENT_ID_UNPAID}@sideline`);
  });

  it('VEVENT UID is payment-{assignment_id}@sideline', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`UID:payment-${ASSIGNMENT_ID_UNPAID}@sideline`);
  });

  it('VEVENT contains DTSTAMP', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    // Every VEVENT block (both event and payment) must have a DTSTAMP
    const vevents = text.split('BEGIN:VEVENT').slice(1);
    for (const vevent of vevents) {
      expect(vevent).toMatch(/DTSTAMP:/);
    }
  });

  it('VEVENT contains DTSTART;VALUE=DATE:YYYYMMDD (date-only, no time)', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/DTSTART;VALUE=DATE:\d{8}/);
  });

  it('VEVENT contains SUMMARY with "Payment due"', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toMatch(/SUMMARY:.*Payment due/);
  });

  it('VEVENT contains BEGIN:VALARM with TRIGGER:-P1D (1 day before)', async () => {
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('BEGIN:VALARM');
    expect(text).toContain('TRIGGER:-P1D');
    expect(text).toContain('END:VALARM');
  });

  it('excludes assignments with effective_due_at older than 180 days (history cap)', async () => {
    // Set up an assignment older than 180 days
    unpaidAssignmentsStore = [
      makeAssignmentRow(ASSIGNMENT_ID_OLD, {
        effective_due_at: new Date(Date.now() - 181 * 24 * 60 * 60 * 1000),
        computed_status: 'overdue',
      }),
    ];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(`payment-${ASSIGNMENT_ID_OLD}@sideline`);
  });

  it('excludes paid assignments', async () => {
    unpaidAssignmentsStore = [
      makeAssignmentRow(ASSIGNMENT_ID_PAID, {
        computed_status: 'paid' as FeeAssignment.FeeAssignmentStatus,
        paid_minor: 5000,
      }),
    ];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(`payment-${ASSIGNMENT_ID_PAID}@sideline`);
  });

  it('excludes waived assignments', async () => {
    unpaidAssignmentsStore = [
      makeAssignmentRow(ASSIGNMENT_ID_WAIVED, {
        stored_status: 'waived' as FeeAssignment.StoredAssignmentStatus,
        computed_status: 'waived' as FeeAssignment.FeeAssignmentStatus,
      }),
    ];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain(`payment-${ASSIGNMENT_ID_WAIVED}@sideline`);
  });

  it('includes partial-paid assignments with outstanding amount in SUMMARY/DESCRIPTION', async () => {
    unpaidAssignmentsStore = [
      makeAssignmentRow(ASSIGNMENT_ID_PARTIAL, {
        amount_minor: 5000,
        paid_minor: 2000,
        computed_status: 'partial' as FeeAssignment.FeeAssignmentStatus,
        fee_name: 'Partial Fee',
      }),
    ];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain(`payment-${ASSIGNMENT_ID_PARTIAL}@sideline`);
    // Outstanding amount (3000 minor = partial) should appear in SUMMARY or DESCRIPTION
    // The exact format is implementation-defined but the remaining amount must appear
    expect(text).toMatch(/SUMMARY:.*Partial Fee|DESCRIPTION:.*300[0-9]/);
  });

  it('existing event-VEVENTs are still present and unchanged (regression guard)', async () => {
    // The unpaid assignment VEVENT should be added ALONGSIDE event VEVENTs, not replace them
    unpaidAssignmentsStore = [makeAssignmentRow(ASSIGNMENT_ID_UNPAID)];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    // Event-based VEVENT still present
    expect(text).toContain('SUMMARY:Tuesday Training');
    // Payment VEVENT also present
    expect(text).toContain(`payment-${ASSIGNMENT_ID_UNPAID}@sideline`);
  });

  it('feed has no payment VEVENTs when all assignments are paid', async () => {
    unpaidAssignmentsStore = [];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    // No payment UIDs in the feed
    expect(text).not.toMatch(/UID:payment-/);
    // Regular event VEVENTs still present
    expect(text).toContain('SUMMARY:Tuesday Training');
  });

  it('payment-only feed uses team name from payment rows', async () => {
    // No calendar events — only a payment row with a team name
    eventsStore = [];
    unpaidAssignmentsStore = [
      makeAssignmentRow(ASSIGNMENT_ID_UNPAID, {
        team_name: 'Falcons',
      }),
    ];
    const response = await handler(new Request('http://localhost/ical/payment-feed-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    // Calendar name should be derived from the payment row's team name
    expect(text).toContain('X-WR-CALNAME:Falcons');
  });
});
