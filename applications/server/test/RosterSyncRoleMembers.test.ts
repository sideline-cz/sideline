/**
 * TDD tests for:
 *   A. updateRoster (PATCH /teams/:teamId/rosters/:rosterId) — reactivation emit behavior
 *      - reactivation (active false→true): emits exactly ONE roster_channel_created
 *      - plain update (no active change): emits NO roster_channel_created
 *      - deactivation (active true→false): emits NO roster_channel_created
 *
 *   B. syncRoleMembers (POST /teams/:teamId/rosters/:rosterId/sync-role-members) — new endpoint
 *      - existing mapping+channel → emits emitRosterChannelCreated with existing_channel_id=Some
 *      - no mapping → emits auto-create variant (existing_channel_id=None)
 *      - unknown roster → 404 RosterNotFound
 *      - wrong team roster → 404 RosterNotFound
 *      - missing roster:manage permission → 403 Forbidden
 *
 * These tests are expected to FAIL until the server handler for syncRoleMembers is implemented.
 * Tests for updateRoster reactivation behavior are expected to PASS (they assert existing behavior).
 */

import type { Auth, Discord, Role, RosterModel, Team, TeamMember } from '@sideline/domain';
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
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const OTHER_TEAM_ROSTER_ID = '00000000-0000-0000-0000-000000000039' as RosterModel.RosterId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

const EXISTING_CHANNEL_ID = '666666666666666666' as Discord.Snowflake;
const EXISTING_ROLE_ID = '555555555555555555' as Discord.Snowflake;
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
// Per-test recording state (reset in beforeEach)
// ---------------------------------------------------------------------------

type RosterChannelCreatedCall = {
  rosterId: RosterModel.RosterId;
  existingChannelId: Option.Option<Discord.Snowflake>;
  targetCategoryId: Option.Option<Discord.Snowflake>;
};

let rosterCreatedCalls: RosterChannelCreatedCall[] = [];

// ---------------------------------------------------------------------------
// Roster store: controlled per-test via rostersStore
// ---------------------------------------------------------------------------

type RosterRecord = {
  id: RosterModel.RosterId;
  team_id: Team.TeamId;
  name: string;
  active: boolean;
  color: Option.Option<string>;
  emoji: Option.Option<string>;
  discord_channel_id: Option.Option<Discord.Snowflake>;
  created_at: DateTime.Utc;
};

type RosterMappingRecord = {
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

let rostersStore = new Map<RosterModel.RosterId, RosterRecord>();
let rosterMappingStore: Option.Option<RosterMappingRecord> = Option.none();
let rosterMemberEntriesStore: RosterEntry[] = [];

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
      _teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      _rosterName: string,
      existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
      _discordChannelName?: string,
      _discordRoleName?: string,
      _discordRoleColor?: Option.Option<number>,
      targetCategoryId: Option.Option<Discord.Snowflake> = Option.none(),
    ) => {
      rosterCreatedCalls.push({ rosterId, existingChannelId, targetCategoryId });
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
  } as any);

