import type { Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
import { Elo } from '@sideline/domain';
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

const TEST_USER_ID = '00000000-0000-4000-a000-000000000001' as Auth.UserId;
const TEST_CAPTAIN_USER_ID = '00000000-0000-4000-a000-000000000002' as Auth.UserId;
const TEST_GLOBAL_ADMIN_USER_ID = '00000000-0000-4000-a000-000000000003' as Auth.UserId;

const TEST_TEAM_ID = '00000000-0000-4000-b000-000000000010' as Team.TeamId;

const TEST_PLAYER_MEMBER_ID = '00000000-0000-4000-c000-000000000001' as TeamMember.TeamMemberId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-4000-c000-000000000002' as TeamMember.TeamMemberId;
// global admin has no membership in the team

// Two extra member IDs used for game-result tests
const TEST_MEMBER_A = '00000000-0000-4000-c000-000000000003' as TeamMember.TeamMemberId;
const TEST_MEMBER_B = '00000000-0000-4000-c000-000000000004' as TeamMember.TeamMemberId;

// A member id that does NOT belong to the team
const TEST_UNKNOWN_MEMBER_ID = '00000000-0000-4000-c000-000000000099' as TeamMember.TeamMemberId;

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
// User rows (with is_global_admin)
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

const testPlayer = makeUser(TEST_USER_ID, '11111', 'player');
const testCaptain = makeUser(TEST_CAPTAIN_USER_ID, '22222', 'captain');
// Global admin: NOT a team member, is_global_admin = true
const testGlobalAdmin = makeUser(TEST_GLOBAL_ADMIN_USER_ID, '33333', 'globaladmin', true);

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
  // TEST_MEMBER_A and TEST_MEMBER_B: roster members with no separate users,
  // used only for findRosterByTeam / findRosterMemberByIds
]);

// ---------------------------------------------------------------------------
// Mutable state for player rating tests
// ---------------------------------------------------------------------------

// Controlled by test — what getMemberRating returns for a given member
let memberRatingStore: Map<
  TeamMember.TeamMemberId,
  {
    team_member_id: TeamMember.TeamMemberId;
    team_id: typeof TEST_TEAM_ID;
    rating: number;
    games_played: number;
    wins: number;
    losses: number;
    draws: number;
    prev_rating: Option.Option<number>;
    last_delta: Option.Option<number>;
  }
>;

// Captures the applyGameUpdates call for assertion
let applyGameUpdatesCallCount: number;
let lastApplyGameUpdatesParams: any;

// Team ratings store (returned by getTeamRatings after apply)
let teamRatingsStore: Array<{
  team_member_id: TeamMember.TeamMemberId;
  team_id: typeof TEST_TEAM_ID;
  rating: number;
  games_played: number;
  wins: number;
  losses: number;
  draws: number;
  prev_rating: Option.Option<number>;
  last_delta: Option.Option<number>;
}>;

// History store
let historyStore: Array<{
  id: string;
  team_member_id: TeamMember.TeamMemberId;
  team_id: typeof TEST_TEAM_ID;
  rating_before: number;
  rating_after: number;
  delta: number;
  result: 'win' | 'loss' | 'draw';
  game_id: Option.Option<string>;
  submitted_by: Option.Option<TeamMember.TeamMemberId>;
  created_at: Date;
}>;

// Records getOrInitMany calls
let _getOrInitManyCallCount: number;

