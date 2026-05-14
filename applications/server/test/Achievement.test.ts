// TDD mode — HTTP-level tests for AchievementApi endpoints.
// These tests WILL FAIL until:
//   - AchievementSettingsRepository is implemented
//   - CustomAchievementsRepository is implemented
//   - AchievementPreview service is implemented
//   - AchievementApiLive handlers are implemented (currently all return 403)
//
// Style mirrors applications/server/test/AgeThreshold.test.ts

import type { Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
// These imports will fail until the developer creates these files:
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import {
  CustomAchievementNameTakenError,
  CustomAchievementsRepository,
} from '~/repositories/CustomAchievementsRepository.js';
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
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

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

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view'];

// ---------------------------------------------------------------------------
// In-memory stores (reset between tests)
// ---------------------------------------------------------------------------

type AchievementSettingRow = {
  team_id: Team.TeamId;
  achievement_slug: string;
  threshold_override: number;
};

type CustomAchievementRow = {
  id: string;
  team_id: Team.TeamId;
  name: string;
  description: string;
  emoji: Option.Option<string>;
  rule_kind: string;
  threshold: number;
  activity_type_slug: Option.Option<string>;
  discord_role_id: Option.Option<string>;
};

let settingsStore: Map<string, AchievementSettingRow>;
let customStore: Map<string, CustomAchievementRow>;

const resetStores = () => {
  settingsStore = new Map();
  customStore = new Map();
  drpeStore = [];
  roleMappingsStore = new Map();
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

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID) {
      return Effect.succeed(Option.some(currentMembership));
    }
    return Effect.succeed(Option.none());
  },
  addMember: () => Effect.die(new Error('Not implemented')),
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

const MockAchievementSettingsRepositoryLayer = Layer.succeed(AchievementSettingsRepository, {
  findOverridesByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(
      new Map(
        Array.from(settingsStore.values())
          .filter((r) => r.team_id === teamId)
          .map((r) => [r.achievement_slug, r.threshold_override] as const),
      ),
    ),
  upsertOverride: (teamId: Team.TeamId, slug: string, threshold: number) => {
    settingsStore.set(`${teamId}:${slug}`, {
      team_id: teamId,
      achievement_slug: slug,
      threshold_override: threshold,
    });
    return Effect.void;
  },
  deleteOverride: (teamId: Team.TeamId, slug: string) => {
    settingsStore.delete(`${teamId}:${slug}`);
    return Effect.void;
  },
} as any);

const MockCustomAchievementsRepositoryLayer = Layer.succeed(CustomAchievementsRepository, {
  findByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(Array.from(customStore.values()).filter((r) => r.team_id === teamId)),
  findById: (_teamId: Team.TeamId, id: string) => {
    const row = customStore.get(id);
    return Effect.succeed(row ? Option.some(row) : Option.none());
  },
  insert: (row: Omit<CustomAchievementRow, 'id'>) => {
    const duplicate = Array.from(customStore.values()).find(
      (r) => r.team_id === (row as any).team_id && r.name === (row as any).name,
    );
    if (duplicate) {
      return Effect.fail(new CustomAchievementNameTakenError());
    }
    const id = crypto.randomUUID();
    const full: CustomAchievementRow = { id, ...row } as CustomAchievementRow;
    customStore.set(id, full);
    return Effect.succeed(full);
  },
  update: (_teamId: Team.TeamId, id: string, updates: Partial<CustomAchievementRow>) => {
    const existing = customStore.get(id);
    if (!existing) return Effect.fail(new Error('Not found') as any);
    const updated = { ...existing, ...updates };
    customStore.set(id, updated);
    return Effect.succeed(updated);
  },
  delete: (_teamId: Team.TeamId, id: string) => {
    customStore.delete(id);
    return Effect.void;
  },
  setRoleMapping: (_teamId: Team.TeamId, id: string, roleId: Option.Option<string>) => {
    const existing = customStore.get(id);
    if (!existing) return Effect.void;
    customStore.set(id, { ...existing, discord_role_id: roleId });
    return Effect.void;
  },
} as any);

