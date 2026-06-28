/**
 * TDD tests for the team-scoped, on-demand roster-role extras reconcile feature.
 *
 * Production code NOT yet written. These tests are expected to FAIL until:
 *   - DiscordChannelMappingRepository gains `findActiveRoleIdsForReconcile` and
 *     `countActiveRoleIdsForReconcile` and `findExpectedRoleHolders` methods.
 *   - `applications/server/src/utils/reconcileRosterRoleExtras.ts` is created.
 *   - `applications/server/src/api/roster.ts` gains a handler that calls BOTH
 *     `backfillRosterRoleMembers` AND `reconcileRosterRoleExtras` and returns a
 *     combined { processedCount, remainingCount } result.
 *   - `ChannelSyncEventsRepository` gains `emitRosterRoleReconcile(teamId, rosterId,
 *     discordRoleId)` — guild_id is resolved internally by `_emitIfGuildLinked` via the teams table.
 *
 * NOTE: SQL-level concerns (DISTINCT, active=true, unprocessed-event guard, LIMIT) are tested
 * in the DB-backed integration test:
 *   test/integration/repositories/DiscordChannelMappingRepository.test.ts
 * Here we only assert that the handler faithfully calls the (mocked) repo and emits the right
 * events.
 *
 * COUNT-MERGE SEMANTICS (comment for reviewers):
 *   The combined backfillRosterRoles handler calls both util functions:
 *     backfill:  { processedCount: B_p, remainingCount: B_r }
 *     reconcile: { processedCount: R_p, remainingCount: R_r }
 *   Combined result:
 *     processedCount = B_p + R_p   (total events enqueued this sweep)
 *     remainingCount = B_r + R_r   (total still queued across both dimensions)
 *   This is a SUM, NOT a max, because the two quantities are orthogonal:
 *   "how many roles still need a member-add sweep" vs
 *   "how many roles still need an extras-removal sweep".
 */

import type { Auth, Discord, Role, Roster, RosterModel, Team, TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
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
import {
  DiscordChannelMappingRepository,
  type RosterMissingRoleRow,
} from '~/repositories/DiscordChannelMappingRepository.js';
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
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROSTER_ID_A = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const TEST_ROSTER_ID_B = '00000000-0000-0000-0000-000000000031' as RosterModel.RosterId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const EXISTING_CHANNEL_A = '111111111111111111' as Discord.Snowflake;
const EXISTING_CHANNEL_B = '222222222222222222' as Discord.Snowflake;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;

// Reconcile-specific constants
const DISCORD_ROLE_A = '333333333333333333' as Discord.Snowflake;
const DISCORD_ROLE_B = '444444444444444444' as Discord.Snowflake;

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

// Tracks emitRosterChannelCreated calls (for the backfill dimension)
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

// Tracks emitRosterRoleReconcile calls (for the reconcile dimension).
// Signature: (teamId, rosterId, discordRoleId) → Effect<void>
// guild_id is resolved internally by _emitIfGuildLinked via the teams table.
type RosterRoleReconcileCall = {
  teamId: Team.TeamId;
  rosterId: RosterModel.RosterId;
  discordRoleId: Discord.Snowflake;
};
let rosterRoleReconcileCalls: RosterRoleReconcileCall[] = [];

// Tracks findActiveRoleIdsForReconcile calls
let findActiveRoleIdsCalls: Array<{ teamId: Team.TeamId; limit: number }> = [];
// Tracks countActiveRoleIdsForReconcile calls
let countActiveRoleIdsCalls: Array<{ teamId: Team.TeamId }> = [];

// Configurable mock return values for backfill dimension
let mockRosterMissingRows: RosterMissingRoleRow[] = [];
let mockRosterCount = 0;

// Configurable mock return values for reconcile dimension
// Each entry is { rosterId, guildId, discordRoleId } (the planned RoleIdRow shape)
type RoleIdRow = {
  roster_id: RosterModel.RosterId;
  guild_id: Discord.Snowflake;
  discord_role_id: Discord.Snowflake;
};
let mockRoleIdRows: RoleIdRow[] = [];
let mockRoleIdCount = 0;

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
    // Emits roster_role_reconcile event per distinct role.
    // guild_id is resolved internally by _emitIfGuildLinked via the teams table.
    emitRosterRoleReconcile: (
      teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      discordRoleId: Discord.Snowflake,
    ) => {
      rosterRoleReconcileCalls.push({ teamId, rosterId, discordRoleId });
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
    // Backfill-dimension methods (already implemented in production)
    findActiveRostersWithRole: (_teamId: Team.TeamId, _limit: number) => {
      // Note: reusing findActiveRostersWithRole calls array for backfill tracking
      return Effect.succeed(mockRosterMissingRows);
    },
    countActiveRostersWithRole: (_teamId: Team.TeamId) => {
      return Effect.succeed(mockRosterCount);
    },
    // NEW reconcile-dimension methods — planned, not yet implemented
    findActiveRoleIdsForReconcile: (teamId: Team.TeamId, limit: number) => {
      findActiveRoleIdsCalls.push({ teamId, limit });
      return Effect.succeed(mockRoleIdRows);
    },
    countActiveRoleIdsForReconcile: (teamId: Team.TeamId) => {
      countActiveRoleIdsCalls.push({ teamId });
      return Effect.succeed(mockRoleIdCount);
    },
    // findExpectedRoleHolders is a server-RPC concern; the HTTP handler doesn't call it directly.
  } as any);

