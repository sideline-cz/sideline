// TDD mode — HTTP-level tests for AgeThreshold endpoints.
// These tests will FAIL until Phase 5 implements:
//   - requireNonEmptyCriteria in age-threshold.ts API handler (400 AgeThresholdEmptyCriteria)
//   - gender forwarded through to repository insertRule / updateRuleById
//   - gender included in AgeThresholdInfo responses
//
// Style mirrors applications/server/test/Roster.test.ts / EventRsvp.test.ts.

import type {
  AgeThresholdRule,
  Auth,
  Discord,
  GroupModel,
  Role,
  Team,
  TeamMember,
} from '@sideline/domain';
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
import {
  AgeThresholdAlreadyExistsError,
  AgeThresholdRepository,
} from '~/repositories/AgeThresholdRepository.js';
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
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000030' as GroupModel.GroupId;
const TEST_REQUIRED_GROUP_ID = '00000000-0000-0000-0000-000000000031' as GroupModel.GroupId;
const FOREIGN_TEAM_GROUP_ID = '00000000-0000-0000-0000-000000000032' as GroupModel.GroupId;
const NONEXISTENT_GROUP_ID = '00000000-0000-0000-0000-000000000099' as GroupModel.GroupId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'team:manage',
  'team:invite',
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'member:remove',
  'role:view',
  'role:manage',
  'group:manage',
];

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// ---------------------------------------------------------------------------
// In-memory rule store
// ---------------------------------------------------------------------------

type RuleRecord = {
  id: AgeThresholdRule.AgeThresholdRuleId;
  team_id: Team.TeamId;
  group_id: GroupModel.GroupId;
  group_name: string;
  min_age: Option.Option<number>;
  max_age: Option.Option<number>;
  gender: Option.Option<'male' | 'female' | 'other'>;
  required_group_id: Option.Option<GroupModel.GroupId>;
};

let rulesStore: Map<string, RuleRecord>;

const resetRulesStore = () => {
  rulesStore = new Map();
};

// ---------------------------------------------------------------------------
// Auth stores
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('captain-token', TEST_USER_ID);
sessionsStore.set('player-token', TEST_USER_ID);

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

let currentMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Captain'],
  permissions: CAPTAIN_PERMISSIONS,
} as unknown as MembershipWithRole;

const playerMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS,
} as unknown as MembershipWithRole;

// ---------------------------------------------------------------------------
// Mock layers
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
  findById: (id: Auth.UserId) =>
    Effect.succeed(
      id === TEST_USER_ID
        ? Option.some({
            id: TEST_USER_ID,
            discord_id: '12345',
            username: 'testcaptain',
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.some('Test Captain'),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en' as const,
            discord_display_name: Option.none(),
            created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
            updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        id: 'session-1',
        user_id: userId,
        token,
        expires_at: DateTime.makeUnsafe('2030-01-01T00:00:00Z'),
        created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
      }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) =>
    Effect.succeed(
      id === TEST_TEAM_ID
        ? Option.some({
            id: TEST_TEAM_ID,
            name: 'Test Team',
            guild_id: '999999999999999999' as Discord.Snowflake,
            created_by: TEST_USER_ID,
            created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
            updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
          })
        : Option.none(),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const otherTeamCaptainMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: OTHER_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Captain'],
  permissions: CAPTAIN_PERMISSIONS,
} as unknown as MembershipWithRole;

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID) {
      return Effect.succeed(Option.some(currentMembership));
    }
    // Also return a captain membership for OTHER_TEAM_ID so the cross-team
    // rule-ownership check (team_id mismatch) can be reached in tests.
    if (teamId === OTHER_TEAM_ID && userId === TEST_USER_ID) {
      return Effect.succeed(Option.some(otherTeamCaptainMembership));
    }
    return Effect.succeed(Option.none());
  },
  addMember: () => Effect.die(new Error('Not implemented')),
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

