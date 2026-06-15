/**
 * Tests for the `setAccess` diff logic in
 * `applications/server/src/api/channel.ts`.
 *
 * Covers: grant/revoke diff, guild-linked guard, and permission guard.
 */

import type {
  Auth,
  Discord,
  GroupModel,
  Role,
  Team,
  TeamChannel,
  TeamMember,
} from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
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
import { TeamChannelAccessRepository } from '~/repositories/TeamChannelAccessRepository.js';
import { TeamChannelsRepository } from '~/repositories/TeamChannelsRepository.js';
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

const TEST_ADMIN_ID = '00000000-0000-0000-0006-000000000002' as Auth.UserId;
const TEST_USER_ID = '00000000-0000-0000-0006-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0006-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0006-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0006-000000000021' as TeamMember.TeamMemberId;
const TEST_CHANNEL_ID = '00000000-0000-0000-0006-000000000030' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '777777777777777777' as Discord.Snowflake;
const GROUP_A = '00000000-0000-0000-0006-000000000040' as GroupModel.GroupId;
const GROUP_B = '00000000-0000-0000-0006-000000000041' as GroupModel.GroupId;
// GROUP_C has NO entry in groupRoleMap — its Discord role ID is unresolvable, mirroring
// production's `discord_role_id IS NOT NULL` filter.
const GROUP_C = '00000000-0000-0000-0006-000000000042' as GroupModel.GroupId;
const ROLE_A = '111111111111111111' as Discord.Snowflake;
const ROLE_B = '222222222222222222' as Discord.Snowflake;

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
  'group:manage',
];

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: false,
  name: Option.none<string>(),
  birth_date: Option.none(),
  gender: Option.none<'male' | 'female' | 'other'>(),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

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

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Test Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const usersMap = new Map<Auth.UserId, typeof testUser | typeof testAdmin>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin);

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_ADMIN_ID);
sessionsStore.set('member-token', TEST_USER_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: ['roster:view', 'member:view'],
});
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});

// ---------------------------------------------------------------------------
// In-memory stores — per-test
// ---------------------------------------------------------------------------

type AccessEntry = { group_id: GroupModel.GroupId; access_level: string };

let accessStore: Map<TeamChannel.TeamChannelId, AccessEntry[]>;
let upsertCalls: Array<{ channelId: string; groupId: string; level: string }>;
let deleteCalls: Array<{ channelId: string; groupId: string }>;
let grantedBatchCalls: Array<{ entries: unknown[] }>;
let revokedBatchCalls: Array<{ entries: unknown[] }>;

const resetStores = () => {
  accessStore = new Map();
  upsertCalls = [];
  deleteCalls = [];
  grantedBatchCalls = [];
  revokedBatchCalls = [];
};

// The channel being tested (always linked to DISCORD_CHANNEL_ID for event tests)
const testChannel = {
  id: TEST_CHANNEL_ID,
  team_id: TEST_TEAM_ID,
  name: 'test-channel',
  category: Option.none<string>(),
  position: 0,
  archived: false,
  discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
  discord_role_id: Option.none<Discord.Snowflake>(),
};

// ---------------------------------------------------------------------------
// Group role ID mapping — used by findGroupRoleIds
// ---------------------------------------------------------------------------

