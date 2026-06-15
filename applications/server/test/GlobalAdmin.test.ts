/**
 * GlobalAdmin.test.ts — TDD test suite for "As a global admin, I can manage global admins"
 *
 * Story: feat/manage-global-admins
 * Plan:  .plans/manage-global-admins.md
 *
 * These tests are written BEFORE implementation and are expected to fail until the
 * following are implemented:
 *
 * 1. `applications/server/src/api/global-admin.ts`   — GlobalAdminApiLive handler
 * 2. `applications/server/src/api/api.ts`             — GlobalAdminApiGroup added to Api
 * 3. `applications/server/src/api/index.ts`           — GlobalAdminApiLive wired into ApiLive
 * 4. `applications/server/src/services/GlobalAdminAllowlist.ts` (see contract below)
 * 5. New UsersRepository methods (see contract below)
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — GlobalAdminAllowlist service
 * ---------------------------------------------------------------------------
 * Expected location: `applications/server/src/services/GlobalAdminAllowlist.ts`
 *
 * The service must:
 *   - Extend `ServiceMap.Service` (like BotInfoStore) so it is injectable via `Layer.succeed`.
 *   - Expose a single method `asEffect()` that returns `Effect<ReadonlySet<string>>`.
 *   - Have a `Default` live layer that reads from `globalAdminDiscordIds` (from `~/env.js`).
 *   - Be injected into the global-admin handler so tests can supply a controlled set without
 *     touching process.env.
 *   - Tag string: `'api/GlobalAdminAllowlist'` (follow codebase convention).
 *
 * Shape (pseudo-code):
 *   export interface GlobalAdminAllowlistShape {
 *     readonly asEffect: Effect.Effect<ReadonlySet<string>>
 *   }
 *   export class GlobalAdminAllowlist extends ServiceMap.Service<...>()('api/GlobalAdminAllowlist') {
 *     static readonly Default = Layer.sync(GlobalAdminAllowlist, () => ({ asEffect: Effect.succeed(globalAdminDiscordIds) }))
 *   }
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — new UsersRepository methods
 * ---------------------------------------------------------------------------
 *   listGlobalAdmins(): Effect<ReadonlyArray<User.User>>
 *     Returns all DB rows where is_global_admin = true.
 *
 *   grantGlobalAdmin(discordId: string): Effect<Option<User.User>>
 *     Sets is_global_admin=true, global_admin_granted_at=COALESCE(existing, now()).
 *     Returns Option.some(updatedRow) if the discord_id exists, Option.none() otherwise.
 *     Idempotent — calling again on an already-admin row is a no-op returning Option.some.
 *
 *   revokeGlobalAdminGuarded(userId: User.UserId, envAdminCount: number): Effect<Option<User.User>>
 *     Single conditional UPDATE: only succeeds (sets is_global_admin=false) when
 *     (COUNT of DB admins) + envAdminCount > 1.
 *     Returns Option.some(updatedRow) on success, Option.none() when the guard blocks.
 *
 *   countGlobalAdmins(): Effect<number>
 *     Returns count of DB rows where is_global_admin = true.
 *
 *   findByDiscordId(id: string): Effect<Option<User.User>>  — already exists
 *   findById(id: User.UserId): Effect<Option<User.User>>    — already exists
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — handler endpoint routing
 * ---------------------------------------------------------------------------
 *   GET    /auth/global-admins         → listGlobalAdmins
 *   POST   /auth/global-admins         → grantGlobalAdmin (body: { discordId })
 *   DELETE /auth/global-admins/:userId → revokeGlobalAdmin
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — handler list merge/dedup logic
 * ---------------------------------------------------------------------------
 *   1. Fetch DB admins (listGlobalAdmins).
 *   2. Fetch allowlist IDs (GlobalAdminAllowlist).
 *   3. For each DB admin, look up whether their discordId is in the allowlist.
 *      If yes → source='env', revocable=false.
 *      If no  → source='db', revocable=true (unless isSelf).
 *   4. For env IDs not covered by any DB admin row, call findByDiscordId.
 *      If found → add row with source='env', revocable=false.
 *      If not found → add row with userId=null, username=null, grantedAt=null, source='env', revocable=false.
 *   5. Dedup by discordId (env wins).
 *   6. isSelf = item.userId === currentUser.id.
 *   7. self row: revocable=false regardless of source.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT — handler revoke guard sequence
 * ---------------------------------------------------------------------------
 *   Self check → findById (404 if none / not a DB admin) → env-managed check →
 *   envAdminCount = allowlist.size (distinct IDs not already counted as DB admins excluded) →
 *   revokeGlobalAdminGuarded(userId, envAdminCount) → if none → LastAdminError(409) → if some → 204.
 *
 *   NOTE on envAdminCount: the handler passes the number of DISTINCT env allowlist IDs to
 *   revokeGlobalAdminGuarded so the guard uses the effective count (DB + env), not just DB.
 */

