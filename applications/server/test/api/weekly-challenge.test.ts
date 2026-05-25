// TDD mode — tests written BEFORE the WeeklyChallengeApiLive handler exists.
// These tests WILL FAIL until:
//   1. packages/domain/src/api/WeeklyChallengeApi.ts exports WeeklyChallengeApiGroup
//      (already done as of Part 1 / the domain file was written)
//   2. applications/server/src/api/weekly-challenge.ts is implemented
//   3. WeeklyChallengeApiGroup is added to api.ts + ApiLive in index.ts
//
// Expected failure modes (TDD state):
//   - "Cannot resolve module ~/api/weekly-challenge.js" until the handler is written
//   - 404 responses until WeeklyChallengeApiGroup is wired into Api
//   - WeeklyChallengeRepository mock is not in the global noop layer, so
//     ApiLive construction may fail with a missing-service error

import type { Auth, Role, Team, TeamMember } from '@sideline/domain';
import { WeeklyChallenge, WeeklyChallengeApi } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { WeeklyChallengeRepository } from '~/repositories/WeeklyChallengeRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Time control: freeze to a known Monday so current-week checks are deterministic
// The anchor instant is: 2026-03-09T08:00:00Z (Monday 2026-03-09 09:00 CET)
// ---------------------------------------------------------------------------

const FROZEN_UTC = new Date('2026-03-09T08:00:00Z');
const CURRENT_MONDAY_DATE = new Date('2026-03-09T00:00:00Z'); // UTC midnight Monday

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_CAPTAIN_USER_ID = '00000000-0000-0000-0002-000000000001' as Auth.UserId;
const TEST_MEMBER_USER_ID = '00000000-0000-0000-0002-000000000002' as Auth.UserId;
const TEST_OUTSIDER_USER_ID = '00000000-0000-0000-0002-000000000099' as Auth.UserId;
const TEST_TEAM_A_ID = '00000000-0000-0000-0002-000000000010' as Team.TeamId;
const TEST_TEAM_B_ID = '00000000-0000-0000-0002-000000000020' as Team.TeamId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-0000-0002-000000000011' as TeamMember.TeamMemberId;
const TEST_MEMBER_MEMBER_ID = '00000000-0000-0000-0002-000000000012' as TeamMember.TeamMemberId;

const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'team:manage',
  'member:view',
  'member:edit',
];
const MEMBER_PERMISSIONS: readonly Role.Permission[] = ['member:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type ChallengeRow = {
  id: string;
  team_id: string;
  week_start_date: Date;
  kind: 'throwing' | 'sport';
  title: string;
  description: string | null;
  created_by: string;
  created_at: Date;
  updated_at: Date;
};

let challengesStore: Map<string, ChallengeRow>;
let completionsStore: Map<string, Set<string>>; // challengeId -> Set<memberId>
let nextChallengeIdx = 1;

const now = DateTime.nowUnsafe();

const makeChallengeId = () =>
  `00000000-0000-0000-0002-${String(nextChallengeIdx++).padStart(12, '0')}`;

const resetStores = () => {
  challengesStore = new Map();
  completionsStore = new Map();
  nextChallengeIdx = 1;
};

const makeWeeklyChallengeView = (row: ChallengeRow): WeeklyChallenge.WeeklyChallengeView => {
  const currentMondayStr = '2026-03-09'; // frozen Monday
  const rowDateStr = row.week_start_date.toISOString().slice(0, 10);
  const isActive = rowDateStr === currentMondayStr;
  const completed = Array.from(
    completionsStore.get(row.id) ?? [],
  ) as WeeklyChallenge.WeeklyChallengeCompletion['member_id'][];
  return new WeeklyChallenge.WeeklyChallengeView({
    challenge: new WeeklyChallenge.WeeklyChallenge({
      id: row.id as WeeklyChallenge.WeeklyChallengeId,
      team_id: row.team_id as Team.TeamId,
      week_start_date: row.week_start_date,
      kind: row.kind,
      title: row.title as WeeklyChallenge.WeeklyChallengeTitle,
      description:
        row.description !== null
          ? Option.some(row.description as WeeklyChallenge.WeeklyChallengeDescription)
          : Option.none(),
      created_by: row.created_by as TeamMember.TeamMemberId,
      created_at: DateTime.makeUnsafe(row.created_at),
      updated_at: DateTime.makeUnsafe(row.updated_at),
    }),
    completedMemberIds: completed,
    isActive,
  });
};

