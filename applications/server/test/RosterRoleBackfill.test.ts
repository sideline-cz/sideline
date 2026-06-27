/**
 * TDD tests for the team-scoped, on-demand roster-role-member backfill feature.
 *
 * Production code NOT yet written. These tests are expected to FAIL until:
 *   - DiscordChannelMappingRepository gains `findActiveRostersWithRole` and
 *     `countActiveRostersWithRole` methods.
 *   - `applications/server/src/utils/backfillRosterRoleMembers.ts` is created.
 *   - `applications/server/src/api/roster.ts` gains a `backfillRosterRoles` handler
 *     for `POST /teams/:teamId/rosters/backfill-role-members`.
 *   - Domain already exposes `Roster.BackfillRosterRolesResult` and the endpoint
 *     declaration (already built).
 *
 * NOTE: The `NOT EXISTS` dedup guard, `active = true`, and `discord_role_id IS NOT NULL`
 * filters are SQL-level concerns in `findActiveRostersWithRole`. They are tested by the
 * sibling DB-backed integration test in:
 *   test/integration/repositories/DiscordChannelMappingRepository.test.ts
 * Here we only assert the handler faithfully passes through whatever the (mocked)
 * guarded query returns.
 */

import type { Auth, Discord, Role, Roster, RosterModel, Team, TeamMember } from '@sideline/domain';
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
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from './mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// RosterMissingRoleRow — local definition matching the production type spec.
// Production code (not yet written) will export this from
// ~/repositories/DiscordChannelMappingRepository.js. Once it exists, replace
// this with the real import.
// ---------------------------------------------------------------------------

type RosterMissingRoleRow = {
  readonly roster_id: RosterModel.RosterId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly emoji: Option.Option<string>;
  readonly color: Option.Option<string>;
  readonly discord_channel_id: Option.Option<Discord.Snowflake>;
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROSTER_ID_A = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const TEST_ROSTER_ID_B = '00000000-0000-0000-0000-000000000031' as RosterModel.RosterId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const EXISTING_CHANNEL_A = '111111111111111111' as Discord.Snowflake;
const EXISTING_CHANNEL_B = '222222222222222222' as Discord.Snowflake;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;

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
];
const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

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
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'player',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.none<string>(),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: GUILD_ID,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_ADMIN_ID);
sessionsStore.set('player-token', TEST_USER_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS,
});

// ---------------------------------------------------------------------------
// Per-test spy state (reset in beforeEach)
// ---------------------------------------------------------------------------

// All positional args of emitRosterChannelCreated:
//   (teamId, rosterId, rosterName, existingChannelId,
//    discordChannelName?, discordRoleName?, discordRoleColor?, targetCategoryId)
// See ChannelSyncEventsRepository.ts:342-350.
type RosterChannelCreatedCall = {
  teamId: Team.TeamId;
  rosterId: RosterModel.RosterId;
  rosterName: string;
  existingChannelId: Option.Option<Discord.Snowflake>;
  discordChannelName: string | undefined;
  discordRoleName: string | undefined;
  discordRoleColor: Option.Option<number> | undefined;
  targetCategoryId: Option.Option<Discord.Snowflake>;
};

let rosterCreatedCalls: RosterChannelCreatedCall[] = [];

// Tracks calls to findActiveRostersWithRole (teamId, limit)
let findActiveRostersWithRoleCalls: Array<{ teamId: Team.TeamId; limit: number }> = [];
// Tracks calls to countActiveRostersWithRole (teamId)
let countActiveRostersWithRoleCalls: Array<{ teamId: Team.TeamId }> = [];

// Configurable mock return values
let mockRosterMissingRows: RosterMissingRoleRow[] = [];
let mockRosterCount = 0;

// ---------------------------------------------------------------------------
// Configurable layer factories
// ---------------------------------------------------------------------------

const makeChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitChannelArchived: () => Effect.void,
    emitChannelDetached: () => Effect.void,
    emitRosterChannelCreated: (
      teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      rosterName: string,
      existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
      discordChannelName?: string,
      discordRoleName?: string,
      discordRoleColor?: Option.Option<number>,
      targetCategoryId: Option.Option<Discord.Snowflake> = Option.none(),
    ) => {
      rosterCreatedCalls.push({
        teamId,
        rosterId,
        rosterName,
        existingChannelId,
        discordChannelName,
        discordRoleName,
        discordRoleColor,
        targetCategoryId,
      });
      return Effect.void;
    },
    emitRosterChannelDeleted: () => Effect.void,
    emitRosterChannelArchived: () => Effect.void,
    emitRosterChannelDetached: () => Effect.void,
    emitGroupChannelUpdated: () => Effect.void,
    emitRosterChannelUpdated: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMembersAddedBatch: () => Effect.void,
    emitMembersRemovedBatch: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
    emitManagedAccessGrantedBatch: () => Effect.void,
    emitManagedAccessRevokedBatch: () => Effect.void,
    emitManagedChannelCreated: () => Effect.void,
    emitManagedChannelArchived: () => Effect.void,
    emitManagedChannelDeleted: () => Effect.void,
    emitManagedChannelRestored: () => Effect.void,
    emitManagedChannelAdopted: () => Effect.void,
    emitDiscordChannelArchived: () => Effect.void,
    emitDiscordChannelRestored: () => Effect.void,
  } as any);