const groupRoleMap = new Map<GroupModel.GroupId, Discord.Snowflake>();
groupRoleMap.set(GROUP_A, ROLE_A);
groupRoleMap.set(GROUP_B, ROLE_B);

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const makeAccessLayer = () =>
  Layer.succeed(TeamChannelAccessRepository, {
    _tag: 'api/TeamChannelAccessRepository',
    findByChannel: (channelId: TeamChannel.TeamChannelId) =>
      Effect.succeed(accessStore.get(channelId) ?? []),
    findByChannelForUpdate: (channelId: TeamChannel.TeamChannelId) =>
      Effect.succeed(accessStore.get(channelId) ?? []),
    upsertGrant: (
      channelId: TeamChannel.TeamChannelId,
      groupId: GroupModel.GroupId,
      level: string,
    ) => {
      upsertCalls.push({ channelId, groupId, level });
      const current = accessStore.get(channelId) ?? [];
      const idx = current.findIndex((e) => e.group_id === groupId);
      if (idx >= 0) {
        current[idx] = { group_id: groupId, access_level: level };
      } else {
        current.push({ group_id: groupId, access_level: level });
      }
      accessStore.set(channelId, current);
      return Effect.void;
    },
    deleteGrant: (channelId: TeamChannel.TeamChannelId, groupId: GroupModel.GroupId) => {
      deleteCalls.push({ channelId, groupId });
      const current = accessStore.get(channelId) ?? [];
      accessStore.set(
        channelId,
        current.filter((e) => e.group_id !== groupId),
      );
      return Effect.void;
    },
    countByChannel: (channelId: TeamChannel.TeamChannelId) =>
      Effect.succeed((accessStore.get(channelId) ?? []).length),
    findGroupRoleIds: (groupIds: readonly GroupModel.GroupId[]) =>
      Effect.succeed(
        groupIds
          .map((id) => ({
            group_id: id,
            discord_role_id: Option.fromNullishOr(groupRoleMap.get(id)),
          }))
          .filter((r) => Option.isSome(r.discord_role_id)),
      ),
  } as never);

const makeChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitChannelArchived: () => Effect.void,
    emitChannelDetached: () => Effect.void,
    emitRosterChannelCreated: () => Effect.void,
    emitRosterChannelDeleted: () => Effect.void,
    emitRosterChannelArchived: () => Effect.void,
    emitRosterChannelDetached: () => Effect.void,
    emitGroupChannelUpdated: () => Effect.void,
    emitRosterChannelUpdated: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitManagedChannelCreated: () => Effect.void,
    emitManagedChannelArchived: () => Effect.void,
    emitManagedChannelDeleted: () => Effect.void,
    emitDiscordChannelArchived: () => Effect.void,
    emitManagedAccessGrantedBatch: (args: { entries: unknown[] }) => {
      if (args.entries.length > 0) grantedBatchCalls.push({ entries: args.entries });
      return Effect.void;
    },
    emitManagedAccessRevokedBatch: (args: { entries: unknown[] }) => {
      if (args.entries.length > 0) revokedBatchCalls.push({ entries: args.entries });
      return Effect.void;
    },
    emitMembersAddedBatch: () => Effect.void,
    emitMembersRemovedBatch: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

// ---------------------------------------------------------------------------
// SqlClient mock — needed for setAccess which uses sql.withTransaction
// ---------------------------------------------------------------------------

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
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> =>
        effect,
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
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