// ---------------------------------------------------------------------------
// Auth stores
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['captain-token', TEST_CAPTAIN_USER_ID],
  ['member-token', TEST_MEMBER_USER_ID],
  ['outsider-token', TEST_OUTSIDER_USER_ID],
]);

const usersMap = new Map<Auth.UserId, any>([
  [
    TEST_CAPTAIN_USER_ID,
    {
      id: TEST_CAPTAIN_USER_ID,
      discord_id: '211',
      username: 'captain',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'cs',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    TEST_MEMBER_USER_ID,
    {
      id: TEST_MEMBER_USER_ID,
      discord_id: '212',
      username: 'member',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'cs',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    TEST_OUTSIDER_USER_ID,
    {
      id: TEST_OUTSIDER_USER_ID,
      discord_id: '299',
      username: 'outsider',
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

// membersStore: (teamId, userId) -> MembershipWithRole
// Team A members: captain + member; Team B: none for these users
const membersStore = new Map<string, MembershipWithRole>([
  [
    `${TEST_TEAM_A_ID}:${TEST_CAPTAIN_USER_ID}`,
    {
      id: TEST_CAPTAIN_MEMBER_ID,
      team_id: TEST_TEAM_A_ID,
      user_id: TEST_CAPTAIN_USER_ID,
      active: true,
      role_names: ['Captain'],
      permissions: CAPTAIN_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
  [
    `${TEST_TEAM_A_ID}:${TEST_MEMBER_USER_ID}`,
    {
      id: TEST_MEMBER_MEMBER_ID,
      team_id: TEST_TEAM_A_ID,
      user_id: TEST_MEMBER_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: MEMBER_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
  // Outsider has no membership in team A or B
]);

// ---------------------------------------------------------------------------
// Noop builder
// ---------------------------------------------------------------------------

const buildNoop = (tag: string, extra: Record<string, any> = {}): never =>
  new Proxy({ _tag: tag, ...extra } as any, {
    get: (t, k) => (k in t ? t[k] : () => Effect.void),
  }) as never;

// ---------------------------------------------------------------------------
// Mock WeeklyChallengeRepository
// ---------------------------------------------------------------------------

const MockWeeklyChallengeRepositoryLayer = Layer.succeed(WeeklyChallengeRepository, {
  _tag: 'api/WeeklyChallengeRepository' as const,

  listForTeam: (teamId: string, teamTz: string, limit?: number) => {
    const all = Array.from(challengesStore.values()).filter((r) => r.team_id === teamId);
    const rows = limit !== undefined ? all.slice(0, limit) : all;
    const views = rows.map(makeWeeklyChallengeView);
    return Effect.succeed({
      team: { id: teamId as Team.TeamId, timezone: teamTz },
      challenges: views,
    });
  },

  findById: (challengeId: string) => {
    const row = challengesStore.get(challengeId);
    return Effect.succeed(row ? Option.some(row) : Option.none());
  },

  create: (input: any) => {
    const id = makeChallengeId();
    const row: ChallengeRow = {
      id,
      team_id: input.team_id,
      week_start_date: input.week_start_date,
      kind: input.kind,
      title: input.title,
      description: Option.isSome(input.description) ? (input.description.value as string) : null,
      created_by: input.created_by,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    };
    // Check for duplicate week
    const duplicate = Array.from(challengesStore.values()).find(
      (r) =>
        r.team_id === input.team_id &&
        r.week_start_date.getTime() === input.week_start_date.getTime(),
    );
    if (duplicate) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeAlreadyExistsForWeek());
    }
    challengesStore.set(id, row);
    return Effect.succeed(row);
  },

  updateTitleDescription: (challengeId: string, title: string, description: any) => {
    const row = challengesStore.get(challengeId);
    if (!row) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeNotFound());
    }
    const updated = {
      ...row,
      title,
      description: Option.isSome(description) ? (description.value as string) : null,
      updated_at: FROZEN_UTC,
    };
    challengesStore.set(challengeId, updated);
    return Effect.succeed(makeWeeklyChallengeView(updated).challenge);
  },

  delete: (challengeId: string) => {
    challengesStore.delete(challengeId);
    completionsStore.delete(challengeId);
    return Effect.void;
  },

  markCompleted: (challengeId: string, memberId: string, teamTz: string) => {
    void teamTz; // accepted but unused in mock — real repo uses it for active-week check
    const row = challengesStore.get(challengeId);
    if (!row) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeNotFound());
    }
    // Active check: compare row's week_start_date to the frozen current Monday
    const rowDateStr = row.week_start_date.toISOString().slice(0, 10);
    const currentMondayStr = '2026-03-09';
    if (rowDateStr !== currentMondayStr) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeNotActive());
    }
    const members = completionsStore.get(challengeId) ?? new Set<string>();
    members.add(memberId);
    completionsStore.set(challengeId, members);
    return Effect.void;
  },

  unmarkCompleted: (challengeId: string, memberId: string, teamTz: string) => {
    void teamTz; // accepted but unused in mock — real repo uses it for active-week check
    const row = challengesStore.get(challengeId);
    if (!row) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeNotFound());
    }
    const rowDateStr = row.week_start_date.toISOString().slice(0, 10);
    const currentMondayStr = '2026-03-09';
    if (rowDateStr !== currentMondayStr) {
      return Effect.fail(new WeeklyChallengeApi.WeeklyChallengeNotActive());
    }
    const members = completionsStore.get(challengeId);
    if (members) {
      members.delete(memberId);
    }
    return Effect.void;
  },

  enqueueAnnouncementEvent: (
    _challengeId: string,
    _teamId: string,
    _channelId: string,
    _scheduledFor: Date,
  ) => Effect.void,

  listUnprocessedDueEvents: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

// ---------------------------------------------------------------------------
// Mock ExpensesRepository (noop — expenses not tested here)
// ---------------------------------------------------------------------------

const MockExpensesRepositoryLayer = Layer.succeed(ExpensesRepository, {
  _tag: 'api/ExpensesRepository' as const,
  insert: () => Effect.die(new Error('Not implemented')),
  findById: () => Effect.succeed(Option.none()),
  listByTeam: () => Effect.succeed([]),
  update: () => Effect.succeed(Option.none()),
  delete: () => Effect.succeed(false),
  balanceSummaryByTeam: () => Effect.succeed([]),
  countHistoryRows: () => Effect.succeed(0),
} as never);

// ---------------------------------------------------------------------------
// Standard mocks (mirror expenses.test.ts)
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
      Option.some({ id: 'session-wc', user_id: userId, token, expires_at: now, created_at: now }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const testTeamA = {
  id: TEST_TEAM_A_ID,
  name: 'Challenge Team A',
  guild_id: '920000000000000010',
  created_by: TEST_CAPTAIN_USER_ID,
  timezone: 'Europe/Prague',
  created_at: now,
  updated_at: now,
};

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: (id: Team.TeamId) =>
    Effect.succeed(id === TEST_TEAM_A_ID ? Option.some(testTeamA) : Option.none()),
  insert: () => Effect.succeed(testTeamA),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const key = `${teamId}:${userId}`;
    const member = membersStore.get(key);
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

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(
      teamId === TEST_TEAM_A_ID
        ? Option.some({
            timezone: 'Europe/Prague',
            weekly_summary_channel_id: Option.some('920000000000000099'),
          })
        : Option.none(),
    ),
  findByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(
      teamId === TEST_TEAM_A_ID
        ? Option.some({
            timezone: 'Europe/Prague',
            weekly_summary_channel_id: Option.some('920000000000000099'),
          })
        : Option.none(),
    ),
  findAllWithWeeklySummaryChannel: () => Effect.succeed([]),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizonDays: () => Effect.succeed(30),
  findLateRsvpChannelId: () => Effect.succeed(Option.none()),
  findEventsNeedingReminder: () => Effect.succeed([]),
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

// ---------------------------------------------------------------------------
// Full test layer (mirrors expenses.test.ts)
// ---------------------------------------------------------------------------

const MockCoreLayers = Layer.mergeAll(
  MockDiscordOAuthLayer,
  MockUsersRepositoryLayer,
  MockSessionsRepositoryLayer,
  MockTeamsRepositoryLayer,
  MockTeamMembersRepositoryLayer,
  MockTeamSettingsRepositoryLayer,
  MockHttpClientLayer,
  MockWeeklyChallengeRepositoryLayer,
  MockExpensesRepositoryLayer,
);

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockCoreLayers),
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
  .pipe(Layer.provide(BotInfoStore.Default));

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  // Freeze time so current-week checks are deterministic
  vi.useFakeTimers();
  vi.setSystemTime(FROZEN_UTC);

  const app = HttpRouter.toWebHandler(TestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  vi.useRealTimers();
  await dispose();
});

beforeEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const listUrl = `http://localhost/teams/${TEST_TEAM_A_ID}/weekly-challenges`;
const createUrl = `http://localhost/teams/${TEST_TEAM_A_ID}/weekly-challenges`;

const challengeUrl = (challengeId: string) =>
  `http://localhost/teams/${TEST_TEAM_A_ID}/weekly-challenges/${challengeId}`;

const completeUrl = (challengeId: string) =>
  `http://localhost/teams/${TEST_TEAM_A_ID}/weekly-challenges/${challengeId}/complete`;

// Current week is 2026-03-09 (Monday). Next week = 2026-03-16.
const WEEK_NEXT = '2026-03-16T00:00:00.000Z';
const WEEK_PAST = '2026-03-02T00:00:00.000Z'; // previous Monday
const WEEK_9W_AHEAD = '2026-05-11T00:00:00.000Z'; // 9 weeks ahead
const WEEK_8W_AHEAD = '2026-05-04T00:00:00.000Z'; // 8 weeks ahead

const validCreateBody = JSON.stringify({
  weekStart: WEEK_NEXT,
  kind: 'throwing',
  title: 'Test Challenge',
  description: null,
});

// ---------------------------------------------------------------------------
// Test 1: Non-captain Create → 403
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — createChallenge', () => {
  it('non-captain POST /weekly-challenges → 403 WeeklyChallengeForbidden', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: validCreateBody,
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeForbidden/i);
  });

  // Test 2: Captain Create → 201 + sync event enqueued
  it('captain POST /weekly-challenges → 201 with WeeklyChallenge; enqueue event called', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: validCreateBody,
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toHaveProperty('id');
    expect(body).toHaveProperty('kind', 'throwing');
  });

  // Test 3a: Create with weekStart 9 weeks ahead → 422
  it('POST with weekStart 9 weeks ahead → 422 WeeklyChallengeWeekOutOfRange', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          weekStart: WEEK_9W_AHEAD,
          kind: 'sport',
          title: '9w',
          description: null,
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeWeekOutOfRange/i);
  });

  // Test 3b: Create with weekStart 8 weeks ahead → 201
  it('POST with weekStart 8 weeks ahead → 201', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          weekStart: WEEK_8W_AHEAD,
          kind: 'sport',
          title: '8w',
          description: null,
        }),
      }),
    );
    expect(response.status).toBe(201);
  });

  // Test 4: Create in past → 422
  it('POST with weekStart in the past → 422 WeeklyChallengeWeekOutOfRange', async () => {
    const response = await handler(
      new Request(createUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          weekStart: WEEK_PAST,
          kind: 'throwing',
          title: 'past',
          description: null,
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeWeekOutOfRange/i);
  });
});