import type { Auth, Discord, GlobalAdminApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
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
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
// TODO(implementer): create this file at the path below.
// Shape: class GlobalAdminAllowlist extends ServiceMap.Service<...>()('api/GlobalAdminAllowlist')
//        with .asEffect() → Effect<ReadonlySet<string>>
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const OTHER_ADMIN_USER_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TARGET_USER_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;

const SELF_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const OTHER_ADMIN_DISCORD_ID = '222222222222222222' as Discord.Snowflake;
const TARGET_DISCORD_ID = '333333333333333333' as Discord.Snowflake;
const ENV_ONLY_DISCORD_ID = '444444444444444444' as Discord.Snowflake;
const UNKNOWN_DISCORD_ID = '999999999999999999' as Discord.Snowflake;

const GRANTED_AT = DateTime.fromDateUnsafe(new Date('2024-01-01T00:00:00Z'));

// ---------------------------------------------------------------------------
// Shared user fixtures
// ---------------------------------------------------------------------------

const makeUser = (overrides: {
  id: Auth.UserId;
  discord_id: string;
  is_global_admin: boolean;
  global_admin_granted_at?: typeof GRANTED_AT | null;
  username?: string;
}) => ({
  id: overrides.id,
  discord_id: overrides.discord_id,
  username: overrides.username ?? `user_${overrides.discord_id}`,
  avatar: Option.none(),
  is_profile_complete: true,
  is_global_admin: overrides.is_global_admin,
  global_admin_granted_at:
    overrides.global_admin_granted_at === undefined
      ? overrides.is_global_admin
        ? Option.some(GRANTED_AT)
        : Option.none()
      : overrides.global_admin_granted_at === null
        ? Option.none()
        : Option.some(overrides.global_admin_granted_at),
  name: Option.none(),
  birth_date: Option.none(),
  gender: Option.none(),
  locale: 'en' as const,
  discord_display_name: Option.none(),
  discord_nickname: Option.none(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
});

/** The currently-logged-in user (a global admin). */
const adminUser = makeUser({
  id: TEST_USER_ID,
  discord_id: SELF_DISCORD_ID,
  is_global_admin: true,
});

/** A second DB admin. */
const otherAdminUser = makeUser({
  id: OTHER_ADMIN_USER_ID,
  discord_id: OTHER_ADMIN_DISCORD_ID,
  is_global_admin: true,
});

/** A non-admin user that can be a grant/revoke target. */
const nonAdminUser = makeUser({
  id: TARGET_USER_ID,
  discord_id: TARGET_DISCORD_ID,
  is_global_admin: false,
});

/** A non-admin user that is in the env allowlist (env-managed). */
const envManagedDbUser = makeUser({
  id: TARGET_USER_ID,
  discord_id: ENV_ONLY_DISCORD_ID,
  is_global_admin: false,
});

// Sessions store used by MockSessionsRepositoryLayer
const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_USER_ID);
sessionsStore.set('non-admin-token', TARGET_USER_ID);

// ---------------------------------------------------------------------------
// Minimal shared mock layers (infrastructure that every test needs)
// ---------------------------------------------------------------------------

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  createAuthorizationURL: () =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () => Effect.die(new Error('not needed')),
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
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('not needed')),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('not needed')),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('not needed')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('not needed')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('not needed')),
  update: () => Effect.die(new Error('not needed')),
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
  insertRole: () => Effect.die(new Error('not needed')),
  updateRole: () => Effect.die(new Error('not needed')),
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
  insertGroup: () => Effect.die(new Error('not needed')),
  updateGroupById: () => Effect.die(new Error('not needed')),
  archiveGroupById: () => Effect.void,
  moveGroup: () => Effect.die(new Error('not needed')),
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
  insert: () => Effect.die(new Error('not needed')),
  insertTrainingType: () => Effect.die(new Error('not needed')),
  update: () => Effect.die(new Error('not needed')),
  updateTrainingType: () => Effect.die(new Error('not needed')),
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
  insert: () => Effect.die(new Error('not needed')),
  updateRule: () => Effect.die(new Error('not needed')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('not needed')),
  updateRuleById: () => Effect.die(new Error('not needed')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => Effect.die(new Error('not needed')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.die(new Error('not needed')),
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
  insert: () => Effect.die(new Error('not needed')),
  insertEvent: () => Effect.die(new Error('not needed')),
  update: () => Effect.die(new Error('not needed')),
  updateEvent: () => Effect.die(new Error('not needed')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
  insertSeries: () => Effect.die(new Error('not needed')),
  insertEventSeries: () => Effect.die(new Error('not needed')),
  findByTeamId: () => Effect.succeed([]),
  findSeriesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findSeriesById: () => Effect.succeed(Option.none()),
  updateSeries: () => Effect.die(new Error('not needed')),
  updateEventSeries: () => Effect.die(new Error('not needed')),
  cancelSeries: () => Effect.void,
  cancelEventSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('not needed')),
  upsertRsvp: () => Effect.die(new Error('not needed')),
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
  create: () => Effect.die(new Error('not needed')),
  regenerate: () => Effect.die(new Error('not needed')),
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
  insert: () => Effect.die(new Error('not needed')),
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
    insert: () => Effect.die(new Error('not needed')),
    update: () => Effect.die(new Error('not needed')),
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

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

// ---------------------------------------------------------------------------
// Allowlist mock factories
// ---------------------------------------------------------------------------

/** An allowlist mock layer with no env admins. */
const makeEmptyAllowlistLayer = () =>
  Layer.succeed(GlobalAdminAllowlist, {
    asEffect: Effect.succeed(new Set<string>()),
  } as any);

/** An allowlist mock layer containing specific discord IDs. */
const makeAllowlistLayer = (ids: ReadonlyArray<string>) =>
  Layer.succeed(GlobalAdminAllowlist, {
    asEffect: Effect.succeed(new Set(ids)),
  } as any);

// ---------------------------------------------------------------------------
// UsersRepository mock factories
// ---------------------------------------------------------------------------

/**
 * Builds a UsersRepository layer with configurable behaviour for the new
 * global-admin methods. The existing methods (findById, findByDiscordId) are
 * wired to look up from a provided user map.
 */
const makeUsersRepositoryLayer = (opts: {
  /** Users indexed by userId. */
  byId?: Map<string, ReturnType<typeof makeUser>>;
  /** Users indexed by discordId. */
  byDiscordId?: Map<string, ReturnType<typeof makeUser>>;
  /** DB admin rows returned by listGlobalAdmins(). */
  dbAdmins?: ReadonlyArray<ReturnType<typeof makeUser>>;
  /** What grantGlobalAdmin returns. */
  grantResult?: Option.Option<ReturnType<typeof makeUser>>;
  /** What revokeGlobalAdminGuarded returns. */
  revokeResult?: Option.Option<ReturnType<typeof makeUser>>;
  /** Spy: records args passed to grantGlobalAdmin. */
  grantSpy?: { discordId: string | null };
  /** Spy: records args passed to revokeGlobalAdminGuarded. */
  revokeSpy?: { userId: string | null; envAdminCount: number | null };
}) => {
  const byId = opts.byId ?? new Map();
  const byDiscordId = opts.byDiscordId ?? new Map();

  return Layer.succeed(UsersRepository, {
    _tag: 'api/UsersRepository',
    findById: (id: string) =>
      Effect.succeed(byId.has(id) ? Option.some(byId.get(id)!) : Option.none()),
    findByDiscordId: (id: string) =>
      Effect.succeed(byDiscordId.has(id) ? Option.some(byDiscordId.get(id)!) : Option.none()),
    upsertFromDiscord: () => Effect.succeed(adminUser),
    completeProfile: () => Effect.succeed(adminUser),
    updateLocale: () => Effect.succeed(adminUser),
    updateAdminProfile: () => Effect.succeed(adminUser),
    listGlobalAdmins: () => Effect.succeed(opts.dbAdmins ?? []),
    grantGlobalAdmin: (discordId: string) => {
      if (opts.grantSpy) {
        opts.grantSpy.discordId = discordId;
      }
      return Effect.succeed(opts.grantResult ?? Option.none());
    },
    revokeGlobalAdminGuarded: (userId: string, envAdminCount: number) => {
      if (opts.revokeSpy) {
        opts.revokeSpy.userId = userId;
        opts.revokeSpy.envAdminCount = envAdminCount;
      }
      return Effect.succeed(opts.revokeResult ?? Option.none());
    },
  } as any);
};

// ---------------------------------------------------------------------------
// Test layer builder
// ---------------------------------------------------------------------------

/**
 * Assembles the full test layer, accepting per-test overrides for:
 *   - usersRepositoryLayer: controls repo behaviour
 *   - allowlistLayer: controls env allowlist
 *
 * All other dependencies are satisfied by minimal no-op mocks.
 */
const buildTestLayer = (
  usersRepositoryLayer: ReturnType<typeof makeUsersRepositoryLayer>,
  allowlistLayer: ReturnType<typeof makeAllowlistLayer>,
) =>
  ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(MockDiscordOAuthLayer),
    Layer.provide(usersRepositoryLayer),
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
          MockTeamSettingsRepositoryLayer,
        ),
        MockOAuthConnectionsRepositoryLayer,
      ),
    ),
    Layer.provide(MockAchievementAdminLayers),
    Layer.provide(allowlistLayer),
  )
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Makes an authenticated GET /auth/global-admins request. */
const makeGetRequest = (token: string) =>
  new Request('http://localhost/auth/global-admins', {
    headers: { Authorization: `Bearer ${token}` },
  });