let drpeStore: Array<{
  id: string;
  team_id: string;
  kind: string;
  ref_id: string;
  desired_name: string;
  processed_at: null | string;
  error: null | string;
}> = [];

const MockDiscordRoleProvisionEventsRepositoryLayer = Layer.succeed(
  DiscordRoleProvisionEventsRepository,
  {
    enqueue: (
      _teamId: string,
      _guildId: string,
      kind: string,
      refId: string,
      desiredName: string,
    ) => {
      drpeStore.push({
        id: crypto.randomUUID(),
        team_id: _teamId,
        kind,
        ref_id: refId,
        desired_name: desiredName,
        processed_at: null,
        error: null,
      });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    findUnprocessedAll: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    supersede: (_teamId: string, kind: string, refId: string) => {
      drpeStore = drpeStore.map((row) =>
        row.team_id === _teamId &&
        row.kind === kind &&
        row.ref_id === refId &&
        row.processed_at === null
          ? { ...row, processed_at: new Date().toISOString(), error: 'superseded_by_user' }
          : row,
      );
      return Effect.void;
    },
  } as any,
);

let roleMappingsStore: Map<string, string> = new Map();

const MockAchievementRoleMappingsRepositoryLayer = Layer.succeed(
  AchievementRoleMappingsRepository,
  {
    findAllByTeam: (teamId: string) =>
      Effect.succeed(
        Array.from(roleMappingsStore.entries())
          .filter(([key]) => key.startsWith(`${teamId}:`))
          .map(([key, roleId]) => ({ slug: key.split(':')[1], discord_role_id: roleId })),
      ),
    upsert: (teamId: string, slug: string, roleId: string) => {
      roleMappingsStore.set(`${teamId}:${slug}`, roleId);
      return Effect.void;
    },
    delete: (teamId: string, slug: string) => {
      roleMappingsStore.delete(`${teamId}:${slug}`);
      return Effect.void;
    },
  } as any,
);

// AchievementPreview returns a fixed preview for tests that need it
// (Shape matches AchievementApi.PreviewResponse)
const mockPreviewResponse = {
  qualifyingCount: 3,
  removedMembers: [{ teamMemberId: TEST_MEMBER_ID, memberName: 'Alice' }],
  botCanManageRoles: true,
};

const MockAchievementPreviewLayer = Layer.succeed(AchievementPreview, {
  preview: () => Effect.succeed(mockPreviewResponse),
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

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('Not implemented')),
  updateRuleById: () => Effect.die(new Error('Not implemented')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
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
  // New achievement admin dependencies (developer must implement):
  Layer.provide(
    Layer.mergeAll(
      MockAchievementRoleMappingsRepositoryLayer,
      MockAchievementSettingsRepositoryLayer,
      MockCustomAchievementsRepositoryLayer,
      MockDiscordRoleProvisionEventsRepositoryLayer,
      MockAchievementPreviewLayer,
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
  resetStores();
  currentMembership = {
    id: TEST_MEMBER_ID,
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_ID,
    active: true,
    role_names: ['Captain'],
    permissions: CAPTAIN_PERMISSIONS,
  } as unknown as MembershipWithRole;
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/achievements`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

// Test 2: PUT setBuiltInThreshold happy path
describe('PUT /teams/:teamId/achievements/built-in/:slug/threshold', () => {
  it('returns 204 and stores override when captain sends { threshold: 20 } for ten_activities', async () => {
    const response = await handler(
      new Request(`${BASE}/built-in/ten_activities/threshold`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ threshold: 20 }),
      }),
    );
    expect(response.status).toBe(204);

    // After the PUT, the in-memory store should have the override
    const overrides = await Effect.runPromise(
      AchievementSettingsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findOverridesByTeam(TEST_TEAM_ID)),
        Effect.provide(MockAchievementSettingsRepositoryLayer),
      ),
    );
    expect(overrides.get('ten_activities')).toBe(20);
  });
});

// Test 3: POST createCustom happy path
describe('POST /teams/:teamId/achievements/custom', () => {
  it('returns 201 with generated id for a valid custom achievement', async () => {
    const response = await handler(
      new Request(`${BASE}/custom`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'My Custom',
          description: 'A custom achievement',
          ruleKind: 'total_activities',
          threshold: 5,
          emoji: null,
          activityTypeSlug: null,
          discordRoleId: null,
        }),
      }),
    );
    // API spec says 201; body may contain the id
    expect(response.status).toBe(201);
  });

  // Test 4: duplicate name → 409
  it('returns 409 CustomAchievementNameTaken when name already exists in team', async () => {
    // Pre-seed the store with a 'Foo' custom achievement
    await Effect.runPromise(
      CustomAchievementsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insert({
            team_id: TEST_TEAM_ID,
            name: 'Foo',
            description: 'Pre-existing',
            emoji: Option.none(),
            rule_kind: 'total_activities',
            threshold: 3,
            activity_type_slug: Option.none(),
            discord_role_id: Option.none(),
          } as any),
        ),
        Effect.provide(MockCustomAchievementsRepositoryLayer),
      ),
    );

    const response = await handler(
      new Request(`${BASE}/custom`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Foo',
          description: 'Duplicate name',
          ruleKind: 'total_activities',
          threshold: 5,
          emoji: null,
          activityTypeSlug: null,
          discordRoleId: null,
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag).toBe('CustomAchievementNameTaken');
  });

  // Test 5: invalid rule → 400
  it('returns 400 InvalidCustomRule when ruleKind is activity_type_count but activityTypeSlug is absent', async () => {
    const response = await handler(
      new Request(`${BASE}/custom`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Type Count Missing Slug',
          description: 'Missing activity type slug',
          ruleKind: 'activity_type_count',
          threshold: 5,
          emoji: null,
          activityTypeSlug: null, // required when ruleKind is activity_type_count
          discordRoleId: null,
        }),
      }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('InvalidCustomRule');
  });
});

// Test 6: GET previewBuiltInThreshold shape
describe('GET /teams/:teamId/achievements/built-in/:slug/preview', () => {
  it('returns qualifyingCount, removedMembers, botCanManageRoles from AchievementPreview service', async () => {
    // mockPreviewResponse is already set at module level with the stub data
    const response = await handler(
      new Request(`${BASE}/built-in/ten_activities/preview?threshold=20`, {
        method: 'GET',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(typeof body.qualifyingCount).toBe('number');
    expect(Array.isArray(body.removedMembers)).toBe(true);
    expect(typeof body.botCanManageRoles).toBe('boolean');
    // Values match the stub
    expect(body.qualifyingCount).toBe(3);
    expect(body.removedMembers).toHaveLength(1);
    expect(body.removedMembers[0].memberName).toBe('Alice');
    expect(body.botCanManageRoles).toBe(true);
  });
});

// Test 7: Permission check — non-admin → 403 for all 7 endpoints
describe('Permission check: non-admin (roster:view only) → 403 AchievementForbidden', () => {
  const endpoints: Array<{ method: string; path: string; body?: string }> = [
    { method: 'GET', path: `${BASE}` },
    {
      method: 'GET',
      path: `${BASE}/built-in/ten_activities/preview?threshold=20`,
    },
    {
      method: 'PUT',
      path: `${BASE}/built-in/ten_activities/threshold`,
      body: JSON.stringify({ threshold: 20 }),
    },
    {
      method: 'PUT',
      path: `${BASE}/ten_activities/role-mapping`,
      body: JSON.stringify({ source: 'none' }),
    },
    {
      method: 'POST',
      path: `${BASE}/custom`,
      body: JSON.stringify({
        name: 'Test',
        description: 'Test',
        ruleKind: 'total_activities',
        threshold: 1,
        emoji: null,
        activityTypeSlug: null,
        discordRoleId: null,
      }),
    },
    {
      method: 'PATCH',
      path: `${BASE}/custom/00000000-0000-0000-0000-000000000099`,
      body: JSON.stringify({
        name: null,
        description: null,
        emoji: null,
        ruleKind: null,
        threshold: null,
        activityTypeSlug: null,
        discordRoleId: null,
      }),
    },
    {
      method: 'DELETE',
      path: `${BASE}/custom/00000000-0000-0000-0000-000000000099`,
    },
  ];

  it.each(endpoints)('$method $path returns 403 for player with roster:view only', async ({
    method,
    path,
    body,
  }) => {
    currentMembership = playerMembership;
    const init: RequestInit = {
      method,
      headers: {
        Authorization: 'Bearer player-token',
        'Content-Type': 'application/json',
      },
    };
    if (body !== undefined) init.body = body;
    const response = await handler(new Request(path, init));
    expect(response.status).toBe(403);
    const json = await response.json();
    expect(json._tag).toBe('AchievementForbidden');
  });
});

// ---------------------------------------------------------------------------
// setRoleMapping tests (fix #4, #7, #14)
// ---------------------------------------------------------------------------

const TEST_CUSTOM_ID = '00000000-0000-0000-0000-000000000099';

describe('PUT /teams/:teamId/achievements/:keyOrId/role-mapping', () => {
  it('returns 204 and persists mapping for existing source on built-in slug', async () => {
    const response = await handler(
      new Request(`${BASE}/ten_activities/role-mapping`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'existing', roleId: '123456789012345678' }),
      }),
    );
    expect(response.status).toBe(204);
    expect(roleMappingsStore.get(`${TEST_TEAM_ID}:ten_activities`)).toBe('123456789012345678');
  });

  it('returns 204 and clears mapping for none source on built-in slug', async () => {
    roleMappingsStore.set(`${TEST_TEAM_ID}:ten_activities`, '123456789012345678');
    const response = await handler(
      new Request(`${BASE}/ten_activities/role-mapping`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'none' }),
      }),
    );
    expect(response.status).toBe(204);
    expect(roleMappingsStore.has(`${TEST_TEAM_ID}:ten_activities`)).toBe(false);
  });

  it('returns 204 and enqueues outbox row with correct desired_name for auto_create on built-in slug', async () => {
    const response = await handler(
      new Request(`${BASE}/ten_activities/role-mapping`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'auto_create' }),
      }),
    );
    expect(response.status).toBe(204);
    const row = drpeStore.find((r) => r.ref_id === 'ten_activities' && r.processed_at === null);
    expect(row).toBeDefined();
    expect(row?.desired_name).toBe('Getting Started');
  });

  it('returns 404 AchievementNotFound for garbage keyOrId', async () => {
    const response = await handler(
      new Request(`${BASE}/not-a-slug-or-uuid/role-mapping`, {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ source: 'none' }),
      }),
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json._tag).toBe('AchievementNotFound');
  });
});

// ---------------------------------------------------------------------------
// updateCustom / deleteCustom happy paths (fix #14)
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/achievements/custom/:customId', () => {
  it('returns 204 on happy path update', async () => {
    customStore.set(TEST_CUSTOM_ID, {
      id: TEST_CUSTOM_ID as any,
      team_id: TEST_TEAM_ID,
      name: 'My Achievement',
      description: 'Old description',
      emoji: Option.none(),
      rule_kind: 'total_activities',
      threshold: 5,
      activity_type_slug: Option.none(),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`${BASE}/custom/${TEST_CUSTOM_ID}`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Updated Name',
          description: 'New description',
          emoji: null,
          ruleKind: null,
          threshold: null,
          activityTypeSlug: null,
          discordRoleId: null,
        }),
      }),
    );
    expect(response.status).toBe(204);
  });
});

describe('DELETE /teams/:teamId/achievements/custom/:customId', () => {
  it('returns 204 on happy path delete', async () => {
    customStore.set(TEST_CUSTOM_ID, {
      id: TEST_CUSTOM_ID as any,
      team_id: TEST_TEAM_ID,
      name: 'To Delete',
      description: 'desc',
      emoji: Option.none(),
      rule_kind: 'total_activities',
      threshold: 3,
      activity_type_slug: Option.none(),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`${BASE}/custom/${TEST_CUSTOM_ID}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer captain-token' },
      }),
    );
    expect(response.status).toBe(204);
    expect(customStore.has(TEST_CUSTOM_ID)).toBe(false);
  });
});