const resetState = () => {
  applyGameUpdatesCallCount = 0;
  lastApplyGameUpdatesParams = null;
  _getOrInitManyCallCount = 0;

  // Default: player member has 5 games played (still calibrating)
  memberRatingStore = new Map([
    [
      TEST_PLAYER_MEMBER_ID,
      {
        team_member_id: TEST_PLAYER_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        rating: 1250,
        games_played: 5,
        wins: 3,
        losses: 1,
        draws: 1,
        prev_rating: Option.some(1200),
        last_delta: Option.some(50),
      },
    ],
    [
      TEST_MEMBER_A,
      {
        team_member_id: TEST_MEMBER_A,
        team_id: TEST_TEAM_ID,
        rating: 1300,
        games_played: 12,
        wins: 7,
        losses: 3,
        draws: 2,
        prev_rating: Option.some(1280),
        last_delta: Option.some(20),
      },
    ],
    [
      TEST_MEMBER_B,
      {
        team_member_id: TEST_MEMBER_B,
        team_id: TEST_TEAM_ID,
        rating: 1150,
        games_played: 12,
        wins: 4,
        losses: 6,
        draws: 2,
        prev_rating: Option.some(1160),
        last_delta: Option.some(-10),
      },
    ],
  ]);

  teamRatingsStore = [
    {
      team_member_id: TEST_MEMBER_A,
      team_id: TEST_TEAM_ID,
      rating: 1320,
      games_played: 13,
      wins: 8,
      losses: 3,
      draws: 2,
      prev_rating: Option.some(1300),
      last_delta: Option.some(20),
    },
    {
      team_member_id: TEST_MEMBER_B,
      team_id: TEST_TEAM_ID,
      rating: 1130,
      games_played: 13,
      wins: 4,
      losses: 7,
      draws: 2,
      prev_rating: Option.some(1150),
      last_delta: Option.some(-20),
    },
  ];

  historyStore = [
    {
      id: 'h-001',
      team_member_id: TEST_PLAYER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      rating_before: 1200,
      rating_after: 1250,
      delta: 50,
      result: 'win',
      game_id: Option.none(),
      submitted_by: Option.some(TEST_CAPTAIN_MEMBER_ID),
      created_at: new Date('2025-01-01T12:00:00Z'),
    },
  ];
};

// ---------------------------------------------------------------------------
// Controlled PlayerRatingsRepository — returns data from stores above
// ---------------------------------------------------------------------------

const makeControlledPlayerRatingsLayer = () =>
  Layer.succeed(PlayerRatingsRepository, {
    _tag: 'api/PlayerRatingsRepository' as const,
    getMemberRating: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
      if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
      const row = memberRatingStore.get(memberId);
      return Effect.succeed(row ? Option.some(row) : Option.none());
    },
    getTeamRatings: (_teamId: Team.TeamId) => Effect.succeed(teamRatingsStore),
    findHistoryByMember: (
      _teamId: Team.TeamId,
      memberId: TeamMember.TeamMemberId,
      _limit: number,
    ) => {
      const rows = historyStore.filter((h) => h.team_member_id === memberId);
      return Effect.succeed(rows);
    },
    getOrInitMany: (teamId: Team.TeamId, memberIds: ReadonlyArray<TeamMember.TeamMemberId>) => {
      _getOrInitManyCallCount++;
      const rows = memberIds
        .map((id) => memberRatingStore.get(id))
        .filter((r): r is NonNullable<typeof r> => r !== undefined)
        .map((r) => ({
          id: `row-${r.team_member_id}`,
          team_member_id: r.team_member_id,
          team_id: teamId,
          rating: r.rating,
          games_played: r.games_played,
          wins: r.wins,
          losses: r.losses,
          draws: r.draws,
        }));
      return Effect.succeed(rows);
    },
    applyGameUpdates: (params: any) => {
      applyGameUpdatesCallCount++;
      lastApplyGameUpdatesParams = params;
      return Effect.void;
    },
  } as never);

// ---------------------------------------------------------------------------
// Standard infrastructure mocks (reused from other test files)
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
  name: 'Rating Test Team',
  guild_id: '777777777777777777' as Discord.Snowflake,
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

// Roster members for findRosterByTeam: MEMBER_A and MEMBER_B are on the team roster.
// TEST_PLAYER_MEMBER_ID is also on the roster (but not for game result tests below).
const rosterMembers: TeamMember.TeamMemberId[] = [
  TEST_PLAYER_MEMBER_ID,
  TEST_CAPTAIN_MEMBER_ID,
  TEST_MEMBER_A,
  TEST_MEMBER_B,
];

