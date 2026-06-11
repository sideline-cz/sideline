/**
 * TDD tests for Task 4 — setAccess lazy heal.
 *
 * When a setAccess grant hits a role-less group (no discord_role_id resolved),
 * the handler must:
 *   1. Still write the DB grant (existing behaviour).
 *   2. Enqueue provisioning: emit a channel_created event for that group
 *      (best-effort, don't fail the request).
 *   3. NOT emit managed_access_granted in the same request (async — will come
 *      once the bot processes the channel_created event and role lands).
 *   4. Return HTTP 200.
 *
 * In-flight guard: if an unprocessed channel_created event already exists for
 * the group, NO second channel_created is emitted.
 *
 * These tests FAIL until the implementation is in place (TDD red state).
 *
 * Pattern follows ChannelAccess.test.ts exactly: use HttpRouter.toWebHandler
 * to drive the full server stack with mock repositories.
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

const TEST_ADMIN_ID = '00000000-0000-0000-0008-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0008-000000000010' as Team.TeamId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0008-000000000021' as TeamMember.TeamMemberId;
const TEST_CHANNEL_ID = '00000000-0000-0000-0008-000000000030' as TeamChannel.TeamChannelId;
const DISCORD_CHANNEL_ID = '888888888888888888' as Discord.Snowflake;
// GROUP_D has NO entry in groupRoleMap (role-less group — the lazy-heal target)
const GROUP_D = '00000000-0000-0000-0008-000000000044' as GroupModel.GroupId;
// GROUP_A has a role — normal case
const GROUP_A = '00000000-0000-0000-0008-000000000040' as GroupModel.GroupId;
const ROLE_A = '111111111111111111' as Discord.Snowflake;

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
  name: 'Lazy Heal Team',
  guild_id: '999999999999999999' as Discord.Snowflake,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_ADMIN_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});

// ---------------------------------------------------------------------------
// Per-test spy stores
// ---------------------------------------------------------------------------

type AccessEntry = { group_id: GroupModel.GroupId; access_level: string };

let accessStore: Map<TeamChannel.TeamChannelId, AccessEntry[]>;
let upsertCalls: Array<{ channelId: string; groupId: string; level: string }>;
let grantedBatchCalls: Array<{ entries: unknown[] }>;
let channelCreatedCalls: Array<{
  teamId: Team.TeamId;
  groupId: GroupModel.GroupId;
  groupName: string;
  existingChannelId: Option.Option<Discord.Snowflake>;
  discordChannelName: string | undefined;
  discordRoleName: string | undefined;
}>;
let hasUnprocessedForGroupsCalls: Array<readonly GroupModel.GroupId[]>;

// findGroupsMissingRoleResult is controlled per-test to inject different partial-provisioning states.
// Default: GROUP_D with no discord_channel_id (standard lazy-heal scenario).
let findGroupsMissingRoleResult: Array<{
  group_id: GroupModel.GroupId;
  team_id: typeof TEST_TEAM_ID;
  name: string;
  emoji: Option.Option<string>;
  color: Option.Option<string>;
  discord_channel_id: Option.Option<Discord.Snowflake>;
}> = [
  {
    group_id: GROUP_D,
    team_id: TEST_TEAM_ID,
    name: 'Visitors',
    emoji: Option.none<string>(),
    color: Option.none<string>(),
    discord_channel_id: Option.none<Discord.Snowflake>(),
  },
];

const resetStores = () => {
  accessStore = new Map();
  upsertCalls = [];
  grantedBatchCalls = [];
  channelCreatedCalls = [];
  hasUnprocessedForGroupsCalls = [];
  // Reset to the default (channel-absent) state for existing tests
  findGroupsMissingRoleResult = [
    {
      group_id: GROUP_D,
      team_id: TEST_TEAM_ID,
      name: 'Visitors',
      emoji: Option.none<string>(),
      color: Option.none<string>(),
      discord_channel_id: Option.none<Discord.Snowflake>(),
    },
  ];
};

// groupRoleMap: only GROUP_A has a role; GROUP_D is role-less
const groupRoleMap = new Map<GroupModel.GroupId, Discord.Snowflake>();
groupRoleMap.set(GROUP_A, ROLE_A);

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeAccessLayer = (_inFlightGroups: GroupModel.GroupId[] = []) =>
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

const makeChannelSyncLayer = (inFlightGroups: GroupModel.GroupId[] = []) =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: (
      teamId: Team.TeamId,
      groupId: GroupModel.GroupId,
      groupName: string,
      existingChannelId: Option.Option<Discord.Snowflake>,
      discordChannelName?: string,
      discordRoleName?: string,
    ) => {
      channelCreatedCalls.push({
        teamId,
        groupId,
        groupName,
        existingChannelId,
        discordChannelName,
        discordRoleName,
      });
      return Effect.void;
    },
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
    emitManagedAccessRevokedBatch: () => Effect.void,
    emitMembersAddedBatch: () => Effect.void,
    emitMembersRemovedBatch: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    // Track calls and return the in-flight groups so the handler can check before re-emitting
    hasUnprocessedForGroups: (groupIds: readonly GroupModel.GroupId[]) => {
      hasUnprocessedForGroupsCalls.push(groupIds);
      return Effect.succeed(groupIds.filter((id) => inFlightGroups.includes(id)));
    },
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

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

const testChannel = {
  id: TEST_CHANNEL_ID,
  team_id: TEST_TEAM_ID,
  name: 'lazy-heal-channel',
  category: Option.none<string>(),
  position: 0,
  archived: false,
  discord_channel_id: Option.some(DISCORD_CHANNEL_ID),
  discord_role_id: Option.none<Discord.Snowflake>(),
};

const buildLazyHealLayer = (inFlightGroups: GroupModel.GroupId[] = []) => {
  const channelsLayer = Layer.succeed(TeamChannelsRepository, {
    _tag: 'api/TeamChannelsRepository',
    findById: (channelId: TeamChannel.TeamChannelId) => {
      if (channelId === TEST_CHANNEL_ID) return Effect.succeed(Option.some(testChannel));
      return Effect.succeed(Option.none());
    },
    findAllByTeam: () => Effect.succeed([testChannel]),
    insert: () => Effect.die(new Error('Not implemented')),
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
    exists: () => Effect.succeed(true),
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
        findById: (id: Auth.UserId) =>
          Effect.succeed(id === TEST_ADMIN_ID ? Option.some(testAdmin) : Option.none()),
        findByDiscordId: () => Effect.succeed(Option.none()),
        upsertFromDiscord: () => Effect.succeed(testAdmin),
        completeProfile: () => Effect.succeed(testAdmin),
        updateLocale: () => Effect.succeed(testAdmin),
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
        findGroupById: (id: GroupModel.GroupId) =>
          id === GROUP_D
            ? Effect.succeed(
                Option.some({
                  id: GROUP_D,
                  team_id: TEST_TEAM_ID,
                  name: 'Visitors',
                  emoji: Option.none(),
                  color: Option.none(),
                  parent_id: Option.none(),
                  is_archived: false,
                }),
              )
            : Effect.succeed(Option.none()),
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
        makeChannelSyncLayer(inFlightGroups),
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
          insert: () => Effect.succeed(Option.none<Discord.Snowflake>()),
          insertRoleOnly: () => Effect.succeed(Option.none<Discord.Snowflake>()),
          upsertGroupChannel: () => Effect.void,
          clearGroupChannel: () => Effect.void,
          insertRoster: () => Effect.void,
          deleteByGroupId: () => Effect.void,
          deleteByRosterId: () => Effect.void,
          findAllByTeam: () => Effect.succeed([]),
          // Return the current findGroupsMissingRoleResult (mutable per-test spy)
          findGroupsMissingRole: () => Effect.succeed(findGroupsMissingRoleResult),
          findClaimThread: () => Effect.succeed(Option.none()),
          saveClaimThreadIfAbsent: () => Effect.succeed(Option.none()),
          clearClaimThread: () => Effect.void,
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
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(channelsLayer))
    .pipe(Layer.provide(makeAccessLayer(inFlightGroups)))
    .pipe(Layer.provide(MockSqlClientLayer))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default));
};

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

const setAccessRequest = (grants: Array<{ groupId: string; accessLevel: string }>) =>
  new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/access`, {
    method: 'PUT',
    headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ grants }),
  });

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('setAccess — Task 4: lazy heal for role-less groups', () => {
  beforeAll(() => {
    const app = HttpRouter.toWebHandler(buildLazyHealLayer());
    handler = app.handler;
    dispose = app.dispose;
  });

  afterAll(async () => {
    await dispose();
  });

  beforeEach(() => {
    resetStores();
  });

  it('grant to role-less GROUP_D: DB grant written, channel_created emitted, grantedBatch NOT emitted, 200', async () => {
    // GROUP_D has no role in groupRoleMap → will trigger lazy heal
    const response = await handler(setAccessRequest([{ groupId: GROUP_D, accessLevel: 'VIEW' }]));

    expect(response.status).toBe(200);

    // The DB grant must be written (existing behaviour preserved)
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_D, level: 'VIEW' });

    // hasUnprocessedForGroups MUST have been called with GROUP_D on the lazy-heal path.
    // This makes the negative assertion below meaningful (proves the guard was exercised).
    expect(hasUnprocessedForGroupsCalls.length).toBeGreaterThanOrEqual(1);
    const calledWithGroupD = hasUnprocessedForGroupsCalls.some((ids) => ids.includes(GROUP_D));
    expect(calledWithGroupD).toBe(true);

    // Provisioning must have been enqueued for GROUP_D
    expect(channelCreatedCalls).toHaveLength(1);
    expect(channelCreatedCalls[0]?.groupId).toBe(GROUP_D);

    // managed_access_granted must NOT be emitted in the same request
    // (async: will come after bot processes channel_created)
    expect(grantedBatchCalls).toHaveLength(0);
  });

  it('grant to role-less GROUP_D that ALREADY has an in-flight channel_created → NO duplicate event, still 200', async () => {
    const appWithInFlight = HttpRouter.toWebHandler(
      buildLazyHealLayer([GROUP_D]), // GROUP_D already in-flight
    );
    const customHandler: (...args: any) => Promise<Response> = appWithInFlight.handler;

    try {
      const response = await customHandler(
        setAccessRequest([{ groupId: GROUP_D, accessLevel: 'VIEW' }]),
      );

      expect(response.status).toBe(200);

      // Grant still written
      expect(upsertCalls).toHaveLength(1);

      // hasUnprocessedForGroups was called with GROUP_D (proves the guard ran, not that feature is absent)
      expect(hasUnprocessedForGroupsCalls.length).toBeGreaterThanOrEqual(1);
      const calledWithGroupD = hasUnprocessedForGroupsCalls.some((ids) => ids.includes(GROUP_D));
      expect(calledWithGroupD).toBe(true);

      // NO new channel_created because GROUP_D already has one in-flight
      expect(channelCreatedCalls).toHaveLength(0);

      // Still no managed_access_granted
      expect(grantedBatchCalls).toHaveLength(0);
    } finally {
      await appWithInFlight.dispose();
    }
  });

  // -------------------------------------------------------------------------
  // NEW: channel-exists (partial provisioning) lazy-heal branch
  // -------------------------------------------------------------------------

  it('grant to role-less GROUP_D that already has a discord_channel_id → channel_created emitted with existingChannelId=Some AND no new channel name (LINK branch), 200', async () => {
    // This is the duplicate-channel prevention regression test for the lazy-heal path.
    // When setAccess triggers the lazy heal for a group that already has a channel
    // (discord_channel_id is Some), the emitted channel_created event must carry:
    //   existingChannelId = Some(<that channel id>)   — routes to LINK branch in the bot
    //   discordChannelName = undefined                — no new channel would be created
    // A wrong implementation would emit existingChannelId=None + discordChannelName=some-name,
    // causing the bot to create a SECOND Discord channel for the group.
    const EXISTING_GROUP_DISCORD_CHANNEL = '777777777777777777' as Discord.Snowflake;

    // Override the mutable spy for this test: GROUP_D has a channel already
    findGroupsMissingRoleResult = [
      {
        group_id: GROUP_D,
        team_id: TEST_TEAM_ID,
        name: 'Visitors',
        emoji: Option.none<string>(),
        color: Option.none<string>(),
        discord_channel_id: Option.some(EXISTING_GROUP_DISCORD_CHANNEL),
      },
    ];

    const response = await handler(setAccessRequest([{ groupId: GROUP_D, accessLevel: 'VIEW' }]));

    expect(response.status).toBe(200);

    // DB grant still written
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]).toMatchObject({ groupId: GROUP_D, level: 'VIEW' });

    // Provisioning enqueued for GROUP_D
    expect(channelCreatedCalls).toHaveLength(1);
    const call = channelCreatedCalls[0]!;
    expect(call.groupId).toBe(GROUP_D);

    // LINK branch: existingChannelId must be Some(<the existing channel id>)
    expect(Option.isSome(call.existingChannelId)).toBe(true);
    expect(Option.getOrNull(call.existingChannelId)).toBe(EXISTING_GROUP_DISCORD_CHANNEL);

    // LINK branch: no new channel name — would cause a duplicate Discord channel if set
    expect(call.discordChannelName).toBeUndefined();

    // No managed_access_granted in the same request (async path)
    expect(grantedBatchCalls).toHaveLength(0);
  });
});