const buildFullLayer = (overrides?: {
  guildLinked?: boolean;
  discordChannelId?: Option.Option<Discord.Snowflake>;
}) => {
  const channelRow = {
    ...testChannel,
    discord_channel_id:
      overrides?.discordChannelId !== undefined
        ? overrides.discordChannelId
        : testChannel.discord_channel_id,
  };

  const channelsLayer = Layer.succeed(TeamChannelsRepository, {
    _tag: 'api/TeamChannelsRepository',
    findById: (channelId: TeamChannel.TeamChannelId) => {
      if (channelId === TEST_CHANNEL_ID) return Effect.succeed(Option.some(channelRow));
      return Effect.succeed(Option.none());
    },
    findAllByTeam: () => Effect.succeed([channelRow]),
    insert: () => Effect.die(new Error('Not implemented in ChannelAccess test')),
    rename: () => Effect.die(new Error('Not implemented')),
    updateOrganization: () => Effect.die(new Error('Not implemented')),
    setArchived: () => Effect.void,
    delete: () => Effect.void,
    upsertDiscordChannelId: () => Effect.void,
    clearDiscordChannelId: () => Effect.void,
  } as never);

  const botGuildsLayer = Layer.succeed(BotGuildsRepository, {
    upsert: () => Effect.void,
    remove: () => Effect.void,
    exists: () => Effect.succeed(overrides?.guildLinked ?? true),
    findAll: () => Effect.succeed([]),
    findByGuildId: () => Effect.succeed(Option.none()),
  } as any);

  return ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(
      Layer.succeed(DiscordOAuth, {
        createAuthorizationURL: () =>
          Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
        validateAuthorizationCode: () =>
          Effect.succeed(new OAuth2Tokens({ access_token: 'mock', refresh_token: 'mock' })),
      } as any),
    ),
    Layer.provide(
      Layer.succeed(UsersRepository, {
        findById: (id: Auth.UserId) => Effect.succeed(Option.fromNullishOr(usersMap.get(id))),
        findByDiscordId: () => Effect.succeed(Option.none()),
        upsertFromDiscord: () => Effect.succeed(testUser),
        completeProfile: () => Effect.succeed(testUser),
        updateLocale: () => Effect.succeed(testUser),
        updateAdminProfile: () => Effect.die(new Error('Not implemented')),
      } as any),
    ),
    Layer.provide(
      Layer.succeed(SessionsRepository, {
        create: () => Effect.die(new Error('Not implemented')),
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
      } as any),
    ),
    Layer.provide(
      Layer.succeed(TeamsRepository, {
        findById: (id: Team.TeamId) => {
          if (id === TEST_TEAM_ID) return Effect.succeed(Option.some(testTeam));
          return Effect.succeed(Option.none());
        },
        insert: () => Effect.succeed(testTeam),
        findByGuildId: () => Effect.succeed(Option.none()),
      } as any),
    ),
    Layer.provide(
      Layer.succeed(TeamMembersRepository, {
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
        getPlayerRoleId: () => Effect.succeed(Option.none()),
        assignRole: () => Effect.void,
        unassignRole: () => Effect.void,
        setJerseyNumber: () => Effect.void,
      } as any),
    ),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.succeed(RostersRepository, {
            findByTeamId: () => Effect.succeed([]),
            findRosterById: () => Effect.succeed(Option.none()),
            insert: () => Effect.die(new Error('Not implemented')),
            update: () => Effect.die(new Error('Not implemented')),
            delete: () => Effect.void,
            findMemberEntriesById: () => Effect.succeed([]),
            addMemberById: () => Effect.void,
            removeMemberById: () => Effect.void,
          } as any),
          Layer.succeed(ActivityLogsRepository, {
            insert: () => Effect.die(new Error('not implemented')),
            findByTeamMember: () => Effect.succeed([]),
          } as any),
        ),
        Layer.merge(
          Layer.succeed(ActivityTypesRepository, {
            findBySlug: () => Effect.succeed(Option.none()),
            findByTeamId: () => Effect.succeed([]),
            findById: () => Effect.succeed(Option.none()),
          } as any),
          Layer.succeed(LeaderboardRepository, { getLeaderboard: () => Effect.succeed([]) } as any),
        ),
      ),
    ),
    Layer.provide(
      Layer.merge(
        Layer.succeed(TeamInvitesRepository, {
          findByCode: () => Effect.succeed(Option.none()),
          findByTeam: () => Effect.succeed([]),
          create: () => Effect.die(new Error('Not implemented')),
          deactivateByTeam: () => Effect.void,
          deactivateByTeamExcept: () => Effect.void,
        } as any),
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
    Layer.provide(
      Layer.succeed(RolesRepository, {
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
      } as any),
    ),
    Layer.provide(
      Layer.succeed(GroupsRepository, {
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
        getAncestors: () => Effect.succeed([]),
        getDescendantMemberIds: () => Effect.succeed([]),
      } as any),
    ),
    Layer.provide(
      Layer.succeed(TrainingTypesRepository, {
        findByTeamId: () => Effect.succeed([]),
        findById: () => Effect.succeed(Option.none()),
        insert: () => Effect.die(new Error('Not implemented')),
        update: () => Effect.die(new Error('Not implemented')),
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
      } as any),
    ),
    Layer.provide(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((req) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              req,
              new Response(JSON.stringify({}), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
              }),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(
      Layer.succeed(AgeCheckService, {
        evaluateTeam: () => Effect.succeed([]),
        evaluate: () => Effect.succeed([]),
      } as any),
    ),
    Layer.provide(
      Layer.succeed(AgeThresholdRepository, {
        findByTeamId: () => Effect.succeed([]),
        findById: () => Effect.succeed(Option.none()),
        insert: () => Effect.die(new Error('Not implemented')),
        updateRuleById: () => Effect.die(new Error('Not implemented')),
        deleteRuleById: () => Effect.void,
        getAllTeamsWithRules: () => Effect.succeed([]),
        getMembersForAutoAssignment: () => Effect.succeed([]),
        findRulesByTeamId: () => Effect.succeed([]),
        findRuleById: () => Effect.succeed(Option.none()),
      } as any),
    ),
    Layer.provide(
      Layer.merge(
        Layer.succeed(NotificationsRepository, {
          findByUser: () => Effect.succeed([]),
          insert: () => Effect.void,
          insertBulk: () => Effect.void,
          markAsRead: () => Effect.void,
          markAllAsRead: () => Effect.void,
          findById: () => Effect.succeed(Option.none()),
        } as any),
        Layer.succeed(RoleSyncEventsRepository, {
          emitRoleCreated: () => Effect.void,
          emitRoleDeleted: () => Effect.void,
          emitRoleAssigned: () => Effect.void,
          emitRoleUnassigned: () => Effect.void,
          findUnprocessed: () => Effect.succeed([]),
          markProcessed: () => Effect.void,
          markFailed: () => Effect.void,
        } as any),
      ),
    ),
    Layer.provide(
      Layer.merge(
        makeChannelSyncLayer(),
        Layer.succeed(EventSyncEventsRepository, {
          emitEventCreated: () => Effect.void,
          emitEventUpdated: () => Effect.void,
          emitEventCancelled: () => Effect.void,
          emitRsvpReminder: () => Effect.void,
          findUnprocessed: () => Effect.succeed([]),
          markProcessed: () => Effect.void,
          markFailed: () => Effect.void,
        } as any),
      ),
    ),
    Layer.provide(
      Layer.merge(
        Layer.succeed(DiscordChannelMappingRepository, {
          findByGroupId: () => Effect.succeed(Option.none()),
          findByRosterId: () => Effect.succeed(Option.none()),
          insert: () => Effect.void,
          insertRoleOnly: () => Effect.void,
          upsertGroupChannel: () => Effect.void,
          clearGroupChannel: () => Effect.void,
          insertRoster: () => Effect.void,
          deleteByGroupId: () => Effect.void,
          deleteByRosterId: () => Effect.void,
          findAllByTeam: () => Effect.succeed([]),
        } as any),
        Layer.succeed(ICalTokensRepository, {
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
        } as any),
      ),
    ),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.merge(
                Layer.merge(
                  Layer.succeed(EventsRepository, {
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
                  } as any),
                  Layer.succeed(EventRsvpsRepository, {
                    findByEventId: () => Effect.succeed([]),
                    findByEventAndMember: () => Effect.succeed(Option.none()),
                    upsert: () => Effect.die(new Error('Not implemented')),
                    countByEventId: () => Effect.succeed([]),
                  } as any),
                ),
                botGuildsLayer,
              ),
              Layer.merge(
                Layer.succeed(DiscordChannelsRepository, {
                  syncChannels: () => Effect.void,
                  findByGuildId: () => Effect.succeed([]),
                  findManagedListByTeam: () => Effect.succeed([]),
                  findByChannelId: () => Effect.succeed(Option.none()),
                } as any),
                Layer.succeed(
                  DiscordRolesRepository,
                  new Proxy({} as any, { get: () => () => Effect.void }),
                ),
              ),
            ),
            Layer.succeed(EventSeriesRepository, {
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
            } as any),
          ),
          Layer.succeed(TeamSettingsRepository, {
            findByTeam: () => Effect.succeed(Option.none()),
            findByTeamId: () => Effect.succeed(Option.none()),
            upsertSettings: () => Effect.void,
            upsert: () => Effect.void,
            getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
            getHorizonDays: () => Effect.succeed(30),
          } as any),
        ),
        Layer.succeed(OAuthConnectionsRepository, {
          upsert: () => Effect.die(new Error('Not implemented')),
          findByUserAndProvider: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed(Option.none()),
          findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock' })),
          getAccessToken: () => Effect.succeed('mock'),
        } as any),
      ),
    ),
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
  )
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(channelsLayer))
    .pipe(Layer.provide(makeAccessLayer()))
    .pipe(Layer.provide(MockSqlClientLayer))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
      ),
    );
};