const makeRosterEntry = (memberId: TeamMember.TeamMemberId): RosterEntry =>
  new RosterEntry({
    member_id: memberId,
    user_id: TEST_USER_ID, // user_id doesn't matter for rating tests
    discord_id: '11111' as Discord.Snowflake,
    role_names: ['Player'],
    permissions: PLAYER_PERMISSIONS,
    name: Option.some('Member'),
    birth_date: Option.none(),
    gender: Option.none(),
    jersey_number: Option.none(),
    username: 'member',
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
  });

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
  findRosterByTeam: (teamId: Team.TeamId) => {
    if (teamId !== TEST_TEAM_ID) return Effect.succeed([]);
    return Effect.succeed(rosterMembers.map(makeRosterEntry));
  },
  findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
    if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
    const found = rosterMembers.includes(memberId);
    return Effect.succeed(found ? Option.some(makeRosterEntry(memberId)) : Option.none());
  },
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
        new Response(JSON.stringify({ id: '11111', username: 'player', avatar: null }), {
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

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
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

// ---------------------------------------------------------------------------
// Build the full test layer
// ---------------------------------------------------------------------------

const buildTestLayer = (playerRatingsLayer: Layer.Layer<PlayerRatingsRepository>) =>
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
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(MockChannelEventDividersRepositoryLayer))
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(playerRatingsLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, {
          asEffect: Effect.succeed(new Set<string>()),
        } as any),
      ),
    );

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const TEAM_BASE = `http://localhost/teams/${TEST_TEAM_ID}`;
const ratingsUrl = `${TEAM_BASE}/ratings`;
const memberRatingUrl = (memberId: string) => `${TEAM_BASE}/members/${memberId}/rating`;
const memberRatingHistoryUrl = (memberId: string) =>
  `${TEAM_BASE}/members/${memberId}/rating/history`;
const applyGameResultUrl = `${TEAM_BASE}/ratings/games`;

// ---------------------------------------------------------------------------
// Test suite setup
// ---------------------------------------------------------------------------

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const TestLayer = buildTestLayer(makeControlledPlayerRatingsLayer());
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

// ---------------------------------------------------------------------------
// 1. Permission gating — Player (no member:edit) → Forbidden (403)
// ---------------------------------------------------------------------------