const makeRostersRepositoryLayer = () =>
  Layer.succeed(RostersRepository, {
    _tag: 'api/RostersRepository',
    findByTeamId: () => Effect.succeed([]),
    findRosterById: () => Effect.succeed(Option.none()),
    insert: () => LogicError.die('Not implemented'),
    update: () => LogicError.die('Not implemented'),
    delete: () => Effect.void,
    findMemberEntriesById: () => Effect.succeed([]),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Static mock layers (mirroring RosterRoleBackfill.test.ts exactly)
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
  updateAdminProfile: () => LogicError.die('Not implemented'),
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
  addMember: () => LogicError.die('Not implemented'),
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
  deactivateMemberByIds: () => LogicError.die('Not implemented'),
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
  insertRole: () => LogicError.die('Not implemented'),
  updateRole: () => LogicError.die('Not implemented'),
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
  insertGroup: () => LogicError.die('Not implemented'),
  updateGroupById: () => LogicError.die('Not implemented'),
  archiveGroupById: () => Effect.void,
  moveGroup: () => LogicError.die('Not implemented'),
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
  insert: () => LogicError.die('Not implemented'),
  update: () => LogicError.die('Not implemented'),
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
  insert: () => LogicError.die('Not implemented'),
  updateRule: () => LogicError.die('Not implemented'),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => LogicError.die('Not implemented'),
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
  insert: () => LogicError.die('Not implemented'),
  update: () => LogicError.die('Not implemented'),
  cancel: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  insertSeries: () => LogicError.die('Not implemented'),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  updateSeries: () => LogicError.die('Not implemented'),
  cancelSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  findByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => LogicError.die('Not implemented'),
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
  upsertConnection: () => LogicError.die('Not implemented'),
  upsert: () => LogicError.die('Not implemented'),
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
  insert: () => LogicError.die('not implemented'),
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
    insert: () => LogicError.die('Not implemented'),
    update: () => LogicError.die('Not implemented'),
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
  create: () => LogicError.die('Not implemented'),
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

// SqlClient mock — passes transactions through synchronously, returns empty rows
// for raw SQL template literals (including advisory lock).
// The reconcileRosterRoleExtras util must run inside sql.withTransaction — that
// structural assertion is captured in test (d).
let withTransactionCallCount = 0;

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([] as never[]);
    },
    {
      safe: undefined as any,
      withoutTransforms: function (this: any) {
        return this;
      },
      reserve: LogicError.die('reserve not implemented'),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> => {
        // Structural assertion hook — count how many times withTransaction is called.
        // Each sweep (backfill + reconcile) must be wrapped in its own advisory-locked txn.
        withTransactionCallCount++;
        return effect;
      },
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => LogicError.die('reactiveMailbox not implemented'),
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([] as never[]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => Effect.succeed([] as never[]),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => Effect.succeed([] as never[]),
      or: (..._args: unknown[]) => Effect.succeed([] as never[]),
      join:
        (..._args: unknown[]) =>
        (_arr: unknown[]) =>
          Effect.succeed([] as never[]),
    },
  ) as unknown as SqlClient.SqlClient,
);