const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  findGroupsByTeamId: () => Effect.succeed([]),
  findGroupById: (id: GroupModel.GroupId) => {
    if (id === TEST_GROUP_ID) {
      return Effect.succeed(
        Option.some({
          id: TEST_GROUP_ID,
          team_id: TEST_TEAM_ID,
          name: 'U12',
          parent_id: Option.none(),
          sort_order: 0,
          archived: false,
        }),
      );
    }
    if (id === TEST_REQUIRED_GROUP_ID) {
      return Effect.succeed(
        Option.some({
          id: TEST_REQUIRED_GROUP_ID,
          team_id: TEST_TEAM_ID,
          name: 'U12 Required',
          parent_id: Option.none(),
          sort_order: 1,
          archived: false,
        }),
      );
    }
    if (id === FOREIGN_TEAM_GROUP_ID) {
      return Effect.succeed(
        Option.some({
          id: FOREIGN_TEAM_GROUP_ID,
          team_id: OTHER_TEAM_ID,
          name: 'Foreign Group',
          parent_id: Option.none(),
          sort_order: 0,
          archived: false,
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
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

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findRulesByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(Array.from(rulesStore.values()).filter((r) => r.team_id === teamId)),
  findRuleById: (ruleId: AgeThresholdRule.AgeThresholdRuleId) => {
    const rule = rulesStore.get(ruleId);
    return Effect.succeed(rule ? Option.some(rule) : Option.none());
  },
  insertRule: (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    minAge: Option.Option<number>,
    maxAge: Option.Option<number>,
    gender: Option.Option<'male' | 'female' | 'other'>,
    requiredGroupId: Option.Option<GroupModel.GroupId>,
  ) => {
    const id = crypto.randomUUID() as AgeThresholdRule.AgeThresholdRuleId;
    // No fallback coercion: if gender/requiredGroupId is undefined here it is
    // a type bug in the calling code and we want it to surface, not be silently coerced.
    const rule: RuleRecord = {
      id,
      team_id: teamId,
      group_id: groupId,
      group_name: 'U12',
      min_age: minAge,
      max_age: maxAge,
      gender,
      required_group_id: requiredGroupId,
    };
    rulesStore.set(id, rule);
    return Effect.succeed(rule);
  },
  updateRuleById: (
    ruleId: AgeThresholdRule.AgeThresholdRuleId,
    minAge: Option.Option<number>,
    maxAge: Option.Option<number>,
    gender: Option.Option<'male' | 'female' | 'other'>,
    requiredGroupId: Option.Option<GroupModel.GroupId>,
  ) => {
    const existing = rulesStore.get(ruleId);
    if (!existing) return Effect.fail(new Error('Rule not found') as any);
    // Detect unique-constraint collision: same (team_id, group_id, min_age, max_age, gender, required_group_id)
    const collision = Array.from(rulesStore.values()).find(
      (r) =>
        r.id !== ruleId &&
        r.team_id === existing.team_id &&
        r.group_id === existing.group_id &&
        Option.getOrNull(r.min_age) === Option.getOrNull(minAge) &&
        Option.getOrNull(r.max_age) === Option.getOrNull(maxAge) &&
        Option.getOrNull(r.gender) === Option.getOrNull(gender) &&
        Option.getOrNull(r.required_group_id) === Option.getOrNull(requiredGroupId),
    );
    if (collision) return Effect.fail(new AgeThresholdAlreadyExistsError());
    // No fallback coercion: if gender/requiredGroupId is undefined here it is
    // a type bug in the calling code and we want it to surface, not be silently coerced.
    const updated: RuleRecord = {
      ...existing,
      min_age: minAge,
      max_age: maxAge,
      gender,
      required_group_id: requiredGroupId,
    };
    rulesStore.set(ruleId, updated);
    return Effect.succeed(updated);
  },
  deleteRuleById: (ruleId: AgeThresholdRule.AgeThresholdRuleId) => {
    rulesStore.delete(ruleId);
    return Effect.void;
  },
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.void,
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
  insertOne: () => Effect.die(new Error('Not implemented')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
} as any);

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

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
} as any);

const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
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
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
} as any);

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({ id: '12345', username: 'testcaptain', avatar: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
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
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
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
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
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
  // Achievement admin dependencies
  Layer.provide(
    Layer.mergeAll(
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
    ),
  ),
).pipe(Layer.provide(MockTranslationsLayers));

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
  resetRulesStore();
  currentMembership = {
    id: TEST_MEMBER_ID,
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_ID,
    active: true,
    role_names: ['Captain'],
    permissions: CAPTAIN_PERMISSIONS,
  } as unknown as MembershipWithRole;
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/age-thresholds`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/age-thresholds', () => {
  // Test 1: All three of minAge, maxAge, gender omitted → 400 AgeThresholdEmptyCriteria
  it('returns 400 AgeThresholdEmptyCriteria when all criteria omitted', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          // minAge, maxAge, gender all omitted
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdEmptyCriteria');
  });

  // Test 2: POST with only gender: 'male' → 201, gender is Some('male'), age fields None
  it('returns 201 with gender-only rule', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          gender: 'male',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    // Direct field assertion — Option.some('male') serialises as 'male' in JSON
    expect(body.gender).toBe('male');
    expect(body.minAge).toBeNull();
    expect(body.maxAge).toBeNull();
  });

  // Test 3: POST with only minAge: 10 → 201
  it('returns 201 with age-only rule (minAge only)', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.minAge).toBe(10);
    expect(body.maxAge).toBeNull();
  });

  // Test 4: POST with groupId, minAge: 10, gender: 'female' → 201, both persisted
  it('returns 201 with combined age + gender rule', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          gender: 'female',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.minAge).toBe(10);
    // Direct field assertion — Option.some('female') serialises as 'female' in JSON
    expect(body.gender).toBe('female');
  });

  // Test 5A: POST with gender key entirely absent → 201, gender decodes to Option.none (null in JSON)
  // OptionFromOptionalKey treats an absent key as Option.none.
  it('returns 201 and gender is null when gender key is completely absent (legacy bundle compatibility)', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          // gender key is entirely omitted
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    // Absent key → Option.none → serialises as null in JSON
    expect(body.gender).toBeNull();
  });

  // Test 5B: POST with gender: null explicitly → 400 decode error
  // OptionFromOptionalKey is strict about key presence: an explicit null value
  // is not the same as an absent key and is a schema decode error.
  it('returns 400 when gender is explicitly null (not the same as absent)', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          gender: null, // explicitly null — schema decode error
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  // New Test RG-1: All four criteria absent (no gender, no requiredGroupId, no ages) → 400 AgeThresholdEmptyCriteria
  it('returns 400 AgeThresholdEmptyCriteria when all criteria including requiredGroupId omitted', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          // minAge, maxAge, gender, requiredGroupId all omitted
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdEmptyCriteria');
  });

  // New Test RG-2: POST with only requiredGroupId → 201, body.requiredGroupId === TEST_REQUIRED_GROUP_ID
  it('returns 201 with requiredGroupId-only rule', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          requiredGroupId: TEST_REQUIRED_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.requiredGroupId).toBe(TEST_REQUIRED_GROUP_ID);
    expect(body.minAge).toBeNull();
    expect(body.maxAge).toBeNull();
    expect(body.gender).toBeNull();
  });

  // New Test RG-3: POST with requiredGroupId === groupId (self-reference) → 400 AgeThresholdSelfRequired
  it('returns 400 AgeThresholdSelfRequired when requiredGroupId equals groupId', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          requiredGroupId: TEST_GROUP_ID, // self-reference
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdSelfRequired');
  });

  // New Test RG-4: POST with requiredGroupId key absent (legacy bundle parity) → 201, body.requiredGroupId === null
  it('returns 201 and requiredGroupId is null when key is completely absent (legacy bundle compatibility)', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          // requiredGroupId key is entirely omitted
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    // Absent key → Option.none → serialises as null in JSON
    expect(body.requiredGroupId).toBeNull();
  });

  // New Test RG-5: POST with requiredGroupId: null explicitly → 400 decode error
  // OptionFromOptionalKey is strict: explicit null is not the same as absent key.
  it('returns 400 when requiredGroupId is explicitly null (not the same as absent)', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          requiredGroupId: null, // explicitly null — schema decode error
        }),
      }),
    );
    expect(response.status).toBe(400);
  });

  // RG-Validation A: POST with requiredGroupId pointing at a non-existent group → 404 GroupNotFound
  it('returns 404 GroupNotFound when requiredGroupId points at non-existent group', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          requiredGroupId: NONEXISTENT_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdGroupNotFound');
  });

  // RG-Validation B: POST with requiredGroupId pointing at another team's group → 404 GroupNotFound
  it('returns 404 GroupNotFound when requiredGroupId points at another team’s group', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          requiredGroupId: FOREIGN_TEAM_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdGroupNotFound');
  });

  // Test 11 (permission): non-captain (missing group:manage) → 403 Forbidden
  it('returns 403 for member without group:manage permission', async () => {
    currentMembership = playerMembership;
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
        }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('returns 401 without auth token', async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: TEST_GROUP_ID, minAge: 10 }),
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe('PATCH /teams/:teamId/age-thresholds/:ruleId', () => {
  const createRule = async (overrides: {
    minAge?: number;
    maxAge?: number;
    gender?: string;
    requiredGroupId?: string;
  }) => {
    const body: Record<string, unknown> = { groupId: TEST_GROUP_ID };
    if (overrides.minAge !== undefined) body.minAge = overrides.minAge;
    if (overrides.maxAge !== undefined) body.maxAge = overrides.maxAge;
    if ('gender' in overrides) body.gender = overrides.gender;
    if ('requiredGroupId' in overrides) body.requiredGroupId = overrides.requiredGroupId;
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      }),
    );
    const data = await response.json();
    return data.ruleId as string;
  };

  // Test 6: PATCH clearing all three fields → 400 AgeThresholdEmptyCriteria
  it('returns 400 AgeThresholdEmptyCriteria when PATCH clears all criteria', async () => {
    const ruleId = await createRule({ minAge: 10 });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // minAge, maxAge, gender all omitted (= Option.none each)
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdEmptyCriteria');
  });

  // Test 7: PATCH setting gender from None to 'male' on an age-only rule → 200
  it('returns 200 when PATCH adds gender to age-only rule', async () => {
    const ruleId = await createRule({ minAge: 10 });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          gender: 'male',
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // Direct field assertion — Option.some('male') serialises as 'male' in JSON
    expect(body.gender).toBe('male');
    expect(body.minAge).toBe(10);
  });

  // Test 8: PATCH on a rule that belongs to a different team → 404 RuleNotFound
  it('returns 404 when rule belongs to a different team', async () => {
    const ruleId = await createRule({ minAge: 10 });
    const otherTeamBase = `http://localhost/teams/${OTHER_TEAM_ID}/age-thresholds`;

    const response = await handler(
      new Request(`${otherTeamBase}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 12,
        }),
      }),
    );
    expect(response.status).toBe(404);
  });

  // Test: PATCH into same criteria as existing rule → 409 AgeThresholdAlreadyExists
  it('returns 409 AgeThresholdAlreadyExists when PATCH collides with an existing rule', async () => {
    // Seed rule A: minAge=10, maxAge=14, gender='male'
    const ruleAId = await createRule({ minAge: 10, maxAge: 14, gender: 'male' });
    // Seed rule B: minAge=10, maxAge=14, gender='female'
    await createRule({ minAge: 10, maxAge: 14, gender: 'female' });

    // PATCH rule A to gender='female' — collides with rule B
    const response = await handler(
      new Request(`${BASE}/${ruleAId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          maxAge: 14,
          gender: 'female',
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdAlreadyExists');
  });

  // New Test RG-6: PATCH adding requiredGroupId to an existing age-only rule → 200, body shows updated value
  it('returns 200 when PATCH adds requiredGroupId to an existing age-only rule', async () => {
    const ruleId = await createRule({ minAge: 10 });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          requiredGroupId: TEST_REQUIRED_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requiredGroupId).toBe(TEST_REQUIRED_GROUP_ID);
    expect(body.minAge).toBe(10);
  });

  // RG-Validation C: PATCH adding requiredGroupId for a non-existent group → 404 GroupNotFound
  it('returns 404 GroupNotFound when PATCH sets requiredGroupId to a non-existent group', async () => {
    const ruleId = await createRule({ minAge: 10 });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          requiredGroupId: NONEXISTENT_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdGroupNotFound');
  });

  // New Test RG-7: PATCH clearing all four criteria (omitting requiredGroupId from PATCH body) → 400 AgeThresholdEmptyCriteria
  it('returns 400 AgeThresholdEmptyCriteria when PATCH clears all criteria including requiredGroupId', async () => {
    const ruleId = await createRule({ requiredGroupId: TEST_REQUIRED_GROUP_ID });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          // minAge, maxAge, gender, requiredGroupId all omitted (= Option.none each)
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdEmptyCriteria');
  });

  // New Test RG-8: PATCH setting requiredGroupId === existing.group_id → 400 AgeThresholdSelfRequired
  it('returns 400 AgeThresholdSelfRequired when PATCH sets requiredGroupId to same as groupId', async () => {
    const ruleId = await createRule({ minAge: 10 });

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          requiredGroupId: TEST_GROUP_ID, // same as rule's group_id — self-reference
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdSelfRequired');
  });

  // New Test RG-10: Unique constraint includes required_group_id
  // Seed rule A with requiredGroupId, rule B without (same other criteria) — both succeed;
  // PATCH B adding the same requiredGroupId → 409 AgeThresholdAlreadyExists
  it('returns 409 AgeThresholdAlreadyExists when PATCH adds requiredGroupId that creates unique collision', async () => {
    // Rule A: minAge=10, maxAge=14, gender absent, requiredGroupId=TEST_REQUIRED_GROUP_ID
    await createRule({ minAge: 10, maxAge: 14, requiredGroupId: TEST_REQUIRED_GROUP_ID });
    // Rule B: same ages, no requiredGroupId
    const ruleBId = await createRule({ minAge: 10, maxAge: 14 });

    // PATCH rule B to add the same requiredGroupId — collides with rule A
    const response = await handler(
      new Request(`${BASE}/${ruleBId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          minAge: 10,
          maxAge: 14,
          requiredGroupId: TEST_REQUIRED_GROUP_ID,
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('AgeThresholdAlreadyExists');
  });

  // Permission check for PATCH
  it('returns 403 for PATCH without group:manage permission', async () => {
    const ruleId = await createRule({ minAge: 10 });
    currentMembership = playerMembership;

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ minAge: 12 }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('DELETE /teams/:teamId/age-thresholds/:ruleId', () => {
  const createRule = async () => {
    const response = await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
        }),
      }),
    );
    const data = await response.json();
    return data.ruleId as string;
  };

  // Test 9: DELETE → 204 (regression check)
  it('returns 204 on successful delete', async () => {
    const ruleId = await createRule();
    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(204);
  });

  it('returns 404 when deleting a non-existent rule', async () => {
    const nonExistentId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`${BASE}/${nonExistentId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  // Permission check for DELETE
  it('returns 403 for DELETE without group:manage permission', async () => {
    const ruleId = await createRule();
    currentMembership = playerMembership;

    const response = await handler(
      new Request(`${BASE}/${ruleId}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('GET /teams/:teamId/age-thresholds', () => {
  // Test 10: GET list returns gender field with proper Option serialisation
  it('returns gender field in list response', async () => {
    // First create a rule with gender
    await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 12,
          gender: 'female',
        }),
      }),
    );

    const response = await handler(
      new Request(BASE, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);

    const rule = body[0];
    expect(rule).toHaveProperty('gender');
    // Direct field assertion — Option.some('female') serialises as 'female' in JSON
    expect(rule.gender).toBe('female');

    // Create a second rule without gender and verify it returns null
    await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          // gender omitted
        }),
      }),
    );

    const response2 = await handler(
      new Request(BASE, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    const body2 = await response2.json();
    expect(body2).toHaveLength(2);

    // The second rule (no gender) should have gender: null
    const noGenderRule = body2.find((r: any) => r.minAge === 10);
    expect(noGenderRule?.gender).toBeNull();
  });

  // New Test RG-9: GET list returns requiredGroupId field — non-null for one rule, null for another
  it('returns requiredGroupId field in list response (non-null and null)', async () => {
    // Rule with requiredGroupId set
    await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 12,
          requiredGroupId: TEST_REQUIRED_GROUP_ID,
        }),
      }),
    );

    // Rule without requiredGroupId
    await handler(
      new Request(BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          groupId: TEST_GROUP_ID,
          minAge: 10,
          // requiredGroupId omitted
        }),
      }),
    );

    const response = await handler(
      new Request(BASE, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(2);

    const ruleWithRequired = body.find((r: any) => r.minAge === 12);
    expect(ruleWithRequired).toBeDefined();
    expect(ruleWithRequired.requiredGroupId).toBe(TEST_REQUIRED_GROUP_ID);

    const ruleWithoutRequired = body.find((r: any) => r.minAge === 10);
    expect(ruleWithoutRequired).toBeDefined();
    expect(ruleWithoutRequired.requiredGroupId).toBeNull();
  });

  it('returns 401 without auth token', async () => {
    const response = await handler(new Request(BASE));
    expect(response.status).toBe(401);
  });

  it('returns 403 for member without group:manage permission', async () => {
    currentMembership = playerMembership;
    const response = await handler(
      new Request(BASE, {
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});