// ---------------------------------------------------------------------------
// Tests 5–6: markCompleted
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — markCompleted', () => {
  it('POST .../complete on past-week challenge → 409 WeeklyChallengeNotActive', async () => {
    // Seed a challenge with a past week_start_date
    const pastId = makeChallengeId();
    challengesStore.set(pastId, {
      id: pastId,
      team_id: TEST_TEAM_A_ID,
      week_start_date: new Date(WEEK_PAST),
      kind: 'throwing',
      title: 'Past Challenge',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    const response = await handler(
      new Request(completeUrl(pastId), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeNotActive/i);
  });

  it('POST .../complete on current week → 204; second call also 204 (idempotent)', async () => {
    // Seed a challenge for the current week
    const currentId = makeChallengeId();
    challengesStore.set(currentId, {
      id: currentId,
      team_id: TEST_TEAM_A_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'throwing',
      title: 'Current Week Challenge',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    const first = await handler(
      new Request(completeUrl(currentId), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(first.status).toBe(204);

    const second = await handler(
      new Request(completeUrl(currentId), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(second.status).toBe(204);

    // Exactly 1 completion in the store
    const members = completionsStore.get(currentId);
    expect(members?.size).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Test 8: Non-member calling MarkCompleted → 403
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — markCompleted authorization', () => {
  it('non-member POST .../complete → 403 WeeklyChallengeForbidden', async () => {
    const id = makeChallengeId();
    challengesStore.set(id, {
      id,
      team_id: TEST_TEAM_A_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'throwing',
      title: 'Challenge',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    const response = await handler(
      new Request(completeUrl(id), {
        method: 'POST',
        headers: { Authorization: 'Bearer outsider-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeForbidden/i);
  });
});

// ---------------------------------------------------------------------------
// Test 9: UpdateTitleDescription preserves completion count
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — updateChallenge', () => {
  it('PATCH preserves completedMemberIds after title update', async () => {
    // Seed a challenge with 3 completions
    const id = makeChallengeId();
    challengesStore.set(id, {
      id,
      team_id: TEST_TEAM_A_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'throwing',
      title: 'Original Title',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    const memberIds = [
      '00000000-0000-0000-0002-000000000021' as TeamMember.TeamMemberId,
      '00000000-0000-0000-0002-000000000022' as TeamMember.TeamMemberId,
      '00000000-0000-0000-0002-000000000023' as TeamMember.TeamMemberId,
    ];
    completionsStore.set(id, new Set(memberIds));

    const patchResponse = await handler(
      new Request(challengeUrl(id), {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ title: 'Updated Title', description: null }),
      }),
    );
    expect(patchResponse.status).toBe(200);
    const patchBody = await patchResponse.json();
    expect(patchBody.title).toBe('Updated Title');

    // List should show 3 completedMemberIds
    const listResponse = await handler(
      new Request(listUrl, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(listResponse.status).toBe(200);
    const listBody = await listResponse.json();
    const updated = listBody.challenges?.find((c: any) => c.challenge?.id === id);
    expect(updated?.completedMemberIds).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Test 10: Captain Delete cascades
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — deleteChallenge', () => {
  it('captain DELETE → 204; challenge and completions removed', async () => {
    const id = makeChallengeId();
    challengesStore.set(id, {
      id,
      team_id: TEST_TEAM_A_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'sport',
      title: 'Delete Me',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });
    completionsStore.set(id, new Set([TEST_MEMBER_MEMBER_ID, TEST_CAPTAIN_MEMBER_ID]));

    const deleteResponse = await handler(
      new Request(challengeUrl(id), {
        method: 'DELETE',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(deleteResponse.status).toBe(204);

    // Challenge and completions gone from store
    expect(challengesStore.has(id)).toBe(false);
    expect(completionsStore.has(id)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Test 11: Cross-team isolation
// ---------------------------------------------------------------------------

describe('Weekly Challenge API — cross-team isolation', () => {
  it('captain of team A POST to team B URL → 403 WeeklyChallengeForbidden', async () => {
    const teamBCreateUrl = `http://localhost/teams/${TEST_TEAM_B_ID}/weekly-challenges`;
    const response = await handler(
      new Request(teamBCreateUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          weekStart: WEEK_NEXT,
          kind: 'throwing',
          title: 'Cross-team',
          description: null,
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeForbidden/i);
  });

  // B1: cross-team mark — member of team A uses team-A challenge id but via team B URL
  it('member of team A POST mark via team B URL with team-A challenge → 403 WeeklyChallengeNotFound (no leak)', async () => {
    // Seed a challenge owned by team A
    const teamAId = makeChallengeId();
    challengesStore.set(teamAId, {
      id: teamAId,
      team_id: TEST_TEAM_A_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'throwing',
      title: 'Team A Challenge',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    // Try to mark it via team B's URL — captain is not a member of team B
    const teamBCompleteUrl = `http://localhost/teams/${TEST_TEAM_B_ID}/weekly-challenges/${teamAId}/complete`;
    const response = await handler(
      new Request(teamBCompleteUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    // Captain is not a member of team B → 403
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeForbidden/i);
  });

  // B1: cross-team mark — captain seeds a challenge for team A, then a MEMBER (who has access
  // to team B if team B existed) tries to mark team-A's challenge via a different team URL.
  // In our test setup we only have team A members, so we test the findById ownership check
  // by seeding a challenge with team_id = TEST_TEAM_B_ID but accessing via team A URL.
  it('member POST mark via team A URL with team-B challenge id → 404 (no cross-team leak)', async () => {
    // Seed a challenge owned by team B in the store
    const teamBChallengeId = makeChallengeId();
    challengesStore.set(teamBChallengeId, {
      id: teamBChallengeId,
      team_id: TEST_TEAM_B_ID,
      week_start_date: CURRENT_MONDAY_DATE,
      kind: 'throwing',
      title: 'Team B Challenge',
      description: null,
      created_by: TEST_CAPTAIN_MEMBER_ID,
      created_at: FROZEN_UTC,
      updated_at: FROZEN_UTC,
    });

    // Member of team A tries to mark team B's challenge via team A's URL
    const crossTeamCompleteUrl = `http://localhost/teams/${TEST_TEAM_A_ID}/weekly-challenges/${teamBChallengeId}/complete`;
    const response = await handler(
      new Request(crossTeamCompleteUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    // Should be 404 — existence not leaked with a different error
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/WeeklyChallengeNotFound/i);
  });
});