describe('Player (roster:view + member:view, NO member:edit) — all endpoints → 403', () => {
  it('GET getTeamRatings → 403', async () => {
    const response = await handler(
      new Request(ratingsUrl, {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('GET getMemberRating → 403', async () => {
    const response = await handler(
      new Request(memberRatingUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('GET getMemberRatingHistory → 403', async () => {
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer player-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('POST applyGameResult → 403', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer player-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// 2. Permission gating — Captain (has member:edit) → 200 on reads
// ---------------------------------------------------------------------------

describe('Captain (member:edit) — reads → 200', () => {
  it('GET getTeamRatings → 200', async () => {
    const response = await handler(
      new Request(ratingsUrl, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.canManage).toBe('boolean');
    expect(body.canManage).toBe(true);
    expect(typeof body.calibrationThreshold).toBe('number');
    expect(body.calibrationThreshold).toBe(Elo.CALIBRATION_GAMES);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('GET getMemberRating → 200 for own member', async () => {
    const response = await handler(
      new Request(memberRatingUrl(TEST_CAPTAIN_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memberId).toBe(TEST_CAPTAIN_MEMBER_ID);
  });

  it('GET getMemberRating → 200 for another team member', async () => {
    const response = await handler(
      new Request(memberRatingUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.memberId).toBe(TEST_PLAYER_MEMBER_ID);
  });

  it('GET getMemberRatingHistory → 200', async () => {
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.entries)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Global admin (not a team member) → allowed (isGlobalAdmin branch)
// ---------------------------------------------------------------------------

describe('Global admin (not a team member) — bypasses member:edit gate → 200', () => {
  it('GET getTeamRatings → 200', async () => {
    const response = await handler(
      new Request(ratingsUrl, {
        headers: { Authorization: 'Bearer global-admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // Global admin gets canManage=true because isGlobalAdmin=true in handler
    expect(body.canManage).toBe(true);
  });

  it('GET getMemberRating for a roster member → 200', async () => {
    const response = await handler(
      new Request(memberRatingUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer global-admin-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('GET getMemberRatingHistory for a roster member → 200', async () => {
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer global-admin-token' },
      }),
    );
    expect(response.status).toBe(200);
  });

  it('POST applyGameResult → 200', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer global-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 4. getMemberRating response shape — existing rated member
// ---------------------------------------------------------------------------

describe('getMemberRating — response shape', () => {
  it('returns correct fields for a rated member (5 games, calibrating)', async () => {
    const response = await handler(
      new Request(memberRatingUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.memberId).toBe(TEST_PLAYER_MEMBER_ID);
    expect(body.rating).toBe(1250);
    expect(body.gamesPlayed).toBe(5);
    expect(body.wins).toBe(3);
    expect(body.losses).toBe(1);
    expect(body.draws).toBe(1);
    // isCalibrating = gamesPlayed (5) < CALIBRATION_GAMES (10)
    expect(body.isCalibrating).toBe(true);
    expect(body.calibrationThreshold).toBe(Elo.CALIBRATION_GAMES);
    // previousRating and lastDelta come through from the row
    // The schema serializes Option — null means none, number means some
    expect(body.previousRating).toBe(1200);
    expect(body.lastDelta).toBe(50);
  });

  it('isCalibrating = false for a member with >= 10 games', async () => {
    // TEST_MEMBER_A has 12 games
    const response = await handler(
      new Request(memberRatingUrl(TEST_MEMBER_A), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.gamesPlayed).toBe(12);
    expect(body.isCalibrating).toBe(false);
    expect(body.calibrationThreshold).toBe(Elo.CALIBRATION_GAMES);
  });
});

// ---------------------------------------------------------------------------
// 5. getMemberRating — unrated member vs non-member
// ---------------------------------------------------------------------------

describe('getMemberRating — unrated member vs non-member', () => {
  it('unrated-but-existing member → defaults (rating 1200, gamesPlayed 0, isCalibrating true)', async () => {
    // TEST_CAPTAIN_MEMBER_ID is on the roster but has no rating row
    memberRatingStore.delete(TEST_CAPTAIN_MEMBER_ID);

    const response = await handler(
      new Request(memberRatingUrl(TEST_CAPTAIN_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.memberId).toBe(TEST_CAPTAIN_MEMBER_ID);
    expect(body.rating).toBe(Elo.DEFAULT_RATING); // 1200
    expect(body.gamesPlayed).toBe(0);
    expect(body.wins).toBe(0);
    expect(body.losses).toBe(0);
    expect(body.draws).toBe(0);
    expect(body.isCalibrating).toBe(true);
    expect(body.calibrationThreshold).toBe(Elo.CALIBRATION_GAMES);
    // Options are none → serialized as null
    expect(body.previousRating).toBeNull();
    expect(body.lastDelta).toBeNull();
  });

  it('non-member (not on team roster) → 404 PlayerNotFound', async () => {
    // TEST_UNKNOWN_MEMBER_ID is not in rosterMembers
    const response = await handler(
      new Request(memberRatingUrl(TEST_UNKNOWN_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// 6. getMemberRatingHistory — shape
// ---------------------------------------------------------------------------

describe('getMemberRatingHistory — response shape', () => {
  it('returns history entries with correct fields', async () => {
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_PLAYER_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(Array.isArray(body.entries)).toBe(true);
    expect(body.entries).toHaveLength(1);

    const entry = body.entries[0];
    expect(entry.id).toBe('h-001');
    expect(entry.ratingBefore).toBe(1200);
    expect(entry.ratingAfter).toBe(1250);
    expect(entry.delta).toBe(50);
    expect(entry.result).toBe('win');
    expect(entry.gameId).toBeNull();
    expect(entry.submittedBy).toBe(TEST_CAPTAIN_MEMBER_ID);
    // createdAt is an ISO string
    expect(typeof entry.createdAt).toBe('string');
  });

  it('non-member (not on team roster) → 404 PlayerNotFound', async () => {
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_UNKNOWN_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('member with no history → 200 with empty entries', async () => {
    // Captain has no history rows
    const response = await handler(
      new Request(memberRatingHistoryUrl(TEST_CAPTAIN_MEMBER_ID), {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.entries).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 7. applyGameResult — validation errors
// ---------------------------------------------------------------------------

describe('applyGameResult — validation errors (Captain)', () => {
  it('empty teamA → 422 InvalidGameResult with reason emptyTeam', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamB',
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('PlayerRatingInvalidGameResult');
    expect(body.reason).toBe('emptyTeam');
  });

  it('empty teamB → 422 InvalidGameResult with reason emptyTeam', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('PlayerRatingInvalidGameResult');
    expect(body.reason).toBe('emptyTeam');
  });

  it('member in both teams → 422 InvalidGameResult with reason overlap', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A, TEST_MEMBER_B],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('PlayerRatingInvalidGameResult');
    expect(body.reason).toBe('overlap');
  });

  it('member not on team roster → 422 InvalidGameResult with reason unknownMember', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_UNKNOWN_MEMBER_ID],
          outcome: 'draw',
        }),
      }),
    );
    expect(response.status).toBe(422);
    const body = await response.json();
    expect(body._tag).toBe('PlayerRatingInvalidGameResult');
    expect(body.reason).toBe('unknownMember');
  });
});

// ---------------------------------------------------------------------------
// 8. applyGameResult — happy path (Captain) + submittedBy verification
// ---------------------------------------------------------------------------

describe('applyGameResult — happy path', () => {
  it('Captain → 200, repo applyGameUpdates called with submittedBy = captain member id', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(200);

    // The repo was called
    expect(applyGameUpdatesCallCount).toBe(1);

    // submittedBy must be the captain's membership id, not the sentinel
    const submittedBy = lastApplyGameUpdatesParams.submittedBy;
    // Option.some(TEST_CAPTAIN_MEMBER_ID)
    expect(Option.isSome(submittedBy)).toBe(true);
    expect(Option.getOrUndefined(submittedBy)).toBe(TEST_CAPTAIN_MEMBER_ID);

    // Response is a TeamRatingsResponse
    const body = await response.json();
    expect(typeof body.canManage).toBe('boolean');
    expect(body.canManage).toBe(true);
    expect(Array.isArray(body.entries)).toBe(true);
  });

  it('Global admin (no membership) → submittedBy = none (sentinel)', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer global-admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'draw',
        }),
      }),
    );
    expect(response.status).toBe(200);

    // Global admin uses the sentinel membership id → submittedBy must be none
    const submittedBy = lastApplyGameUpdatesParams.submittedBy;
    expect(Option.isNone(submittedBy)).toBe(true);
  });

  it('draw outcome → outcome=draw passed to applyGameUpdates', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'draw',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(lastApplyGameUpdatesParams.outcome).toBe('draw');
    expect(lastApplyGameUpdatesParams.teamAMemberIds).toEqual([TEST_MEMBER_A]);
    expect(lastApplyGameUpdatesParams.teamBMemberIds).toEqual([TEST_MEMBER_B]);
  });

  it('teamB wins → outcome=teamB passed to applyGameUpdates', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamB',
        }),
      }),
    );
    expect(response.status).toBe(200);
    expect(lastApplyGameUpdatesParams.outcome).toBe('teamB');
    expect(lastApplyGameUpdatesParams.teamAMemberIds).toEqual([TEST_MEMBER_A]);
    expect(lastApplyGameUpdatesParams.teamBMemberIds).toEqual([TEST_MEMBER_B]);
  });
});

// ---------------------------------------------------------------------------
// 9. Unauthenticated request → 401
// ---------------------------------------------------------------------------

describe('Unauthenticated requests → 401', () => {
  it('GET getTeamRatings without token → 401', async () => {
    const response = await handler(new Request(ratingsUrl));
    expect(response.status).toBe(401);
  });

  it('POST applyGameResult without token → 401', async () => {
    const response = await handler(
      new Request(applyGameResultUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          teamA: [TEST_MEMBER_A],
          teamB: [TEST_MEMBER_B],
          outcome: 'teamA',
        }),
      }),
    );
    expect(response.status).toBe(401);
  });
});