const makeRostersRepositoryLayer = () =>
  Layer.succeed(RostersRepository, {
    _tag: 'api/RostersRepository',
    findByTeamId: (teamId: Team.TeamId) => {
      const rosters = Array.from(rostersStore.values()).filter((r) => r.team_id === teamId);
      return Effect.succeed(
        rosters.map((r) => ({
          id: r.id,
          team_id: r.team_id,
          name: r.name,
          active: r.active,
          color: r.color,
          emoji: r.emoji,
          discord_channel_id: r.discord_channel_id,
          created_at: r.created_at,
          member_count: 0,
        })),
      );
    },
    findRosterById: (id: RosterModel.RosterId) => {
      const roster = rostersStore.get(id);
      return Effect.succeed(roster ? Option.some(roster) : Option.none());
    },
    insert: (input: {
      team_id: string;
      name: string;
      active: boolean;
      color: Option.Option<string>;
      emoji: Option.Option<string>;
    }) => {
      const id = crypto.randomUUID() as RosterModel.RosterId;
      const roster: RosterRecord = {
        id,
        team_id: input.team_id as Team.TeamId,
        name: input.name,
        active: input.active,
        color: input.color,
        emoji: input.emoji,
        discord_channel_id: Option.none(),
        created_at: DateTime.nowUnsafe(),
      };
      rostersStore.set(id, roster);
      return Effect.succeed(roster);
    },
    update: (input: {
      id: RosterModel.RosterId;
      name: Option.Option<string>;
      active: Option.Option<boolean>;
      color: Option.Option<string>;
      emoji: Option.Option<string>;
      discord_channel_id?: Option.Option<Option.Option<Discord.Snowflake>>;
    }) => {
      const roster = rostersStore.get(input.id);
      if (!roster) return Effect.die(new Error('Roster not found'));
      const updated = {
        ...roster,
        name: Option.getOrElse(input.name, () => roster.name),
        active: Option.getOrElse(input.active, () => roster.active),
        color: Option.isSome(input.color) ? input.color : roster.color,
        emoji: Option.isSome(input.emoji) ? input.emoji : roster.emoji,
        discord_channel_id:
          input.discord_channel_id !== undefined
            ? Option.getOrElse(input.discord_channel_id, () => roster.discord_channel_id)
            : roster.discord_channel_id,
      };
      rostersStore.set(input.id, updated);
      return Effect.succeed(updated);
    },
    delete: (id: RosterModel.RosterId) => {
      rostersStore.delete(id);
      return Effect.void;
    },
    findMemberEntriesById: (_rosterId: RosterModel.RosterId) =>
      Effect.succeed(rosterMemberEntriesStore),
    addMemberById: () => Effect.void,
    removeMemberById: () => Effect.void,
  } as any);

const makeDiscordChannelMappingLayer = () =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: () => Effect.succeed(Option.none()),
    findByRosterId: (_teamId: string, _rosterId: RosterModel.RosterId) =>
      Effect.succeed(
        Option.map(rosterMappingStore, (m) => ({
          id: 'mock-mapping-id',
          team_id: TEST_TEAM_ID,
          entity_type: 'roster' as const,
          group_id: Option.none(),
          roster_id: Option.some(_rosterId),
          discord_channel_id: m.discord_channel_id,
          discord_role_id: m.discord_role_id,
        })),
      ),
    insert: () => Effect.void,
    insertRoleOnly: () => Effect.void,
    upsertGroupChannel: () => Effect.void,
    clearGroupChannel: () => Effect.void,
    insertRoster: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    deleteByRosterId: () => Effect.void,
    findAllByTeam: () => Effect.succeed([]),
  } as any);

// ---------------------------------------------------------------------------
// Static mock layers (shared across tests)
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
  // syncRoleMembers uses rosters.findMemberEntriesById (from RostersRepository), NOT this.
  // Return empty to make the member source unambiguous — any addedCount in syncRoleMembers
  // tests comes exclusively from rosterMemberEntriesStore via RostersRepository.findMemberEntriesById.
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
// Layer builder
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
          } as never),
          Layer.succeed(InviteAcceptancesRepository, {
            _tag: 'api/InviteAcceptancesRepository',
          } as never),
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
  rostersStore = new Map();
  rosterMappingStore = Option.none();
  rosterMemberEntriesStore = [];
});

// ---------------------------------------------------------------------------
// Helper to create HTTP handler and PATCH roster
// ---------------------------------------------------------------------------

const createHandler = () => {
  const app = HttpRouter.toWebHandler(buildTestLayer());
  disposeHandlers.push(app.dispose);
  return app.handler;
};