const makeDiscordChannelMappingLayer = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    _tag: 'api/DiscordChannelMappingRepository',
    findByGroupId: () => Effect.succeed(Option.none()),
    findByRosterId: () => Effect.succeed(Option.none()),
    insert: () => Effect.succeed(Option.none()),
    insertRoleOnly: () => Effect.succeed(Option.none()),
    upsertGroupChannel: () => Effect.void,
    clearGroupChannel: () => Effect.void,
    insertRoster: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    deleteByRosterId: () => Effect.void,
    findAllByTeam: () => Effect.succeed([]),
    findGroupsMissingRole: () => Effect.succeed([]),
    findClaimThread: () => Effect.succeed(Option.none()),
    saveClaimThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearClaimThread: () => Effect.void,
    // NEW methods — not yet implemented in production code
    findActiveRostersWithRole: (teamId: Team.TeamId, limit: number) => {
      findActiveRostersWithRoleCalls.push({ teamId, limit });
      return Effect.succeed(mockRosterMissingRows);
    },
    countActiveRostersWithRole: (teamId: Team.TeamId) => {
      countActiveRostersWithRoleCalls.push({ teamId });
      return Effect.succeed(mockRosterCount);
    },
  } as any);

const makeRostersRepositoryLayer = () =>
  Layer.succeed(RostersRepository, {
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

// ---------------------------------------------------------------------------
// Static mock layers (mirroring RosterSyncRoleMembers.test.ts exactly)
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
    if (id === TEST_ADMIN_ID) return Effect.succeed(Option.some(testAdmin));
    if (id === TEST_USER_ID) return Effect.succeed(Option.some(testUser));
    return Effect.succeed(Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testAdmin),
  completeProfile: () => Effect.succeed(testAdmin),
  updateLocale: () => Effect.succeed(testAdmin),
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
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
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
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  deleteTrainingTypeById: () => Effect.void,
  addCoach: () => Effect.void,
  removeCoach: () => Effect.void,
  countCoachesForTrainingType: () => Effect.succeed({ count: 0 }),
  checkCoach: () => Effect.succeed(Option.some({ exists: false })),
  findByCoach: () => Effect.succeed([]),
} as any);

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  updateRule: () => Effect.die(new Error('Not implemented')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
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
  findByIdWithDetails: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  insertSeries: () => Effect.die(new Error('Not implemented')),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  updateSeries: () => Effect.die(new Error('Not implemented')),
  cancelSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  findByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  countByEventId: () => Effect.succeed([]),
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
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
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

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as any);

const defaultSettingsLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

// ---------------------------------------------------------------------------
// Layer builder (mirrors RosterSyncRoleMembers.test.ts)
// ---------------------------------------------------------------------------

const buildTestLayer = (
  settingsLayer: Layer.Layer<TeamSettingsRepository> = defaultSettingsLayer,
) => {
  const channelSyncLayer = makeChannelSyncLayer();
  const rostersRepositoryLayer = makeRostersRepositoryLayer();
  const mappingLayer = makeDiscordChannelMappingLayer();

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
          Layer.merge(rostersRepositoryLayer, MockActivityLogsRepositoryLayer),
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
          } as any),
          Layer.succeed(InviteAcceptancesRepository, {
            _tag: 'api/InviteAcceptancesRepository',
          } as any),
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
    Layer.provide(Layer.merge(channelSyncLayer, MockEventSyncEventsRepositoryLayer)),
    Layer.provide(Layer.merge(mappingLayer, MockICalTokensRepositoryLayer)),
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
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, {
          asEffect: Effect.succeed(new Set<string>()),
        } as any),
      ),
    );
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
  rosterCreatedCalls = [];
  findActiveRostersWithRoleCalls = [];
  countActiveRostersWithRoleCalls = [];
  mockRosterMissingRows = [];
  mockRosterCount = 0;
});