/** Makes an authenticated POST /auth/global-admins request. */
const makePostRequest = (token: string, body: { discordId: string }) =>
  new Request('http://localhost/auth/global-admins', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

/** Makes an authenticated DELETE /auth/global-admins/:userId request. */
const makeDeleteRequest = (token: string, userId: string) =>
  new Request(`http://localhost/auth/global-admins/${userId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('GlobalAdmin API', () => {
  // -------------------------------------------------------------------------
  // Test 1 — 403 when caller is not a global admin
  // -------------------------------------------------------------------------
  describe('Test 1 — 403 GlobalAdminForbidden when caller is not a global admin', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      // non-admin-token resolves to TARGET_USER_ID which has is_global_admin: false
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TARGET_USER_ID, nonAdminUser]]),
        dbAdmins: [],
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('GET /auth/global-admins returns 403 for non-admin', async () => {
      const response = await handler(makeGetRequest('non-admin-token'));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminForbidden');
    });

    it('POST /auth/global-admins returns 403 for non-admin', async () => {
      const response = await handler(
        makePostRequest('non-admin-token', { discordId: TARGET_DISCORD_ID }),
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminForbidden');
    });

    it('DELETE /auth/global-admins/:userId returns 403 for non-admin', async () => {
      const response = await handler(makeDeleteRequest('non-admin-token', TARGET_USER_ID));
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminForbidden');
    });
  });

  // -------------------------------------------------------------------------
  // Test 2 — listGlobalAdmins: DB admins with correct isSelf, revocable, source, grantedAt
  // -------------------------------------------------------------------------
  describe('Test 2 — listGlobalAdmins: correct isSelf/revocable/source/grantedAt for DB admins', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser, otherAdminUser],
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 200 with the list of DB admins', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      expect(response.status).toBe(200);
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body).toHaveLength(2);
    });

    it('self row has isSelf=true, revocable=false, source=db', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const selfRow = body.find((r) => r.discordId === SELF_DISCORD_ID);
      expect(selfRow).toBeDefined();
      expect(selfRow?.isSelf).toBe(true);
      expect(selfRow?.revocable).toBe(false);
      expect(selfRow?.source).toBe('db');
    });

    it('other DB admin has isSelf=false, revocable=true, source=db', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const otherRow = body.find((r) => r.discordId === OTHER_ADMIN_DISCORD_ID);
      expect(otherRow).toBeDefined();
      expect(otherRow?.isSelf).toBe(false);
      expect(otherRow?.revocable).toBe(true);
      expect(otherRow?.source).toBe('db');
    });

    it('DB admin rows have grantedAt present (non-null)', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      for (const row of body) {
        // grantedAt is an Option serialized as nullable JSON — should not be null for DB admins with global_admin_granted_at set
        expect(row.grantedAt).not.toBeNull();
      }
    });

    it('DB admin rows have userId and username present', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      for (const row of body) {
        expect(row.userId).not.toBeNull();
        expect(row.username).not.toBeNull();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Test 3 — Dedupe: DB admin who is also in env allowlist → one row, source='env', revocable=false
  // -------------------------------------------------------------------------
  describe('Test 3 — Dedupe: DB+env overlap → single env row, no duplicate discordId', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      // adminUser (SELF_DISCORD_ID) is in both DB and the allowlist
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        byDiscordId: new Map([[SELF_DISCORD_ID, adminUser]]),
        dbAdmins: [adminUser],
      });
      const app = HttpRouter.toWebHandler(
        buildTestLayer(usersLayer, makeAllowlistLayer([SELF_DISCORD_ID])),
      );
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns exactly ONE row for the deduped admin (no duplicate discordId)', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      expect(response.status).toBe(200);
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const rows = body.filter((r) => r.discordId === SELF_DISCORD_ID);
      expect(rows).toHaveLength(1);
    });

    it('deduped row has source=env and revocable=false', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const row = body.find((r) => r.discordId === SELF_DISCORD_ID);
      expect(row?.source).toBe('env');
      expect(row?.revocable).toBe(false);
    });

    it('deduped row retains userId and username from the DB row', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const row = body.find((r) => r.discordId === SELF_DISCORD_ID);
      expect(row?.userId).not.toBeNull();
      expect(row?.username).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 4 — Env-only admin with NO users row → source='env', userId=null, username=null, grantedAt=null
  // -------------------------------------------------------------------------
  describe('Test 4 — Env-only admin with no users row → userId/username/grantedAt null', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      // ENV_ONLY_DISCORD_ID is in the allowlist but findByDiscordId returns none
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        byDiscordId: new Map(), // findByDiscordId → none for ENV_ONLY_DISCORD_ID
        dbAdmins: [adminUser],
      });
      const app = HttpRouter.toWebHandler(
        buildTestLayer(usersLayer, makeAllowlistLayer([ENV_ONLY_DISCORD_ID])),
      );
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('env-only no-row admin appears in the list', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      expect(response.status).toBe(200);
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const envRow = body.find((r) => r.discordId === ENV_ONLY_DISCORD_ID);
      expect(envRow).toBeDefined();
    });

    it('env-only no-row admin has source=env, revocable=false, userId=null, username=null, grantedAt=null', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const envRow = body.find((r) => r.discordId === ENV_ONLY_DISCORD_ID);
      expect(envRow?.source).toBe('env');
      expect(envRow?.revocable).toBe(false);
      expect(envRow?.userId).toBeNull();
      expect(envRow?.username).toBeNull();
      expect(envRow?.grantedAt).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 5 — Env admin who has a users row but is_global_admin=false → source='env', revocable=false
  // -------------------------------------------------------------------------
  describe('Test 5 — Env admin with non-admin DB row → source=env, revocable=false, userId/username present', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      // envManagedDbUser has is_global_admin=false but is in the allowlist
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        byDiscordId: new Map([[ENV_ONLY_DISCORD_ID, envManagedDbUser]]),
        dbAdmins: [adminUser], // envManagedDbUser NOT in DB admins
      });
      const app = HttpRouter.toWebHandler(
        buildTestLayer(usersLayer, makeAllowlistLayer([ENV_ONLY_DISCORD_ID])),
      );
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('env admin with non-admin DB row appears once with source=env', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      expect(response.status).toBe(200);
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const rows = body.filter((r) => r.discordId === ENV_ONLY_DISCORD_ID);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.source).toBe('env');
    });

    it('env admin with non-admin DB row has revocable=false', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const row = body.find((r) => r.discordId === ENV_ONLY_DISCORD_ID);
      expect(row?.revocable).toBe(false);
    });

    it('env admin with non-admin DB row has userId and username from DB', async () => {
      const response = await handler(makeGetRequest('admin-token'));
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const row = body.find((r) => r.discordId === ENV_ONLY_DISCORD_ID);
      expect(row?.userId).not.toBeNull();
      expect(row?.username).not.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 6 — grantGlobalAdmin new target → 200, refreshed list contains target
  // -------------------------------------------------------------------------
  describe('Test 6 — grantGlobalAdmin new target → 200, list updated, repo called with discordId', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const grantSpy = { discordId: null as string | null };
    const grantedUser = makeUser({
      id: TARGET_USER_ID,
      discord_id: TARGET_DISCORD_ID,
      is_global_admin: true,
    });

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser, grantedUser], // refreshed list after grant includes grantedUser
        grantResult: Option.some(grantedUser),
        grantSpy,
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 200', async () => {
      const response = await handler(
        makePostRequest('admin-token', { discordId: TARGET_DISCORD_ID }),
      );
      expect(response.status).toBe(200);
    });

    it('refreshed list contains the newly granted target', async () => {
      const response = await handler(
        makePostRequest('admin-token', { discordId: TARGET_DISCORD_ID }),
      );
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      const targetRow = body.find((r) => r.discordId === TARGET_DISCORD_ID);
      expect(targetRow).toBeDefined();
    });

    it('repo grantGlobalAdmin was called with the correct discordId', async () => {
      await handler(makePostRequest('admin-token', { discordId: TARGET_DISCORD_ID }));
      expect(grantSpy.discordId).toBe(TARGET_DISCORD_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Test 7 — grant idempotent: target already admin → 200, no error, list count unchanged
  // -------------------------------------------------------------------------
  describe('Test 7 — grant idempotent: already-admin target → 200, no error', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser, otherAdminUser],
        // grantResult=some means idempotent success
        grantResult: Option.some(otherAdminUser),
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 200 when target is already a DB admin', async () => {
      const response = await handler(
        makePostRequest('admin-token', { discordId: OTHER_ADMIN_DISCORD_ID }),
      );
      expect(response.status).toBe(200);
    });

    it('list still contains both admins after idempotent grant', async () => {
      const response = await handler(
        makePostRequest('admin-token', { discordId: OTHER_ADMIN_DISCORD_ID }),
      );
      const body: GlobalAdminApi.GlobalAdminListItem[] = await response.json();
      expect(body).toHaveLength(2);
    });
  });

  // -------------------------------------------------------------------------
  // Test 8 — grant unknown discordId → 404 GlobalAdminUserNotFound
  // -------------------------------------------------------------------------
  describe('Test 8 — grant unknown discordId → 404 GlobalAdminUserNotFound', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser],
        grantResult: Option.none(), // no such user
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 404 when discordId does not correspond to any user', async () => {
      const response = await handler(
        makePostRequest('admin-token', { discordId: UNKNOWN_DISCORD_ID }),
      );
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminUserNotFound');
    });
  });

  // -------------------------------------------------------------------------
  // Test 9 — grant as non-admin → 403
  // -------------------------------------------------------------------------
  describe('Test 9 — grant as non-admin → 403', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TARGET_USER_ID, nonAdminUser]]),
        dbAdmins: [],
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 403 when a non-admin attempts to grant', async () => {
      const response = await handler(
        makePostRequest('non-admin-token', { discordId: TARGET_DISCORD_ID }),
      );
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminForbidden');
    });
  });

  // -------------------------------------------------------------------------
  // Test 10 — Self-revoke → 409 GlobalAdminSelfRevokeError; guard NOT called
  // -------------------------------------------------------------------------
  describe('Test 10 — Self-revoke → 409 GlobalAdminSelfRevokeError; revokeGlobalAdminGuarded not called', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser],
        revokeSpy,
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 409 GlobalAdminSelfRevokeError when caller tries to revoke themselves', async () => {
      const response = await handler(makeDeleteRequest('admin-token', TEST_USER_ID));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminSelfRevokeError');
    });

    it('revokeGlobalAdminGuarded was NOT called for self-revoke', async () => {
      revokeSpy.userId = null;
      await handler(makeDeleteRequest('admin-token', TEST_USER_ID));
      expect(revokeSpy.userId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 11 — Env-managed revoke → 409 GlobalAdminEnvManaged; guard NOT called
  // -------------------------------------------------------------------------
  describe('Test 11 — Env-managed revoke → 409 GlobalAdminEnvManaged; guard not called', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };

    beforeAll(() => {
      // Target's discord_id is in the env allowlist
      const envManagedTarget = makeUser({
        id: OTHER_ADMIN_USER_ID,
        discord_id: OTHER_ADMIN_DISCORD_ID,
        is_global_admin: true,
      });
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([
          [TEST_USER_ID, adminUser],
          [OTHER_ADMIN_USER_ID, envManagedTarget],
        ]),
        dbAdmins: [adminUser, envManagedTarget],
        revokeSpy,
      });
      const app = HttpRouter.toWebHandler(
        buildTestLayer(
          usersLayer,
          // OTHER_ADMIN_DISCORD_ID is env-managed
          makeAllowlistLayer([OTHER_ADMIN_DISCORD_ID]),
        ),
      );
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 409 GlobalAdminEnvManaged when target is in the env allowlist', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminEnvManaged');
    });

    it('revokeGlobalAdminGuarded was NOT called for env-managed target', async () => {
      revokeSpy.userId = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(revokeSpy.userId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 12 — Last-admin DB-only: single DB admin (target, not self), env empty → 409 LastAdminError
  // -------------------------------------------------------------------------
  describe('Test 12 — Last admin DB-only: single other DB admin, env empty → 409 GlobalAdminLastAdminError', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };

    beforeAll(() => {
      const onlyTarget = makeUser({
        id: OTHER_ADMIN_USER_ID,
        discord_id: OTHER_ADMIN_DISCORD_ID,
        is_global_admin: true,
      });
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([
          [TEST_USER_ID, adminUser],
          [OTHER_ADMIN_USER_ID, onlyTarget],
        ]),
        dbAdmins: [adminUser, onlyTarget],
        // revokeResult=none means the guard blocked (would leave 0 effective admins)
        revokeResult: Option.none(),
        revokeSpy,
      });
      // Empty env allowlist → envAdminCount=0
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 409 GlobalAdminLastAdminError when revokeGlobalAdminGuarded returns none', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(409);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminLastAdminError');
    });

    it('revokeGlobalAdminGuarded was called with envAdminCount=0', async () => {
      revokeSpy.envAdminCount = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(revokeSpy.envAdminCount).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Test 13 — Effective count: one DB admin (target) + one DISTINCT env admin → envAdminCount=1 → 204
  // This is the KEY test verifying effective count, not DB-only count.
  // -------------------------------------------------------------------------
  describe('Test 13 — Effective count: DB+env admin makes revoke allowed (envAdminCount=1)', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };
    const revokedUser = makeUser({
      id: OTHER_ADMIN_USER_ID,
      discord_id: OTHER_ADMIN_DISCORD_ID,
      is_global_admin: false, // after revoke
    });

    beforeAll(() => {
      const targetAdmin = makeUser({
        id: OTHER_ADMIN_USER_ID,
        discord_id: OTHER_ADMIN_DISCORD_ID,
        is_global_admin: true,
      });
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([
          [TEST_USER_ID, adminUser],
          [OTHER_ADMIN_USER_ID, targetAdmin],
        ]),
        dbAdmins: [adminUser, targetAdmin],
        // guard passes (env admin keeps the count > 1)
        revokeResult: Option.some(revokedUser),
        revokeSpy,
      });
      // ENV_ONLY_DISCORD_ID is a DISTINCT env admin (not the same as adminUser or targetAdmin)
      const app = HttpRouter.toWebHandler(
        buildTestLayer(usersLayer, makeAllowlistLayer([ENV_ONLY_DISCORD_ID])),
      );
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 204 when env admin keeps effective count above 1', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(204);
    });

    it('handler passed envAdminCount=1 to revokeGlobalAdminGuarded (the key assertion)', async () => {
      revokeSpy.envAdminCount = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      // The handler must count env IDs that are NOT already covered by a DB admin row.
      // ENV_ONLY_DISCORD_ID is not in dbAdmins, so envAdminCount must be 1.
      expect(revokeSpy.envAdminCount).toBe(1);
    });

    it('revokeGlobalAdminGuarded was called with the correct userId', async () => {
      revokeSpy.userId = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(revokeSpy.userId).toBe(OTHER_ADMIN_USER_ID);
    });
  });

  // -------------------------------------------------------------------------
  // Test 14 — Revoke succeeds with multiple DB admins → 204
  // -------------------------------------------------------------------------
  describe('Test 14 — Revoke succeeds with multiple DB admins → 204', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokedUser = makeUser({
      id: OTHER_ADMIN_USER_ID,
      discord_id: OTHER_ADMIN_DISCORD_ID,
      is_global_admin: false,
    });

    beforeAll(() => {
      const targetAdmin = makeUser({
        id: OTHER_ADMIN_USER_ID,
        discord_id: OTHER_ADMIN_DISCORD_ID,
        is_global_admin: true,
      });
      const thirdAdmin = makeUser({
        id: TARGET_USER_ID,
        discord_id: TARGET_DISCORD_ID,
        is_global_admin: true,
      });
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([
          [TEST_USER_ID, adminUser],
          [OTHER_ADMIN_USER_ID, targetAdmin],
        ]),
        dbAdmins: [adminUser, targetAdmin, thirdAdmin],
        revokeResult: Option.some(revokedUser),
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 204 when there are multiple DB admins and guard succeeds', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(204);
    });
  });

  // -------------------------------------------------------------------------
  // Test 15 — Revoke unknown userId → 404 GlobalAdminUserNotFound; guard not called
  // -------------------------------------------------------------------------
  describe('Test 15 — Revoke unknown userId → 404 GlobalAdminUserNotFound; guard not called', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };

    beforeAll(() => {
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([[TEST_USER_ID, adminUser]]),
        dbAdmins: [adminUser],
        revokeSpy,
        // findById for UNKNOWN does not exist — handled by empty byId map
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 404 when userId does not exist in the DB', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminUserNotFound');
    });

    it('revokeGlobalAdminGuarded was NOT called for unknown userId', async () => {
      revokeSpy.userId = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(revokeSpy.userId).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Test 16 — Revoke non-admin userId → 404 GlobalAdminUserNotFound; guard not called
  // -------------------------------------------------------------------------
  describe('Test 16 — Revoke non-admin userId → 404 GlobalAdminUserNotFound; guard not called', () => {
    let handler: (...args: any[]) => Promise<Response>;
    let dispose: () => Promise<void>;
    const revokeSpy = { userId: null as string | null, envAdminCount: null as number | null };

    beforeAll(() => {
      // OTHER_ADMIN_USER_ID maps to a user with is_global_admin=false and not in env
      const nonAdminTarget = makeUser({
        id: OTHER_ADMIN_USER_ID,
        discord_id: OTHER_ADMIN_DISCORD_ID,
        is_global_admin: false,
      });
      const usersLayer = makeUsersRepositoryLayer({
        byId: new Map([
          [TEST_USER_ID, adminUser],
          [OTHER_ADMIN_USER_ID, nonAdminTarget],
        ]),
        dbAdmins: [adminUser],
        revokeSpy,
      });
      const app = HttpRouter.toWebHandler(buildTestLayer(usersLayer, makeEmptyAllowlistLayer()));
      handler = app.handler;
      dispose = app.dispose;
    });

    afterAll(async () => {
      await dispose();
    });

    it('returns 404 when target user exists but is not an admin', async () => {
      const response = await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(response.status).toBe(404);
      const body = await response.json();
      expect(body._tag).toBe('GlobalAdminUserNotFound');
    });

    it('revokeGlobalAdminGuarded was NOT called for non-admin target', async () => {
      revokeSpy.userId = null;
      await handler(makeDeleteRequest('admin-token', OTHER_ADMIN_USER_ID));
      expect(revokeSpy.userId).toBeNull();
    });
  });
});