const patchRoster = (
  handler: (...args: any) => Promise<Response>,
  payload: Record<string, unknown>,
  rosterId: RosterModel.RosterId = TEST_ROSTER_ID,
  token = 'admin-token',
) =>
  handler(
    new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${rosterId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
  );

const postSyncRoleMembers = (
  handler: (...args: any) => Promise<Response>,
  teamId: Team.TeamId = TEST_TEAM_ID,
  rosterId: RosterModel.RosterId = TEST_ROSTER_ID,
  token = 'admin-token',
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/rosters/${rosterId}/sync-role-members`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

// ---------------------------------------------------------------------------
// A. updateRoster reactivation behavior
// ---------------------------------------------------------------------------

describe('updateRoster — reactivation emit behavior', () => {
  it('reactivation without create_discord_channel_on_roster setting emits nothing', async () => {
    // When create_discord_channel_on_roster is absent from settings (findByTeamId returns None),
    // the handler treats it as shouldCreate=false and emits no roster_channel_created event.
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const handler = createHandler();
    const response = await patchRoster(handler, {
      name: null,
      active: true,
      color: null,
      emoji: null,
    });

    expect(response.status).toBe(200);
    // No settings → shouldCreate=false → no event emitted
    expect(rosterCreatedCalls.length).toBe(0);
  });

  it('reactivation with create_discord_channel_on_roster=true emits exactly ONE roster_channel_created', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    // Pass the settings layer override directly to buildTestLayer — it replaces
    // defaultSettingsLayer in the stack, enabling create_discord_channel_on_roster.
    const settingsWithChannel = Layer.succeed(TeamSettingsRepository, {
      _tag: 'api/TeamSettingsRepository',
      findByTeam: () => Effect.succeed(Option.none()),
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEST_TEAM_ID,
            event_horizon_days: 30,
            min_players_threshold: 0,
            rsvp_reminder_hours: 0,
            discord_channel_training: Option.none(),
            discord_channel_match: Option.none(),
            discord_channel_tournament: Option.none(),
            discord_channel_meeting: Option.none(),
            discord_channel_social: Option.none(),
            discord_channel_other: Option.none(),
            create_discord_channel_on_group: true,
            create_discord_channel_on_roster: true,
            discord_role_format: '{emoji} {name}',
            discord_channel_format: '{emoji}│{name}',
            discord_channel_cleanup_on_group_delete: 'delete' as const,
            discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
            discord_archive_category_id: Option.none(),
            discord_roster_category_id: Option.none(),
          }),
        ),
      upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
      upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
      getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
      getHorizonDays: () => Effect.succeed(30),
    } as any);

    const app = HttpRouter.toWebHandler(buildTestLayer(settingsWithChannel));
    disposeHandlers.push(app.dispose);

    const response = await patchRoster(app.handler, {
      name: null,
      active: true,
      color: null,
      emoji: null,
    });

    expect(response.status).toBe(200);
    // Exactly ONE roster_channel_created emitted
    expect(rosterCreatedCalls).toHaveLength(1);
    const call = rosterCreatedCalls[0];
    expect(call).toBeDefined();
    expect(Option.isNone(call?.existingChannelId)).toBe(true);
  });

  it('plain update (no active change) → no roster_channel_created emitted', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Old Name',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const handler = createHandler();
    const response = await patchRoster(handler, {
      name: 'New Name',
      active: null,
      color: null,
      emoji: null,
    });

    expect(response.status).toBe(200);
    // No roster_channel_created on plain name update
    expect(rosterCreatedCalls).toHaveLength(0);
  });

  it('deactivation (active true→false) → no roster_channel_created emitted', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const handler = createHandler();
    const response = await patchRoster(handler, {
      name: null,
      active: false,
      color: null,
      emoji: null,
    });

    expect(response.status).toBe(200);
    // No roster_channel_created on deactivation
    expect(rosterCreatedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// B. syncRoleMembers — new endpoint
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/rosters/:rosterId/sync-role-members', () => {
  it('returns 403 when caller lacks roster:manage permission', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      created_at: DateTime.nowUnsafe(),
    });

    const handler = createHandler();
    const response = await postSyncRoleMembers(
      handler,
      TEST_TEAM_ID,
      TEST_ROSTER_ID,
      'player-token', // player has no roster:manage
    );

    expect(response.status).toBe(403);
  });

  it('returns 404 for unknown roster id', async () => {
    // rostersStore is empty — roster not found
    const handler = createHandler();
    const response = await postSyncRoleMembers(handler, TEST_TEAM_ID, TEST_ROSTER_ID);

    expect(response.status).toBe(404);
  });

  it('returns 404 when roster belongs to a different team', async () => {
    // Roster belongs to OTHER_TEAM_ID, but we request it on TEST_TEAM_ID
    rostersStore.set(OTHER_TEAM_ROSTER_ID, {
      id: OTHER_TEAM_ROSTER_ID,
      team_id: TEST_OTHER_TEAM_ID, // wrong team
      name: 'Other Team Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const handler = createHandler();
    const response = await postSyncRoleMembers(
      handler,
      TEST_TEAM_ID,
      OTHER_TEAM_ROSTER_ID, // roster belongs to another team
    );

    expect(response.status).toBe(404);
  });

  it('returns 401 without auth token', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      created_at: DateTime.nowUnsafe(),
    });

    const handler: (...args: any) => Promise<Response> = createHandler();

    const response = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/sync-role-members`,
        { method: 'POST' },
      ),
    );
    expect(response.status).toBe(401);
  });

  it('with existing mapping+channel → emits emitRosterChannelCreated with existing_channel_id=Some; returns addedCount=2, removedCount=0, skippedCount=0', async () => {
    // addedCount: all 2 roster members are sourced from rosters.findMemberEntriesById —
    //   the handler calls RostersRepository.findMemberEntriesById, NOT TeamMembersRepository.findRosterByTeam.
    // removedCount: always 0 in Phase 1 (no removal logic).
    // skippedCount: structurally always 0 for rosters — every RosterEntry has a non-null discord_id
    //   (a user without a Discord link can't decode as RosterEntry). The field exists only for
    //   shape-parity with groups. There is no skip path for rosters.
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      created_at: DateTime.nowUnsafe(),
    });

    // Mapping has both channel and role
    rosterMappingStore = Option.some({
      discord_channel_id: Option.some(EXISTING_CHANNEL_ID),
      discord_role_id: Option.some(EXISTING_ROLE_ID),
    });

    // 2 roster members
    rosterMemberEntriesStore = [
      new RosterEntry({
        member_id: '00000000-0000-0000-0002-000000000001' as TeamMember.TeamMemberId,
        user_id: TEST_USER_ID,
        discord_id: '111111111111111111' as Discord.Snowflake,
        role_names: [],
        permissions: [],
        name: Option.none(),
        birth_date: Option.none(),
        gender: Option.none(),
        jersey_number: Option.none(),
        username: 'member-a',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
        joined_at: '2024-01-01T00:00:00.000Z',
        active: true,
      }),
      new RosterEntry({
        member_id: '00000000-0000-0000-0002-000000000002' as TeamMember.TeamMemberId,
        user_id: TEST_ADMIN_ID,
        discord_id: '222222222222222222' as Discord.Snowflake,
        role_names: [],
        permissions: [],
        name: Option.none(),
        birth_date: Option.none(),
        gender: Option.none(),
        jersey_number: Option.none(),
        username: 'member-b',
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
        joined_at: '2024-01-01T00:00:00.000Z',
        active: true,
      }),
    ];

    const handler = createHandler();
    const response = await postSyncRoleMembers(handler);

    expect(response.status).toBe(200);
    const body = await response.json();

    // Returns the correct count
    expect(body.addedCount).toBe(2); // 2 members in the roster
    expect(body.removedCount).toBe(0);
    expect(body.skippedCount).toBe(0);

    // emitRosterChannelCreated called with existing_channel_id=Some
    expect(rosterCreatedCalls).toHaveLength(1);
    const call = rosterCreatedCalls[0]!;
    expect(Option.isSome(call.existingChannelId)).toBe(true);
    expect((call.existingChannelId as Option.Some<Discord.Snowflake>).value).toBe(
      EXISTING_CHANNEL_ID,
    );
  });

  it('no existing mapping → emits emitRosterChannelCreated with existing_channel_id=None (auto-create)', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    // No mapping
    rosterMappingStore = Option.none();
    rosterMemberEntriesStore = []; // no members either

    const handler = createHandler();
    const response = await postSyncRoleMembers(handler);

    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    expect(body.skippedCount).toBe(0);

    // emitRosterChannelCreated called without an existing channel id
    expect(rosterCreatedCalls).toHaveLength(1);
    const call = rosterCreatedCalls[0]!;
    expect(Option.isNone(call.existingChannelId)).toBe(true);
  });
});