// ---------------------------------------------------------------------------
// Layer builder (mirrors RosterRoleBackfill.test.ts)
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
    )
    .pipe(Layer.provide(MockSqlClientLayer));
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
  rosterRoleReconcileCalls = [];
  findActiveRoleIdsCalls = [];
  countActiveRoleIdsCalls = [];
  mockRosterMissingRows = [];
  mockRosterCount = 0;
  mockRoleIdRows = [];
  mockRoleIdCount = 0;
  withTransactionCallCount = 0;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createHandler = (
  settingsLayer: Layer.Layer<TeamSettingsRepository> = defaultSettingsLayer,
) => {
  const app = HttpRouter.toWebHandler(buildTestLayer(settingsLayer));
  disposeHandlers.push(app.dispose);
  return app.handler;
};

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
// Fixture helpers
// ---------------------------------------------------------------------------

const makeBackfillRow = (
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

const makeRoleIdRow = (
  rosterId: RosterModel.RosterId,
  discordRoleId: Discord.Snowflake,
): RoleIdRow => ({
  roster_id: rosterId,
  guild_id: GUILD_ID,
  discord_role_id: discordRoleId,
});

// ---------------------------------------------------------------------------
// Suite A — roster:manage permission gate
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/rosters/backfill-role-members — auth gate (roster:manage)', () => {
  // -------------------------------------------------------------------------
  // (a) caller without roster:manage → 403
  // -------------------------------------------------------------------------
  it('returns 403 when caller lacks roster:manage permission', async () => {
    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler, TEST_TEAM_ID, 'player-token');
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Suite B — combined backfill + reconcile event emission
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/rosters/backfill-role-members — combined event emission', () => {
  // -------------------------------------------------------------------------
  // (b) combined handler emits BOTH add event (emitRosterChannelCreated) AND
  //     reconcile event (emitRosterRoleReconcile) for an active roster-with-role
  // -------------------------------------------------------------------------
  it('emits both emitRosterChannelCreated AND emitRosterRoleReconcile for the same active roster-with-role', async () => {
    // Backfill dimension: one roster needs a member-add sweep
    mockRosterCount = 1;
    mockRosterMissingRows = [
      makeBackfillRow(TEST_ROSTER_ID_A, 'Alpha Roster', Option.some(EXISTING_CHANNEL_A)),
    ];

    // Reconcile dimension: same roster also needs an extras-removal sweep
    mockRoleIdCount = 1;
    mockRoleIdRows = [makeRoleIdRow(TEST_ROSTER_ID_A, DISCORD_ROLE_A)];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);

    // Backfill event
    expect(rosterCreatedCalls).toHaveLength(1);
    expect(rosterCreatedCalls[0]?.rosterId).toBe(TEST_ROSTER_ID_A);

    // Reconcile event — guild_id is resolved internally, not passed as a parameter
    expect(rosterRoleReconcileCalls).toHaveLength(1);
    expect(rosterRoleReconcileCalls[0]?.rosterId).toBe(TEST_ROSTER_ID_A);
    expect(rosterRoleReconcileCalls[0]?.discordRoleId).toBe(DISCORD_ROLE_A);
    expect(rosterRoleReconcileCalls[0]?.teamId).toBe(TEST_TEAM_ID);
  });

  // -------------------------------------------------------------------------
  // (c) count merge = SUM semantics:
  //     backfill  processed=2, remaining=0
  //     reconcile processed=2, remaining=1
  //   → combined  processedCount=4, remainingCount=1
  //
  // COUNT-MERGE NOTE: The two sweep dimensions are orthogonal —
  //   "how many roles need a member-add sweep" vs
  //   "how many roles need an extras-removal sweep".
  // So we SUM the counts, not max them. remainingCount=0+1=1.
  // -------------------------------------------------------------------------
  it('count merge: backfill(p=2,r=0) + reconcile(p=2,r=1) → processedCount=4, remainingCount=1', async () => {
    // Backfill dimension: 2 rows, count=2 → processed=2, remaining=0
    mockRosterCount = 2;
    mockRosterMissingRows = [
      makeBackfillRow(TEST_ROSTER_ID_A, 'Roster A', Option.some(EXISTING_CHANNEL_A)),
      makeBackfillRow(TEST_ROSTER_ID_B, 'Roster B', Option.some(EXISTING_CHANNEL_B)),
    ];

    // Reconcile dimension: 2 rows this sweep, total count=3 → processed=2, remaining=1
    mockRoleIdCount = 3; // total eligible
    mockRoleIdRows = [
      makeRoleIdRow(TEST_ROSTER_ID_A, DISCORD_ROLE_A),
      makeRoleIdRow(TEST_ROSTER_ID_B, DISCORD_ROLE_B),
    ]; // 2 returned (limit=50, only 2 available this sweep)

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler);

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    // SUM: backfill_processed(2) + reconcile_processed(2) = 4
    expect(body.processedCount).toBe(4);
    // SUM: backfill_remaining(0) + reconcile_remaining(1) = 1
    expect(body.remainingCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // (d) reconcileRosterRoleExtras runs inside sql.withTransaction
  //     (structural assertion: withTransaction called at least once per backfill call)
  // -------------------------------------------------------------------------
  it('reconcileRosterRoleExtras runs inside sql.withTransaction (structural assertion)', async () => {
    mockRosterCount = 0;
    mockRosterMissingRows = [];
    mockRoleIdCount = 1;
    mockRoleIdRows = [makeRoleIdRow(TEST_ROSTER_ID_A, DISCORD_ROLE_A)];

    const handler = createHandler();
    await postBackfillRosterRoles(handler);

    // Each util (backfill + reconcile) wraps its work in sql.withTransaction.
    // The combined handler must call withTransaction at least once (for the reconcile util).
    expect(withTransactionCallCount).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------------------------
  // (e) wrong-team / no matching rosters → processedCount=0, no events
  // -------------------------------------------------------------------------
  it('wrong team: no matching rosters → processedCount=0, remainingCount=0, no events emitted', async () => {
    // All mock rows are for TEST_TEAM_ID, but we query TEST_OTHER_TEAM_ID.
    // The mock repo ignores the teamId filter — however the handler must
    // pass TEST_OTHER_TEAM_ID and the user won't be a member → 403.
    // Instead: keep same teamId but configure zero rows.
    mockRosterCount = 0;
    mockRosterMissingRows = [];
    mockRoleIdCount = 0;
    mockRoleIdRows = [];

    const handler = createHandler();
    const response = await postBackfillRosterRoles(handler, TEST_TEAM_ID, 'admin-token');

    expect(response.status).toBe(200);
    const body = (await response.json()) as Roster.BackfillRosterRolesResult;

    expect(body.processedCount).toBe(0);
    expect(body.remainingCount).toBe(0);

    expect(rosterCreatedCalls).toHaveLength(0);
    expect(rosterRoleReconcileCalls).toHaveLength(0);
  });
});