// ---------------------------------------------------------------------------
// Helpers — established pattern from RosterSyncRoleMembers.test.ts
// ---------------------------------------------------------------------------

const createHandler = (
  settingsLayer: Layer.Layer<TeamSettingsRepository> = defaultSettingsLayer,
) => {
  const app = HttpRouter.toWebHandler(buildTestLayer(settingsLayer));
  disposeHandlers.push(app.dispose);
  return app.handler;
};

// Handler param typed as (...args: any) => Promise<Response> — established project pattern.
// See RosterSyncRoleMembers.test.ts lines 817 & 831.
const postBackfillRosterRoles = (
  handler: (...args: any) => Promise<Response>,
  teamId: Team.TeamId = TEST_TEAM_ID,
  token: string | null = 'admin-token',
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/rosters/backfill-role-members`, {
      method: 'POST',
      headers: token !== null ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

// ---------------------------------------------------------------------------
// Fixture helper
// ---------------------------------------------------------------------------

const makeRow = (
  rosterId: RosterModel.RosterId,
  name: string,
  channelId: Option.Option<Discord.Snowflake> = Option.none(),
): RosterMissingRoleRow => ({
  roster_id: rosterId,
  team_id: TEST_TEAM_ID,
  name,
  emoji: Option.none(),
  color: Option.none(),
  discord_channel_id: channelId,
});

// ---------------------------------------------------------------------------
// Suite A — sweep util behavior (exercised via the HTTP handler)
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/rosters/backfill-role-members — sweep behavior', () => {
  // -------------------------------------------------------------------------
  // Test 1: 2 rows, count=2 → processedCount=2, remainingCount=0
  //         emitRosterChannelCreated called twice with existingChannelId=Some
  //         and discordChannelName=undefined (attach-only, not create-new)
  //
  // SQL-level note: active=true and discord_role_id IS NOT NULL guards live in
  // the DB query. Here we assert the handler faithfully forwards whatever the
  // mocked guarded query returns.
  // -------------------------------------------------------------------------
  it('2 rows + count=2 → processedCount=2, remainingCount=0; emitRosterChannelCreated called twice with existingChannelId=Some, discordChannelName=undefined (attach-only)', async () => {
    mockRosterCount = 2;
    mockRosterMissingRows = [
      makeRow(TEST_ROSTER_ID_A, 'Team A', Option.some(EXISTING_CHANNEL_A)),
      makeRow(TEST_ROSTER_ID_B, 'Team B', Option.some(EXISTING_CHANNEL_B)),
    ];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    expect(body.processedCount).toBe(2);
    expect(body.remainingCount).toBe(0);

    expect(rosterCreatedCalls).toHaveLength(2);

    const callA = rosterCreatedCalls.find((c) => c.rosterId === TEST_ROSTER_ID_A);
    const callB = rosterCreatedCalls.find((c) => c.rosterId === TEST_ROSTER_ID_B);

    if (callA === undefined || callB === undefined) {
      throw new Error('Expected both roster calls to be recorded');
    }

    // existingChannelId must be Some — the bot attaches to the existing channel/role
    expect(Option.isSome(callA.existingChannelId)).toBe(true);
    expect(Option.getOrNull(callA.existingChannelId)).toBe(EXISTING_CHANNEL_A);
    expect(Option.isSome(callB.existingChannelId)).toBe(true);
    expect(Option.getOrNull(callB.existingChannelId)).toBe(EXISTING_CHANNEL_B);

    // discordChannelName must be undefined (attach-only — no new channel created).
    // This is the critical property: when existingChannelId is Some, passing a
    // discordChannelName would cause the bot to create a duplicate channel.
    // Mirror: emitGroupRoleBackfill.ts:50-58 (LINK branch passes undefined).
    expect(callA.discordChannelName).toBeUndefined();
    expect(callB.discordChannelName).toBeUndefined();

    // discordRoleName must be set (the whole purpose of the backfill is to re-emit
    // the role provisioning event with a derived role name)
    expect(typeof callA.discordRoleName).toBe('string');
    expect(callA.discordRoleName?.length).toBeGreaterThan(0);
    expect(typeof callB.discordRoleName).toBe('string');
    expect(callB.discordRoleName?.length).toBeGreaterThan(0);

    // Names and teamId must pass through unchanged
    expect(callA.rosterName).toBe('Team A');
    expect(callB.rosterName).toBe('Team B');
    expect(callA.teamId).toBe(TEST_TEAM_ID);
    expect(callB.teamId).toBe(TEST_TEAM_ID);
  });

  // -------------------------------------------------------------------------
  // Test 2: Empty — both return 0/[] → processedCount=0, remainingCount=0, no emit
  // -------------------------------------------------------------------------
  it('empty — count=0, rows=[] → processedCount=0, remainingCount=0; no emit calls', async () => {
    mockRosterCount = 0;
    mockRosterMissingRows = [];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    expect(body.processedCount).toBe(0);
    expect(body.remainingCount).toBe(0);

    expect(rosterCreatedCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Test 3: remainingCount when eligible > limit
  //         count=80, findActiveRostersWithRole returns 50 rows
  //         → processedCount=50, remainingCount=30; 50 emit calls
  // -------------------------------------------------------------------------
  it('count=80, 50 rows returned → processedCount=50, remainingCount=30; 50 emit calls', async () => {
    mockRosterCount = 80;
    mockRosterMissingRows = Array.from({ length: 50 }, (_, i) => {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` as RosterModel.RosterId;
      return makeRow(id, `Roster ${i}`, Option.some(EXISTING_CHANNEL_A));
    });

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    expect(body.processedCount).toBe(50);
    expect(body.remainingCount).toBe(30);
    expect(rosterCreatedCalls).toHaveLength(50);
  });

  // -------------------------------------------------------------------------
  // Test 4: remainingCount arithmetic across two calls
  //         (Note: true SQL-level dedup self-clearing is tested in the integration
  //          test in DiscordChannelMappingRepository.test.ts)
  //         First call: count=80, find returns 50 → {processedCount:50, remainingCount:30}
  //         Second call: mock now count=30, find returns 30 → {processedCount:30, remainingCount:0}
  // -------------------------------------------------------------------------
  it('remainingCount arithmetic across two calls: first 80→50+30, then 30→30+0', async () => {
    mockRosterCount = 80;
    mockRosterMissingRows = Array.from({ length: 50 }, (_, i) => {
      const id = `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` as RosterModel.RosterId;
      return makeRow(id, `Roster ${i}`, Option.some(EXISTING_CHANNEL_A));
    });

    const handler = createHandler();

    const first = await postBackfillRosterRoles(handler);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Roster.BackfillRosterRolesResult;
    expect(firstBody.processedCount).toBe(50);
    expect(firstBody.remainingCount).toBe(30);

    // Simulate: after first sweep, 30 remain
    mockRosterCount = 30;
    mockRosterMissingRows = Array.from({ length: 30 }, (_, i) => {
      const id = `00000000-0000-0000-0001-${String(i).padStart(12, '0')}` as RosterModel.RosterId;
      return makeRow(id, `Roster extra ${i}`, Option.some(EXISTING_CHANNEL_B));
    });

    const second = await postBackfillRosterRoles(handler);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Roster.BackfillRosterRolesResult;
    expect(secondBody.processedCount).toBe(30);
    expect(secondBody.remainingCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 5: Settings fallback — no settings row → handler must not crash;
  //         emitRosterChannelCreated called with a non-empty rosterName
  // -------------------------------------------------------------------------
  it('settings fallback — no settings row → still emits with non-empty rosterName', async () => {
    mockRosterCount = 1;
    mockRosterMissingRows = [
      makeRow(TEST_ROSTER_ID_A, 'Strikers', Option.some(EXISTING_CHANNEL_A)),
    ];

    const handler = createHandler(defaultSettingsLayer); // findByTeamId returns None
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;
    expect(body.processedCount).toBe(1);

    expect(rosterCreatedCalls).toHaveLength(1);
    const call = rosterCreatedCalls[0];
    if (call === undefined) throw new Error('Expected a recorded call');
    expect(typeof call.rosterName).toBe('string');
    expect(call.rosterName.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Test 6: All 3 rosterIds are emitted exactly once (emit-completeness check)
  //         The mock emit returns Effect.void synchronously; order is therefore
  //         preserved regardless of concurrency setting and proves nothing about
  //         concurrency:1. We only assert completeness and uniqueness.
  // -------------------------------------------------------------------------
  it('3 rows → all 3 rosterIds emitted exactly once', async () => {
    const ROW_IDS: RosterModel.RosterId[] = [
      '00000000-0000-0000-0003-000000000001' as RosterModel.RosterId,
      '00000000-0000-0000-0003-000000000002' as RosterModel.RosterId,
      '00000000-0000-0000-0003-000000000003' as RosterModel.RosterId,
    ];
    mockRosterCount = 3;
    mockRosterMissingRows = ROW_IDS.map((id, i) =>
      makeRow(id, `Roster ${i + 1}`, Option.some(EXISTING_CHANNEL_A)),
    );

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;
    expect(body.processedCount).toBe(3);

    expect(rosterCreatedCalls).toHaveLength(3);

    const emittedIds = rosterCreatedCalls.map((c) => c.rosterId);
    for (const expectedId of ROW_IDS) {
      expect(emittedIds).toContain(expectedId);
    }
    // Each id emitted exactly once
    expect(new Set(emittedIds).size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Test 7 (new — item E): remainingCount clamp boundary
  //         count=1 but 2 rows returned (race between count and find queries)
  //         → remainingCount must be 0 (max(0, 1-2) = 0), never -1
  // -------------------------------------------------------------------------
  it('remainingCount clamp: count=1 but 2 rows returned → remainingCount=0, not -1', async () => {
    mockRosterCount = 1; // stale count (race: rows inserted between count and find)
    mockRosterMissingRows = [
      makeRow(TEST_ROSTER_ID_A, 'Roster A', Option.some(EXISTING_CHANNEL_A)),
      makeRow(TEST_ROSTER_ID_B, 'Roster B', Option.some(EXISTING_CHANNEL_B)),
    ];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    expect(body.processedCount).toBe(2);
    // remainingCount must be clamped to 0, not -1
    expect(body.remainingCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Suite B — HTTP auth / isolation
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/rosters/backfill-role-members — auth and isolation', () => {
  // -------------------------------------------------------------------------
  // Test 8: 403 without roster:manage permission
  // -------------------------------------------------------------------------
  it('returns 403 when caller lacks roster:manage permission', async () => {
    mockRosterCount = 0;
    mockRosterMissingRows = [];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(
      handler,
      TEST_TEAM_ID,
      'player-token', // player has no roster:manage
    );

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Test 9: Success with permission returns processedCount + remainingCount
  // -------------------------------------------------------------------------
  it('returns 200 with { processedCount, remainingCount } when caller has roster:manage', async () => {
    mockRosterCount = 1;
    mockRosterMissingRows = [
      makeRow(TEST_ROSTER_ID_A, 'Alpha Roster', Option.some(EXISTING_CHANNEL_A)),
    ];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler, TEST_TEAM_ID, 'admin-token');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;
    expect(typeof body.processedCount).toBe('number');
    expect(typeof body.remainingCount).toBe('number');
    expect(body.processedCount).toBe(1);
    expect(body.remainingCount).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Test 10: 401 without auth token
  // -------------------------------------------------------------------------
  it('returns 401 without auth token', async () => {
    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler, TEST_TEAM_ID, null);
    expect(response.status).toBe(401);
  });

  // -------------------------------------------------------------------------
  // Test 11: 403 when authenticated user has no membership on the target team.
  //
  // The backfillRosterRoles endpoint declares ONLY Forbidden(403) in its error
  // schema (packages/domain/src/api/Roster.ts). There is no 404 path.
  // When requireMembership fails (user not a member of teamId), it fails with
  // Forbidden → 403.
  // -------------------------------------------------------------------------
  it('returns 403 when authenticated user has no membership on target team', async () => {
    // TEST_OTHER_TEAM_ID has no entry in MockTeamsRepositoryLayer OR membersStore,
    // so the admin user has no membership on it → requireMembership → Forbidden → 403
    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler, TEST_OTHER_TEAM_ID, 'admin-token');

    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // Test 12: Cross-team isolation — each repo method called with the path teamId
  //
  // Asserts independently:
  //   - findActiveRostersWithRole called at least once, every call with TEST_TEAM_ID
  //   - countActiveRostersWithRole called at least once, every call with TEST_TEAM_ID
  //   - the limit passed to findActiveRostersWithRole is exactly 50 (the batch size
  //     from the spec; catching wrong/absent batch size)
  // -------------------------------------------------------------------------
  it('cross-team isolation: both repo methods called only with path teamId; find limit = 50', async () => {
    mockRosterCount = 0;
    mockRosterMissingRows = [];

    const handler = createHandler();
    await postBackfillRosterRoles(handler, TEST_TEAM_ID, 'admin-token');

    // findActiveRostersWithRole must have been called at least once
    expect(findActiveRostersWithRoleCalls.length).toBeGreaterThan(0);
    expect(findActiveRostersWithRoleCalls.every((c) => c.teamId === TEST_TEAM_ID)).toBe(true);

    // countActiveRostersWithRole must have been called at least once
    expect(countActiveRostersWithRoleCalls.length).toBeGreaterThan(0);
    expect(countActiveRostersWithRoleCalls.every((c) => c.teamId === TEST_TEAM_ID)).toBe(true);

    // The batch limit passed to find must be 50 (spec-mandated batch size)
    expect(findActiveRostersWithRoleCalls.every((c) => c.limit === 50)).toBe(true);
  });
});