const setAccessRequest = (grants: Array<{ groupId: string; accessLevel: string }>) =>
  new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/access`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ grants }),
  });

const getChannelRequest = () =>
  new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}`, {
    method: 'GET',
    headers: { Authorization: 'Bearer admin-token' },
  });

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(buildFullLayer());
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
// setAccess tests
// ---------------------------------------------------------------------------

describe('setAccess — diff logic', () => {
  it('{} → [{A, EDIT}]: emits one access-granted for A with EDIT, persists grant', async () => {
    // Start empty
    const response = await handler(setAccessRequest([{ groupId: GROUP_A, accessLevel: 'EDIT' }]));

    expect(response.status).toBe(200);

    // Grant was persisted
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_A, level: 'EDIT' });

    // No revokes
    expect(deleteCalls).toHaveLength(0);

    // Sync event emitted with correct level
    expect(grantedBatchCalls).toHaveLength(1);
    const batch = grantedBatchCalls[0]!;
    expect(batch.entries).toHaveLength(1);
    const entry = (batch.entries as any[])[0];
    expect(entry.accessLevel).toBe('EDIT');
    expect(entry.discordRoleId).toBe(ROLE_A);
  });

  it('[{A, VIEW}] → [{A, ADMIN}]: emits one granted with ADMIN, no revoke', async () => {
    // Seed A with VIEW
    accessStore.set(TEST_CHANNEL_ID, [{ group_id: GROUP_A, access_level: 'VIEW' }]);

    const response = await handler(setAccessRequest([{ groupId: GROUP_A, accessLevel: 'ADMIN' }]));

    expect(response.status).toBe(200);
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_A, level: 'ADMIN' });
    expect(deleteCalls).toHaveLength(0);
    expect(revokedBatchCalls).toHaveLength(0);
    expect(grantedBatchCalls).toHaveLength(1);
  });

  it('[{A, EDIT},{B, VIEW}] → [{A, EDIT}]: emits one revoked for B only, A unchanged', async () => {
    // Seed A=EDIT, B=VIEW
    accessStore.set(TEST_CHANNEL_ID, [
      { group_id: GROUP_A, access_level: 'EDIT' },
      { group_id: GROUP_B, access_level: 'VIEW' },
    ]);

    const response = await handler(setAccessRequest([{ groupId: GROUP_A, accessLevel: 'EDIT' }]));

    expect(response.status).toBe(200);
    // A is unchanged — no upsert
    expect(upsertCalls).toHaveLength(0);
    // B revoked
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({ groupId: GROUP_B });
    // Revoked batch emitted
    expect(revokedBatchCalls).toHaveLength(1);
    const rBatch = revokedBatchCalls[0]?.entries as any[];
    expect(rBatch).toHaveLength(1);
    expect(rBatch[0].discordRoleId).toBe(ROLE_B);
    // No grant event
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('[{A, EDIT}] → {}: emits one revoked for A', async () => {
    accessStore.set(TEST_CHANNEL_ID, [{ group_id: GROUP_A, access_level: 'EDIT' }]);

    const response = await handler(setAccessRequest([]));

    expect(response.status).toBe(200);
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({ groupId: GROUP_A });
    expect(revokedBatchCalls).toHaveLength(1);
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('guild not linked: grants written, zero sync events emitted', async () => {
    // When guild is not linked we use discordChannelId=None so the handler genuinely
    // skips all sync emission.  The guard in channel.ts is:
    //   `if (discordChannelId === null) return Effect.void`
    // The module-level grantedBatchCalls / revokedBatchCalls spy arrays (populated by
    // makeChannelSyncLayer()) give us a clean assertion that no emit happened.
    // Note: buildFullLayer() always calls makeChannelSyncLayer() which populates the
    // module-level spy arrays, so assertions on those are meaningful here.
    const _app = HttpRouter.toWebHandler(
      buildFullLayer({ guildLinked: false, discordChannelId: Option.none() }),
    );
    const customHandler: (...args: any) => Promise<Response> = _app.handler;

    try {
      const response = await customHandler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/access`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ grants: [{ groupId: GROUP_A, accessLevel: 'VIEW' }] }),
        }),
      );

      expect(response.status).toBe(200);
      // DB write still happens
      expect(upsertCalls).toHaveLength(1);
      // Zero sync events because the channel has no discord_channel_id —
      // the handler explicitly skips emit when discord_channel_id is null
      expect(grantedBatchCalls).toHaveLength(0);
      expect(revokedBatchCalls).toHaveLength(0);
    } finally {
      await _app.dispose();
    }
  });

  it('channel without discord_channel_id: grants written, zero sync events emitted', async () => {
    const _app2 = HttpRouter.toWebHandler(buildFullLayer({ discordChannelId: Option.none() }));
    const customHandler2: (...args: any) => Promise<Response> = _app2.handler;

    try {
      const response = await customHandler2(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/access`, {
          method: 'PUT',
          headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ grants: [{ groupId: GROUP_A, accessLevel: 'VIEW' }] }),
        }),
      );

      expect(response.status).toBe(200);
      // Grant persisted
      expect(upsertCalls).toHaveLength(1);
      // No sync events (channel not linked to Discord)
      expect(grantedBatchCalls).toHaveLength(0);
      expect(revokedBatchCalls).toHaveLength(0);
    } finally {
      await _app2.dispose();
    }
  });

  it('caller without group:manage → 403, no writes', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/access`, {
        method: 'PUT',
        headers: { Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ grants: [{ groupId: GROUP_A, accessLevel: 'EDIT' }] }),
      }),
    );

    expect(response.status).toBe(403);
    expect(upsertCalls).toHaveLength(0);
    expect(deleteCalls).toHaveLength(0);
    expect(grantedBatchCalls).toHaveLength(0);
    expect(revokedBatchCalls).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // roleResolvable — new tests (TDD: these fail until implementation ships)
  // -------------------------------------------------------------------------

  it('{} → [A:VIEW, B:VIEW]: 2 upserts, ONE granted-batch call with both entries', async () => {
    // Start empty — grant A and B together
    const response = await handler(
      setAccessRequest([
        { groupId: GROUP_A, accessLevel: 'VIEW' },
        { groupId: GROUP_B, accessLevel: 'VIEW' },
      ]),
    );

    expect(response.status).toBe(200);

    // Both grants persisted
    expect(upsertCalls).toHaveLength(2);
    const upsertedGroupIds = upsertCalls.map((c) => c.groupId);
    expect(upsertedGroupIds).toContain(GROUP_A);
    expect(upsertedGroupIds).toContain(GROUP_B);

    // No revokes
    expect(deleteCalls).toHaveLength(0);

    // Exactly ONE granted-batch call containing BOTH entries
    expect(grantedBatchCalls).toHaveLength(1);
    const batchEntries = grantedBatchCalls[0]?.entries as any[];
    expect(batchEntries).toHaveLength(2);
    const roleIds = batchEntries.map((e) => e.discordRoleId);
    expect(roleIds).toContain(ROLE_A);
    expect(roleIds).toContain(ROLE_B);

    // Response shape
    const body = (await response.json()) as any;
    expect(body.grants).toHaveLength(2);
  });

  it('[A:VIEW] → [A:VIEW, B:EDIT]: 1 upsert (B only), ONE granted-batch call with B→ROLE_B (bug repro)', async () => {
    // Seed A with VIEW already present
    accessStore.set(TEST_CHANNEL_ID, [{ group_id: GROUP_A, access_level: 'VIEW' }]);

    // Request adds B at EDIT; A stays at VIEW (unchanged)
    const response = await handler(
      setAccessRequest([
        { groupId: GROUP_A, accessLevel: 'VIEW' },
        { groupId: GROUP_B, accessLevel: 'EDIT' },
      ]),
    );

    expect(response.status).toBe(200);

    // Only B is upserted — A is unchanged and must NOT be re-upserted
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_B, level: 'EDIT' });

    // No revokes
    expect(deleteCalls).toHaveLength(0);

    // Exactly ONE granted-batch call with exactly 1 entry for B at EDIT
    // Also assert GROUP_A / ROLE_A is ABSENT from the batch (only B should be emitted)
    expect(grantedBatchCalls).toHaveLength(1);
    const batchEntries = grantedBatchCalls[0]?.entries as any[];
    expect(batchEntries).toHaveLength(1);
    expect(batchEntries[0].discordRoleId).toBe(ROLE_B);
    expect(batchEntries[0].accessLevel).toBe('EDIT');
    const batchGroupRoleIds = batchEntries.map((e: any) => e.discordRoleId);
    expect(batchGroupRoleIds).not.toContain(ROLE_A);

    // Response body must contain both grants preserving A at VIEW
    const body = (await response.json()) as any;
    expect(body.grants).toHaveLength(2);
    const responseGrantA = (body.grants as any[]).find((g: any) => g.groupId === GROUP_A);
    const responseGrantB = (body.grants as any[]).find((g: any) => g.groupId === GROUP_B);
    expect(responseGrantA?.accessLevel).toBe('VIEW');
    expect(responseGrantB?.accessLevel).toBe('EDIT');

    // A's grant remains untouched — still VIEW in store
    const stored = accessStore.get(TEST_CHANNEL_ID) ?? [];
    const aEntry = stored.find((e) => e.group_id === GROUP_A);
    expect(aEntry?.access_level).toBe('VIEW');
  });

  it('{} → [C:VIEW]: grant persisted, NO granted-batch call (unresolvable group)', async () => {
    // GROUP_C has no entry in groupRoleMap → role is unresolvable
    const response = await handler(setAccessRequest([{ groupId: GROUP_C, accessLevel: 'VIEW' }]));

    expect(response.status).toBe(200);

    // The grant IS persisted in the DB
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_C, level: 'VIEW' });

    // But NO batch emit because no role could be resolved
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('{} → [A:VIEW, C:VIEW]: both persisted, ONE granted-batch call with ONLY A (C skipped)', async () => {
    // GROUP_A is resolvable (ROLE_A); GROUP_C is not
    const response = await handler(
      setAccessRequest([
        { groupId: GROUP_A, accessLevel: 'VIEW' },
        { groupId: GROUP_C, accessLevel: 'VIEW' },
      ]),
    );

    expect(response.status).toBe(200);

    // Both grants persisted
    expect(upsertCalls).toHaveLength(2);
    const upsertedGroupIds = upsertCalls.map((c) => c.groupId);
    expect(upsertedGroupIds).toContain(GROUP_A);
    expect(upsertedGroupIds).toContain(GROUP_C);

    // Exactly ONE granted-batch call — contains ONLY the A entry (C is skipped)
    expect(grantedBatchCalls).toHaveLength(1);
    const batchEntries = grantedBatchCalls[0]?.entries as any[];
    expect(batchEntries).toHaveLength(1);
    expect(batchEntries[0].discordRoleId).toBe(ROLE_A);

    // Response carries both grants (A and C)
    const body = (await response.json()) as any;
    expect(body.grants).toHaveLength(2);
  });

  // -------------------------------------------------------------------------
  // Unresolvable-REVOKE path — these test the revoke side of setAccess which
  // independently filters groups whose discord_role_id cannot be resolved.
  // -------------------------------------------------------------------------

  it('[C:VIEW] → {} (C unresolvable): deleteGrant for C, NO revoked-batch call, HTTP 200', async () => {
    // Seed C into the store so there is a grant to revoke
    accessStore.set(TEST_CHANNEL_ID, [{ group_id: GROUP_C, access_level: 'VIEW' }]);

    const response = await handler(setAccessRequest([]));

    expect(response.status).toBe(200);

    // The grant IS deleted from the DB
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({ groupId: GROUP_C });

    // No upserts
    expect(upsertCalls).toHaveLength(0);

    // The revoked-batch mock guards on entries.length > 0 — C has no role, so the
    // entries array is empty and the mock does NOT push to revokedBatchCalls.
    expect(revokedBatchCalls).toHaveLength(0);

    // No granted batches either
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('[B:VIEW] → {} (B resolvable): deleteGrant for B, ONE revoked-batch call with ROLE_B, HTTP 200', async () => {
    accessStore.set(TEST_CHANNEL_ID, [{ group_id: GROUP_B, access_level: 'VIEW' }]);

    const response = await handler(setAccessRequest([]));

    expect(response.status).toBe(200);

    // The grant is deleted
    expect(deleteCalls).toHaveLength(1);
    expect(deleteCalls[0]).toMatchObject({ groupId: GROUP_B });

    // Exactly one revoked-batch call with ROLE_B
    expect(revokedBatchCalls).toHaveLength(1);
    const revokedEntries = revokedBatchCalls[0]?.entries as any[];
    expect(revokedEntries).toHaveLength(1);
    expect(revokedEntries[0].discordRoleId).toBe(ROLE_B);

    // No granted batches
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('[B:VIEW, C:VIEW] → {} (mixed): both deleted, ONE revoked-batch with ONLY ROLE_B (C filtered), HTTP 200', async () => {
    // Both B (resolvable) and C (unresolvable) are seeded
    accessStore.set(TEST_CHANNEL_ID, [
      { group_id: GROUP_B, access_level: 'VIEW' },
      { group_id: GROUP_C, access_level: 'VIEW' },
    ]);

    const response = await handler(setAccessRequest([]));

    expect(response.status).toBe(200);

    // Both grants are deleted from the DB
    expect(deleteCalls).toHaveLength(2);
    const deletedGroupIds = deleteCalls.map((c) => c.groupId);
    expect(deletedGroupIds).toContain(GROUP_B);
    expect(deletedGroupIds).toContain(GROUP_C);

    // Exactly ONE revoked-batch call — carrying ONLY ROLE_B (C is filtered out as unresolvable)
    expect(revokedBatchCalls).toHaveLength(1);
    const revokedEntries = revokedBatchCalls[0]?.entries as any[];
    expect(revokedEntries).toHaveLength(1);
    expect(revokedEntries[0].discordRoleId).toBe(ROLE_B);

    // No granted batches
    expect(grantedBatchCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// roleResolvable on responses — new describe block (TDD)
// ---------------------------------------------------------------------------

describe('roleResolvable field in ChannelDetail.grants', () => {
  it('getChannel: grants include roleResolvable=true for A (mapped) and false for C (unmapped)', async () => {
    // Seed both A (has ROLE_A) and C (no role) into accessStore
    accessStore.set(TEST_CHANNEL_ID, [
      { group_id: GROUP_A, access_level: 'VIEW' },
      { group_id: GROUP_C, access_level: 'VIEW' },
    ]);

    const response = await handler(getChannelRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const grants: any[] = body.grants;
    expect(grants).toHaveLength(2);

    const grantA = grants.find((g) => g.groupId === GROUP_A);
    const grantC = grants.find((g) => g.groupId === GROUP_C);

    expect(grantA).toBeDefined();
    expect(grantA.roleResolvable).toBe(true);

    expect(grantC).toBeDefined();
    expect(grantC.roleResolvable).toBe(false);
  });

  it('setAccess response body: grants carry roleResolvable=true for A, false for C', async () => {
    // {} → [A:VIEW, C:VIEW]
    const response = await handler(
      setAccessRequest([
        { groupId: GROUP_A, accessLevel: 'VIEW' },
        { groupId: GROUP_C, accessLevel: 'VIEW' },
      ]),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    const grants: any[] = body.grants;
    expect(grants).toHaveLength(2);

    const grantA = grants.find((g) => g.groupId === GROUP_A);
    const grantC = grants.find((g) => g.groupId === GROUP_C);

    expect(grantA).toBeDefined();
    expect(grantA.roleResolvable).toBe(true);

    expect(grantC).toBeDefined();
    expect(grantC.roleResolvable).toBe(false);
  });
});
