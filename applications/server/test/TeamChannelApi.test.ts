/**
 * HTTP handler tests for the ChannelApi endpoints defined in
 * `applications/server/src/api/channel.ts`.
 *
 * Covers: listChannels, createChannel, archiveChannel, renameChannel, updateOrganization.
 * Uses the same mock-layer cascade as existing API handler tests.
 */

import type { Auth, Discord, Role, Team, TeamChannel, TeamMember } from '@sideline/domain';
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
import {
  ChannelNameAlreadyTakenError,
  DiscordChannelAlreadyAdoptedError,
  TeamChannelsRepository,
} from '~/repositories/TeamChannelsRepository.js';
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
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0005-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0005-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0005-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0005-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0005-000000000021' as TeamMember.TeamMemberId;
const TEST_CHANNEL_ID = '00000000-0000-0000-0005-000000000030' as TeamChannel.TeamChannelId;
const TEST_GUILD_ID = '888888888888888888' as Discord.Snowflake;
const ARCHIVE_CATEGORY_ID = '777777777777777777' as Discord.Snowflake;
const DISCORD_TEXT_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const DISCORD_VOICE_CHANNEL_ID = '222222222222222222' as Discord.Snowflake;
const DISCORD_CATEGORY_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;

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
// User + session fixtures
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
  guild_id: TEST_GUILD_ID,
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
// Spy on managed channel sync events
// ---------------------------------------------------------------------------

type ManagedSyncCall =
  | {
      type: 'channel_created';
      teamChannelId: TeamChannel.TeamChannelId;
      discordChannelName: string;
    }
  | { type: 'channel_archived'; teamChannelId: TeamChannel.TeamChannelId }
  | { type: 'channel_deleted'; teamChannelId: TeamChannel.TeamChannelId }
  | {
      type: 'discord_channel_archived';
      discordChannelId: Discord.Snowflake;
      archiveCategoryId: Discord.Snowflake;
    }
  | {
      type: 'channel_adopted';
      teamChannelId: TeamChannel.TeamChannelId;
      discordChannelId: Discord.Snowflake;
    }
  | { type: 'access_granted' }
  | { type: 'access_revoked' };

const managedSyncCalls: ManagedSyncCall[] = [];

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
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
  emitManagedChannelCreated: (args: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelName: string;
  }) => {
    managedSyncCalls.push({
      type: 'channel_created',
      teamChannelId: args.teamChannelId,
      discordChannelName: args.discordChannelName,
    });
    return Effect.void;
  },
  emitManagedChannelArchived: (args: { teamChannelId: TeamChannel.TeamChannelId }) => {
    managedSyncCalls.push({ type: 'channel_archived', teamChannelId: args.teamChannelId });
    return Effect.void;
  },
  emitManagedChannelDeleted: (args: { teamChannelId: TeamChannel.TeamChannelId }) => {
    managedSyncCalls.push({ type: 'channel_deleted', teamChannelId: args.teamChannelId });
    return Effect.void;
  },
  emitManagedAccessGrantedBatch: () => {
    managedSyncCalls.push({ type: 'access_granted' });
    return Effect.void;
  },
  emitManagedAccessRevokedBatch: () => {
    managedSyncCalls.push({ type: 'access_revoked' });
    return Effect.void;
  },
  emitDiscordChannelArchived: (args: {
    teamId: Team.TeamId;
    discordChannelId: Discord.Snowflake;
    archiveCategoryId: Discord.Snowflake;
  }) => {
    managedSyncCalls.push({
      type: 'discord_channel_archived',
      discordChannelId: args.discordChannelId,
      archiveCategoryId: args.archiveCategoryId,
    });
    return Effect.void;
  },
  emitManagedChannelAdopted: (args: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Discord.Snowflake;
  }) => {
    managedSyncCalls.push({
      type: 'channel_adopted',
      teamChannelId: args.teamChannelId,
      discordChannelId: args.discordChannelId,
    });
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
// In-memory channels / access stores
// ---------------------------------------------------------------------------

let nextChannelId = 1;
const channelsStore = new Map<
  TeamChannel.TeamChannelId,
  {
    id: TeamChannel.TeamChannelId;
    team_id: Team.TeamId;
    name: string;
    category: Option.Option<string>;
    position: number;
    archived: boolean;
    discord_channel_id: Option.Option<Discord.Snowflake>;
    discord_role_id: Option.Option<Discord.Snowflake>;
  }
>();
const accessStore = new Map<string, { group_id: string; access_level: string }[]>();

const resetChannelStores = () => {
  channelsStore.clear();
  accessStore.clear();
  nextChannelId = 1;
};

const MockTeamChannelsRepositoryLayer = Layer.succeed(TeamChannelsRepository, {
  _tag: 'api/TeamChannelsRepository',
  findById: (channelId: TeamChannel.TeamChannelId) => {
    const ch = channelsStore.get(channelId);
    return Effect.succeed(ch ? Option.some(ch) : Option.none());
  },
  findAllByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(Array.from(channelsStore.values()).filter((c) => c.team_id === teamId)),
  insert: (teamId: Team.TeamId, name: string, _category: Option.Option<string>) => {
    const id =
      `00000000-0000-0000-0005-${String(nextChannelId++).padStart(12, '0')}` as TeamChannel.TeamChannelId;
    const ch = {
      id,
      team_id: teamId,
      name,
      category: _category,
      position: 0,
      archived: false,
      discord_channel_id: Option.none<Discord.Snowflake>(),
      discord_role_id: Option.none<Discord.Snowflake>(),
    };
    channelsStore.set(id, ch);
    return Effect.succeed(ch);
  },
  insertAdopted: (
    teamId: Team.TeamId,
    name: string,
    _category: Option.Option<string>,
    discordChannelId: Discord.Snowflake,
  ) => {
    // Check for name conflict (simulates uq_team_channels_team_name_active violation)
    const existingByName = Array.from(channelsStore.values()).find(
      (c) => c.team_id === teamId && c.name === name && !c.archived,
    );
    if (existingByName) {
      return Effect.fail(new ChannelNameAlreadyTakenError());
    }
    // Check for discord channel id conflict (simulates uq_team_channels_discord_channel violation)
    const existingByDiscord = Array.from(channelsStore.values()).find((c) =>
      Option.match(c.discord_channel_id, {
        onNone: () => false,
        onSome: (id) => id === discordChannelId,
      }),
    );
    if (existingByDiscord) {
      return Effect.fail(new DiscordChannelAlreadyAdoptedError());
    }
    const id =
      `00000000-0000-0000-0005-${String(nextChannelId++).padStart(12, '0')}` as TeamChannel.TeamChannelId;
    const ch = {
      id,
      team_id: teamId,
      name,
      category: _category,
      position: 0,
      archived: false,
      discord_channel_id: Option.some(discordChannelId),
      discord_role_id: Option.none<Discord.Snowflake>(),
    };
    channelsStore.set(id, ch);
    return Effect.succeed(ch);
  },
  rename: (channelId: TeamChannel.TeamChannelId, name: string) => {
    const ch = channelsStore.get(channelId);
    if (!ch) return Effect.die(new Error(`Channel ${channelId} not found`));
    const updated = { ...ch, name };
    channelsStore.set(channelId, updated);
    return Effect.succeed(updated);
  },
  updateOrganization: (
    channelId: TeamChannel.TeamChannelId,
    category: Option.Option<string>,
    position: number,
  ) => {
    const ch = channelsStore.get(channelId);
    if (!ch) return Effect.die(new Error(`Channel ${channelId} not found`));
    const updated = { ...ch, category, position };
    channelsStore.set(channelId, updated);
    return Effect.succeed(updated);
  },
  setArchived: (channelId: TeamChannel.TeamChannelId, archived: boolean) => {
    const ch = channelsStore.get(channelId);
    if (ch) channelsStore.set(channelId, { ...ch, archived });
    return Effect.void;
  },
  delete: (channelId: TeamChannel.TeamChannelId) => {
    channelsStore.delete(channelId);
    return Effect.void;
  },
  upsertDiscordChannelId: () => Effect.void,
  clearDiscordChannelId: (channelId: TeamChannel.TeamChannelId) => {
    const ch = channelsStore.get(channelId);
    if (ch) channelsStore.set(channelId, { ...ch, discord_channel_id: Option.none() });
    return Effect.void;
  },
} as never);

const MockTeamChannelAccessRepositoryLayer = Layer.succeed(TeamChannelAccessRepository, {
  _tag: 'api/TeamChannelAccessRepository',
  findByChannel: (channelId: TeamChannel.TeamChannelId) =>
    Effect.succeed(accessStore.get(channelId) ?? []),
  findByChannelForUpdate: (channelId: TeamChannel.TeamChannelId) =>
    Effect.succeed(accessStore.get(channelId) ?? []),
  upsertGrant: (channelId: TeamChannel.TeamChannelId, groupId: string, level: string) => {
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
  deleteGrant: (channelId: TeamChannel.TeamChannelId, groupId: string) => {
    const current = accessStore.get(channelId) ?? [];
    accessStore.set(
      channelId,
      current.filter((e) => e.group_id !== groupId),
    );
    return Effect.void;
  },
  countByChannel: (channelId: TeamChannel.TeamChannelId) =>
    Effect.succeed((accessStore.get(channelId) ?? []).length),
  findGroupRoleIds: () => Effect.succeed([]),
} as never);

// ---------------------------------------------------------------------------
// Standard mock cascade (copied from ChannelSync.test.ts pattern)
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
  findById: (id: Auth.UserId) => Effect.succeed(Option.fromNullishOr(usersMap.get(id))),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
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
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) => {
    if (id === TEST_TEAM_ID) return Effect.succeed(Option.some(testTeam));
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.succeed(testTeam),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
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
} as any);

const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(true), // guild IS linked by default
  findAll: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () =>
    Effect.succeed(
      Option.some({
        team_id: TEST_TEAM_ID,
        event_horizon_days: 30,
        discord_archive_category_id: Option.some('777777777777777777' as Discord.Snowflake),
      }),
    ),
  upsertSettings: () => Effect.void,
  upsert: () => Effect.void,
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

// SqlClient mock — needed for archiveChannel which uses sql.withTransaction
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

const buildLayer = (overrides?: {
  botGuildsLayer?: Layer.Layer<BotGuildsRepository>;
  channelSyncLayer?: Layer.Layer<ChannelSyncEventsRepository>;
  teamSettingsLayer?: Layer.Layer<TeamSettingsRepository>;
  channelsLayer?: Layer.Layer<TeamChannelsRepository>;
  discordChannelsLayer?: Layer.Layer<DiscordChannelsRepository>;
}) =>
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
          Layer.succeed(LeaderboardRepository, {
            getLeaderboard: () => Effect.succeed([]),
          } as any),
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
        overrides?.channelSyncLayer ?? MockChannelSyncEventsRepositoryLayer,
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
                overrides?.botGuildsLayer ?? MockBotGuildsRepositoryLayer,
              ),
              Layer.merge(
                overrides?.discordChannelsLayer ??
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
          overrides?.teamSettingsLayer ?? MockTeamSettingsRepositoryLayer,
        ),
        Layer.succeed(OAuthConnectionsRepository, {
          upsert: () => Effect.die(new Error('Not implemented')),
          findByUserAndProvider: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed(Option.none()),
          findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
          getAccessToken: () => Effect.succeed('mock-access-token'),
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
    .pipe(Layer.provide(overrides?.channelsLayer ?? MockTeamChannelsRepositoryLayer))
    .pipe(Layer.provide(MockTeamChannelAccessRepositoryLayer))
    .pipe(Layer.provide(MockSqlClientLayer))
    .pipe(Layer.provide(BotInfoStore.Default));

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(buildLayer());
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetChannelStores();
  managedSyncCalls.length = 0;
});

// ---------------------------------------------------------------------------
// listChannels
// ---------------------------------------------------------------------------

describe('listChannels', () => {
  it('returns canManage=true and guildLinked=true for admin', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canManage).toBe(true);
    expect(body.guildLinked).toBe(true);
    expect(Array.isArray(body.channels)).toBe(true);
  });

  it('returns canManage=false for member without group:manage', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.canManage).toBe(false);
  });

  it('includes accessCount per channel', async () => {
    // Pre-seed a channel
    const id = '00000000-0000-0000-0005-seed000000001' as TeamChannel.TeamChannelId;
    channelsStore.set(id, {
      id,
      team_id: TEST_TEAM_ID,
      name: 'announcements',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });
    accessStore.set(id, [
      { group_id: 'g1', access_level: 'VIEW' },
      { group_id: 'g2', access_level: 'EDIT' },
    ]);

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    // Channels are now sourced from discord_channels (merged with team_channels).
    // Since no discord rows are returned in this test, the managed channel appears via the merge.
    // The new shape uses teamChannelId (Option) instead of the old channelId field.
    const ch = body.channels.find((c: any) => c.teamChannelId === id);
    expect(ch).toBeDefined();
    expect(ch.accessCount).toBe(2);
  });

  it('returns 401 or 403 for unauthenticated request', async () => {
    const response = await handler(new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`));
    // Unauthenticated requests get a 401 from AuthMiddleware
    expect([401, 403]).toContain(response.status);
  });
});

// ---------------------------------------------------------------------------
// createChannel
// ---------------------------------------------------------------------------

describe('createChannel', () => {
  it('creates channel and returns 201 with channel detail', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'announcements', category: null }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.name).toBe('announcements');
    // New shape: teamChannelId (Option) replaces the old channelId field
    expect(body.teamChannelId).toBeDefined();
  });

  it('emits managed_channel_created sync event after insert', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ name: 'general', category: null }),
      }),
    );

    expect(response.status).toBe(201);
    const created = managedSyncCalls.filter((c) => c.type === 'channel_created');
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ type: 'channel_created', discordChannelName: 'general' });
  });

  it('returns 409 when channel name already taken', async () => {
    // First create succeeds
    await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'duplicate', category: null }),
      }),
    );

    // Simulate unique violation by using the mock that throws ChannelNameAlreadyTakenError
    // We need a separate layer for this; we test the mock response shape instead
    // The real uniqueness is tested via integration tests. Here we verify the 409 status
    // by using a mock layer that returns the error.
    const dupChannelSyncLayer = Layer.succeed(ChannelSyncEventsRepository, {
      ...({} as any),
      emitManagedChannelCreated: () => Effect.void,
      findUnprocessed: () => Effect.succeed([]),
      markProcessed: () => Effect.void,
      markFailed: () => Effect.void,
      markPermanentlyFailed: () => Effect.void,
      hasUnprocessedForGroups: () => Effect.succeed([]),
      hasUnprocessedForRosters: () => Effect.succeed([]),
    } as any);

    // Test that the error class maps to 409 by checking the API definition
    // ChannelNameAlreadyTaken is defined with status(409) in ChannelApi
    // We verify behavior by manually testing with a mock that throws
    const dupChannelsLayer = Layer.succeed(TeamChannelsRepository, {
      _tag: 'api/TeamChannelsRepository',
      findById: () => Effect.succeed(Option.none()),
      findAllByTeam: () => Effect.succeed([]),
      insert: () => Effect.fail(new ChannelNameAlreadyTakenError()),
      rename: () => Effect.die(new Error('Not implemented')),
      updateOrganization: () => Effect.die(new Error('Not implemented')),
      setArchived: () => Effect.void,
      delete: () => Effect.void,
      upsertDiscordChannelId: () => Effect.void,
      clearDiscordChannelId: () => Effect.void,
    } as never);

    const dupApp = HttpRouter.toWebHandler(
      buildLayer({ channelSyncLayer: dupChannelSyncLayer, channelsLayer: dupChannelsLayer }),
    );
    const dupHandler: (...args: any) => Promise<Response> = dupApp.handler;
    const dupResponse = await dupHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'duplicate', category: null }),
      }),
    );
    await dupApp.dispose();

    expect(dupResponse.status).toBe(409);
  });

  it('returns 403 for member without group:manage', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'general', category: null }),
      }),
    );

    expect(response.status).toBe(403);
    expect(managedSyncCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// archiveChannel
// ---------------------------------------------------------------------------

describe('archiveChannel', () => {
  it('archives channel and emits managed_channel_archived when archive category exists', async () => {
    // Pre-seed a channel with a discord_channel_id
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-channel',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some('555555555555555555' as Discord.Snowflake),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/archive`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );

    expect(response.status).toBe(204);

    // Channel should be archived
    const ch = channelsStore.get(TEST_CHANNEL_ID);
    expect(ch?.archived).toBe(true);

    // FIX 2(a): discord_channel_id must NOT be cleared on archive so the channel
    // de-dups correctly in listChannels (the LEFT JOIN still matches).
    expect(Option.isSome(ch?.discord_channel_id ?? Option.none())).toBe(true);

    // Sync event should be emitted
    const archivedCalls = managedSyncCalls.filter((c) => c.type === 'channel_archived');
    expect(archivedCalls).toHaveLength(1);
  });

  it('archives channel but does NOT emit sync event when no archive category in settings', async () => {
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-channel',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some('555555555555555555' as Discord.Snowflake),
      discord_role_id: Option.none(),
    });

    const noArchiveCategoryLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeam: () => Effect.succeed(Option.none()),
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEST_TEAM_ID,
            event_horizon_days: 30,
            discord_archive_category_id: Option.none(),
          }),
        ),
      upsertSettings: () => Effect.void,
      upsert: () => Effect.void,
      getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
      getHorizonDays: () => Effect.succeed(30),
    } as any);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ teamSettingsLayer: noArchiveCategoryLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/archive`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(204);
    const archivedCalls = managedSyncCalls.filter((c) => c.type === 'channel_archived');
    expect(archivedCalls).toHaveLength(0);
  });

  it('returns 403 for member without group:manage', async () => {
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-channel',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/archive`, {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// renameChannel
// ---------------------------------------------------------------------------

describe('renameChannel', () => {
  it('renames channel and returns updated detail', async () => {
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-name',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/name`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'new-name' }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe('new-name');
  });

  it('does NOT emit any managed sync event (v1 decision)', async () => {
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-name',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/name`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'renamed' }),
      }),
    );

    expect(managedSyncCalls).toHaveLength(0);
  });

  it('returns 403 for member without group:manage', async () => {
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'old-name',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels/${TEST_CHANNEL_ID}/name`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'hacked' }),
      }),
    );

    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// listChannels — Discord merge and archived derivation
// ---------------------------------------------------------------------------

describe('listChannels — Discord merge', () => {
  it('merges discord rows with managed-only rows (no mirror)', async () => {
    // Seed a managed team_channels row without a discord_channel_id (no mirror)
    const managedId = '00000000-0000-0000-0005-managed000001' as TeamChannel.TeamChannelId;
    channelsStore.set(managedId, {
      id: managedId,
      team_id: TEST_TEAM_ID,
      name: 'managed-only',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.none(),
      discord_role_id: Option.none(),
    });
    accessStore.set(managedId, [{ group_id: 'grp1', access_level: 'VIEW' }]);

    // Discord rows: text(0), voice(2), category(4)
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () =>
        Effect.succeed([
          {
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'general',
            type: 0,
            parent_id: Option.none(),
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
          {
            channel_id: DISCORD_VOICE_CHANNEL_ID,
            name: 'voice-chat',
            type: 2,
            parent_id: Option.none(),
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
          {
            channel_id: DISCORD_CATEGORY_CHANNEL_ID,
            name: 'Category A',
            type: 4,
            parent_id: Option.none(),
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
        ]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    // Response includes archiveCategoryId from settings
    expect(body.archiveCategoryId).toBe(ARCHIVE_CATEGORY_ID);
    expect(body.canManage).toBe(true);
    expect(body.guildLinked).toBe(true);

    // Should contain at least 4 channels (3 discord + 1 managed-without-mirror)
    expect(body.channels.length).toBeGreaterThanOrEqual(4);

    // Managed-without-mirror channel should appear with managed=true and discordChannelId=null
    const managedOnly = body.channels.find((c: any) => c.teamChannelId === managedId);
    expect(managedOnly).toBeDefined();
    expect(managedOnly.managed).toBe(true);
    expect(managedOnly.discordChannelId).toBeNull();
    expect(managedOnly.accessCount).toBe(1);

    // Discord text channel present with type passthrough
    const textCh = body.channels.find((c: any) => c.discordChannelId === DISCORD_TEXT_CHANNEL_ID);
    expect(textCh).toBeDefined();
    expect(textCh.type).toBe(0);

    // Discord voice channel present with type=2
    const voiceCh = body.channels.find((c: any) => c.discordChannelId === DISCORD_VOICE_CHANNEL_ID);
    expect(voiceCh).toBeDefined();
    expect(voiceCh.type).toBe(2);

    // Category row present with type=4
    const catCh = body.channels.find(
      (c: any) => c.discordChannelId === DISCORD_CATEGORY_CHANNEL_ID,
    );
    expect(catCh).toBeDefined();
    expect(catCh.type).toBe(4);
  });

  it('derives archived=true for a channel whose parent_id equals archiveCategoryId', async () => {
    // A text channel parented under ARCHIVE_CATEGORY_ID → archived=true
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () =>
        Effect.succeed([
          {
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'archived-chan',
            type: 0,
            parent_id: Option.some(ARCHIVE_CATEGORY_ID),
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
          {
            channel_id: DISCORD_VOICE_CHANNEL_ID,
            name: 'active-chan',
            type: 0,
            parent_id: Option.none(),
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
        ]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    const archivedCh = body.channels.find(
      (c: any) => c.discordChannelId === DISCORD_TEXT_CHANNEL_ID,
    );
    expect(archivedCh).toBeDefined();
    expect(archivedCh.archived).toBe(true);

    const activeCh = body.channels.find(
      (c: any) => c.discordChannelId === DISCORD_VOICE_CHANNEL_ID,
    );
    expect(activeCh).toBeDefined();
    expect(activeCh.archived).toBe(false);
  });

  it('archived=false for all channels when no archive category configured', async () => {
    const noArchiveSettingsLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeam: () => Effect.succeed(Option.none()),
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEST_TEAM_ID,
            event_horizon_days: 30,
            discord_archive_category_id: Option.none(),
          }),
        ),
      upsertSettings: () => Effect.void,
      upsert: () => Effect.void,
      getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
      getHorizonDays: () => Effect.succeed(30),
    } as any);

    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () =>
        Effect.succeed([
          {
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'some-chan',
            type: 0,
            parent_id: Option.some(ARCHIVE_CATEGORY_ID), // would be archived if category configured
            team_channel_id: Option.none(),
            team_channel_archived: Option.none(),
            access_count: 0,
          },
        ]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({
        teamSettingsLayer: noArchiveSettingsLayer,
        discordChannelsLayer: discordLayer,
      }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archiveCategoryId).toBeNull();

    const ch = body.channels.find((c: any) => c.discordChannelId === DISCORD_TEXT_CHANNEL_ID);
    expect(ch).toBeDefined();
    expect(ch.archived).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// archiveDiscordChannel
// ---------------------------------------------------------------------------

describe('archiveDiscordChannel', () => {
  const archiveUrl = `http://localhost/teams/${TEST_TEAM_ID}/discord-channels/${DISCORD_TEXT_CHANNEL_ID}/archive`;

  it('happy path (unmanaged): emits emitDiscordChannelArchived, no managed writes', async () => {
    // Provide a discord channel row for lookup — text, not in archive category
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'general',
            type: 0,
            parent_id: Option.none(),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(204);

    // emitDiscordChannelArchived should have been called
    const discordArchiveCalls = managedSyncCalls.filter(
      (c) => c.type === 'discord_channel_archived',
    ) as Array<{
      type: 'discord_channel_archived';
      discordChannelId: Discord.Snowflake;
      archiveCategoryId: Discord.Snowflake;
    }>;
    expect(discordArchiveCalls).toHaveLength(1);
    expect(discordArchiveCalls[0]?.discordChannelId).toBe(DISCORD_TEXT_CHANNEL_ID);
    expect(discordArchiveCalls[0]?.archiveCategoryId).toBe(ARCHIVE_CATEGORY_ID);

    // No managed archive calls
    const managedArchiveCalls = managedSyncCalls.filter((c) => c.type === 'channel_archived');
    expect(managedArchiveCalls).toHaveLength(0);
  });

  it('managed path: emits emitManagedChannelArchived (not emitDiscordChannelArchived)', async () => {
    // Pre-seed managed team_channels row linked to DISCORD_TEXT_CHANNEL_ID
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'managed-chan',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'managed-chan',
            type: 0,
            parent_id: Option.none(),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(204);

    // emitManagedChannelArchived emitted (managed archive path)
    const managedArchiveCalls = managedSyncCalls.filter((c) => c.type === 'channel_archived');
    expect(managedArchiveCalls).toHaveLength(1);

    // emitDiscordChannelArchived NOT emitted
    const discordArchiveCalls = managedSyncCalls.filter(
      (c) => c.type === 'discord_channel_archived',
    );
    expect(discordArchiveCalls).toHaveLength(0);
  });

  it('no archive category configured → 409 ArchiveCategoryNotConfigured', async () => {
    const noArchiveSettingsLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeam: () => Effect.succeed(Option.none()),
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEST_TEAM_ID,
            event_horizon_days: 30,
            discord_archive_category_id: Option.none(),
          }),
        ),
      upsertSettings: () => Effect.void,
      upsert: () => Effect.void,
      getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
      getHorizonDays: () => Effect.succeed(30),
    } as any);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ teamSettingsLayer: noArchiveSettingsLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('category-type channel (type=4) → 409 ChannelNotArchivable', async () => {
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'some-category',
            type: 4,
            parent_id: Option.none(),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('channel already in archive category → 409 ChannelNotArchivable', async () => {
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'already-archived',
            type: 0,
            // parent_id = archiveCategoryId → already archived
            parent_id: Option.some(ARCHIVE_CATEGORY_ID),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('unknown discord channel → 404 ChannelNotFound', async () => {
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(404);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('non-group:manage member → 403 ChannelForbidden, no emit', async () => {
    const response = await handler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );

    expect(response.status).toBe(403);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('FIX 4: already-archived managed channel → 409 ChannelNotArchivable, no re-emit', async () => {
    // Seed a managed team_channels row that is already archived
    const archivedManagedId = '00000000-0000-0000-0005-archived00001' as TeamChannel.TeamChannelId;
    channelsStore.set(archivedManagedId, {
      id: archivedManagedId,
      team_id: TEST_TEAM_ID,
      name: 'already-archived-managed',
      category: Option.none(),
      position: 0,
      archived: true, // already archived
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    // Discord row for the channel — parent_id is NOT the archive category
    // (mid-sync: Discord hasn't moved it yet, but team_channels.archived=true)
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'already-archived-managed',
            type: 0,
            parent_id: Option.none(), // NOT in archive category yet
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(archiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    // Must be 409 ChannelNotArchivable — not re-archived
    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// listChannels — duplicate de-dup and mid-sync archived source-of-truth
// ---------------------------------------------------------------------------

describe('listChannels — archived managed channel regression', () => {
  it('FIX 2+3: archived managed channel with discord_channel_id still set appears EXACTLY ONCE', async () => {
    // Seed an archived managed team_channels row that still has discord_channel_id set
    // (FIX 2(a): we no longer clear discord_channel_id on archive)
    const archivedManagedId = '00000000-0000-0000-0005-archdup000001' as TeamChannel.TeamChannelId;
    channelsStore.set(archivedManagedId, {
      id: archivedManagedId,
      team_id: TEST_TEAM_ID,
      name: 'archived-managed',
      category: Option.none(),
      position: 0,
      archived: true,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    // Discord row for the same channel; parent_id = archiveCategoryId (already moved)
    // The LEFT JOIN in findManagedListByTeam will match tc row → team_channel_id is set.
    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () =>
        Effect.succeed([
          {
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'archived-managed',
            type: 0,
            parent_id: Option.some(ARCHIVE_CATEGORY_ID),
            team_channel_id: Option.some(archivedManagedId),
            team_channel_archived: Option.some(true),
            access_count: 0,
          },
        ]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    // The channel must appear EXACTLY ONCE
    const matches = body.channels.filter(
      (c: any) =>
        c.discordChannelId === DISCORD_TEXT_CHANNEL_ID || c.teamChannelId === archivedManagedId,
    );
    expect(matches).toHaveLength(1);

    // It must be managed=true and archived=true
    expect(matches[0].managed).toBe(true);
    expect(matches[0].archived).toBe(true);
  });

  it('FIX 2(b): managed channel with team_channel_archived=true but discord parent_id != archiveCategoryId still reports archived=true (mid-sync)', async () => {
    // Mid-sync: team_channels.archived=true but Discord hasn't moved the channel yet
    const managedId = '00000000-0000-0000-0005-midsync00001' as TeamChannel.TeamChannelId;
    channelsStore.set(managedId, {
      id: managedId,
      team_id: TEST_TEAM_ID,
      name: 'mid-sync-channel',
      category: Option.none(),
      position: 0,
      archived: true,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    const discordLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () =>
        Effect.succeed([
          {
            channel_id: DISCORD_TEXT_CHANNEL_ID,
            name: 'mid-sync-channel',
            type: 0,
            parent_id: Option.none(), // NOT in archive category yet (mid-sync)
            team_channel_id: Option.some(managedId),
            team_channel_archived: Option.some(true), // team_channels.archived=true
            access_count: 0,
          },
        ]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/channels`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    const ch = body.channels.find((c: any) => c.discordChannelId === DISCORD_TEXT_CHANNEL_ID);
    expect(ch).toBeDefined();
    // Must be archived even though parent_id != archiveCategoryId
    expect(ch.archived).toBe(true);
    expect(ch.managed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// adoptDiscordChannel
// ---------------------------------------------------------------------------

describe('adoptDiscordChannel', () => {
  const adoptUrl = (discordId: string) =>
    `http://localhost/teams/${TEST_TEAM_ID}/discord-channels/${discordId}/adopt`;

  const textChannelDiscordLayer = Layer.succeed(DiscordChannelsRepository, {
    syncChannels: () => Effect.void,
    findByGuildId: () => Effect.succeed([]),
    findManagedListByTeam: () => Effect.succeed([]),
    findByChannelId: (_guildId: Discord.Snowflake, channelId: Discord.Snowflake) =>
      Effect.succeed(
        channelId === DISCORD_TEXT_CHANNEL_ID
          ? Option.some({
              channel_id: DISCORD_TEXT_CHANNEL_ID,
              name: 'general',
              type: 0,
              parent_id: Option.none<Discord.Snowflake>(),
            })
          : Option.none(),
      ),
  } as any);

  it('adopt text channel (type 0) → 200 ChannelDetail managed=true, emits channel_adopted event', async () => {
    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: textChannelDiscordLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.managed).toBe(true);
    // teamChannelId should be set (Some)
    expect(body.teamChannelId).not.toBeNull();
    // grants should be empty array
    expect(body.grants).toEqual([]);

    // Exactly one channel_adopted event emitted
    const adoptedCalls = managedSyncCalls.filter((c) => c.type === 'channel_adopted');
    expect(adoptedCalls).toHaveLength(1);
    expect((adoptedCalls[0] as any).discordChannelId).toBe(DISCORD_TEXT_CHANNEL_ID);

    // NO managed_channel_created event, no access events
    const createdCalls = managedSyncCalls.filter((c) => c.type === 'channel_created');
    expect(createdCalls).toHaveLength(0);
    const accessCalls = managedSyncCalls.filter(
      (c) => c.type === 'access_granted' || c.type === 'access_revoked',
    );
    expect(accessCalls).toHaveLength(0);
  });

  it('adopt type 2 (voice) → 409 ChannelNotAdoptable', async () => {
    const voiceLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_VOICE_CHANNEL_ID,
            name: 'voice-chat',
            type: 2,
            parent_id: Option.none<Discord.Snowflake>(),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: voiceLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_VOICE_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('adopt type 4 (category) → 409 ChannelNotAdoptable', async () => {
    const categoryLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () =>
        Effect.succeed(
          Option.some({
            channel_id: DISCORD_CATEGORY_CHANNEL_ID,
            name: 'Some Category',
            type: 4,
            parent_id: Option.none<Discord.Snowflake>(),
          }),
        ),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: categoryLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_CATEGORY_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('adopt unknown discord channel → 404 ChannelNotFound', async () => {
    const notFoundLayer = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: () => Effect.succeed(Option.none()),
    } as any);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: notFoundLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(404);
  });

  it('adopt without group:manage → 403 ChannelForbidden', async () => {
    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: textChannelDiscordLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(403);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('idempotent re-adopt: already adopted → 200 same detail, NO new adopted event', async () => {
    // Pre-seed a managed channel already linked to DISCORD_TEXT_CHANNEL_ID
    const existingId = '00000000-0000-0000-0005-adopt000000001' as TeamChannel.TeamChannelId;
    channelsStore.set(existingId, {
      id: existingId,
      team_id: TEST_TEAM_ID,
      name: 'general',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: textChannelDiscordLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    // Should return the existing channel id
    expect(body.teamChannelId).toBe(existingId);

    // NO new adopted event emitted (idempotent)
    const adoptedCalls = managedSyncCalls.filter((c) => c.type === 'channel_adopted');
    expect(adoptedCalls).toHaveLength(0);
  });

  it('category resolution: parent_id resolves to category name from type=4 parent', async () => {
    const PARENT_ID = '444444444444444444' as Discord.Snowflake;
    const discordLayerWithParent = Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: (_guildId: Discord.Snowflake, channelId: Discord.Snowflake) => {
        if (channelId === DISCORD_TEXT_CHANNEL_ID) {
          return Effect.succeed(
            Option.some({
              channel_id: DISCORD_TEXT_CHANNEL_ID,
              name: 'text-with-parent',
              type: 0,
              parent_id: Option.some(PARENT_ID),
            }),
          );
        }
        if (channelId === PARENT_ID) {
          return Effect.succeed(
            Option.some({
              channel_id: PARENT_ID,
              name: 'My Category',
              type: 4,
              parent_id: Option.none<Discord.Snowflake>(),
            }),
          );
        }
        return Effect.succeed(Option.none());
      },
    } as any);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: discordLayerWithParent }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.category).toBe('My Category');
  });

  it('category resolution: missing parent_id → category None (null in JSON)', async () => {
    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: textChannelDiscordLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.category).toBeNull();
  });

  it('name conflict (active managed row with same name) → 409 ChannelAdoptionNameConflict', async () => {
    // Pre-seed a managed channel with name 'general' (same as what we try to adopt)
    const conflictingId = '00000000-0000-0000-0005-nameconflict1' as TeamChannel.TeamChannelId;
    channelsStore.set(conflictingId, {
      id: conflictingId,
      team_id: TEST_TEAM_ID,
      name: 'general', // same name as DISCORD_TEXT_CHANNEL_ID's name
      category: Option.none(),
      position: 0,
      archived: false,
      // Different discord_channel_id — so idempotency check won't short-circuit
      discord_channel_id: Option.some('555555555555555555' as Discord.Snowflake),
      discord_role_id: Option.none(),
    });

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ discordChannelsLayer: textChannelDiscordLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('concurrent DiscordChannelAlreadyAdoptedError (catch path) → re-fetches and returns existing detail, 0 adopted events', async () => {
    // Genuine concurrent-catch path test:
    //   - findAllByTeam returns [] on the first call (pre-check sees nothing → proceeds to insert)
    //   - insertAdopted fails with DiscordChannelAlreadyAdoptedError (another request won the race)
    //   - findAllByTeam returns the existing row on the second call (post-catch re-fetch)
    //   - Assert: 200, existing channel detail returned, NO adopted event emitted
    const raceId = '00000000-0000-0000-0005-concurrent001' as TeamChannel.TeamChannelId;
    const existingRow = {
      id: raceId,
      team_id: TEST_TEAM_ID,
      name: 'general',
      category: Option.none<string>(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none<Discord.Snowflake>(),
    };

    // Build a channels layer that simulates the race:
    //   - first findAllByTeam call: [] (pre-check finds nothing, proceeds to insert)
    //   - insertAdopted: always fails with DiscordChannelAlreadyAdoptedError
    //   - second findAllByTeam call: returns the existing row (post-catch re-fetch)
    let findAllByTeamCallCount = 0;
    const concurrentChannelsLayer = Layer.succeed(TeamChannelsRepository, {
      _tag: 'api/TeamChannelsRepository',
      findById: (channelId: TeamChannel.TeamChannelId) => {
        const ch = channelsStore.get(channelId);
        return Effect.succeed(ch ? Option.some(ch) : Option.none());
      },
      findAllByTeam: (_teamId: Team.TeamId) => {
        findAllByTeamCallCount++;
        if (findAllByTeamCallCount === 1) {
          // Pre-check call: return empty so the handler proceeds to insertAdopted
          return Effect.succeed([]);
        }
        // Post-catch re-fetch call: return the "already adopted" row
        return Effect.succeed([existingRow]);
      },
      insert: () => Effect.die(new Error('Not implemented')),
      insertAdopted: () => Effect.fail(new DiscordChannelAlreadyAdoptedError()),
      rename: () => Effect.die(new Error('Not implemented')),
      updateOrganization: () => Effect.die(new Error('Not implemented')),
      setArchived: () => Effect.void,
      delete: () => Effect.void,
      upsertDiscordChannelId: () => Effect.void,
      clearDiscordChannelId: () => Effect.void,
    } as never);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({
        discordChannelsLayer: textChannelDiscordLayer,
        channelsLayer: concurrentChannelsLayer,
      }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(adoptUrl(DISCORD_TEXT_CHANNEL_ID), {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    await customApp.dispose();

    // Handler re-fetches and returns 200 (not an error)
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.teamChannelId).toBe(raceId);

    // FIX 1: NO adopted event emitted on the concurrent-catch path
    const adoptedCalls = managedSyncCalls.filter((c) => c.type === 'channel_adopted');
    expect(adoptedCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// bulkArchiveDiscordChannels
// ---------------------------------------------------------------------------

describe('bulkArchiveDiscordChannels', () => {
  const bulkArchiveUrl = `http://localhost/teams/${TEST_TEAM_ID}/discord-channels/bulk-archive`;

  // Helper to build a per-test Discord layer that returns different results per channelId
  const makeDiscordLayer = (
    channels: Array<{
      channel_id: Discord.Snowflake;
      name: string;
      type: number;
      parent_id: Option.Option<Discord.Snowflake>;
    }>,
  ) => {
    const byId = new Map(channels.map((c) => [c.channel_id, c]));
    return Layer.succeed(DiscordChannelsRepository, {
      syncChannels: () => Effect.void,
      findByGuildId: () => Effect.succeed([]),
      findManagedListByTeam: () => Effect.succeed([]),
      findByChannelId: (_guildId: Discord.Snowflake, channelId: Discord.Snowflake) =>
        Effect.succeed(Option.fromNullishOr(byId.get(channelId))),
    } as any);
  };

  it('without group:manage → 403 ChannelForbidden', async () => {
    const response = await handler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordChannelIds: [DISCORD_TEXT_CHANNEL_ID] }),
      }),
    );

    expect(response.status).toBe(403);
  });

  it('no archive category configured → 409 ArchiveCategoryNotConfigured, nothing archived', async () => {
    const noArchiveSettingsLayer = Layer.succeed(TeamSettingsRepository, {
      findByTeam: () => Effect.succeed(Option.none()),
      findByTeamId: () =>
        Effect.succeed(
          Option.some({
            team_id: TEST_TEAM_ID,
            event_horizon_days: 30,
            discord_archive_category_id: Option.none(),
          }),
        ),
      upsertSettings: () => Effect.void,
      upsert: () => Effect.void,
      getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
      getHorizonDays: () => Effect.succeed(30),
    } as any);

    const customApp = HttpRouter.toWebHandler(
      buildLayer({ teamSettingsLayer: noArchiveSettingsLayer }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordChannelIds: [DISCORD_TEXT_CHANNEL_ID] }),
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(409);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('empty discordChannelIds → {archived:[], skipped:[], failed:[]}', async () => {
    const response = await handler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordChannelIds: [] }),
      }),
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toEqual([]);
    expect(body.skipped).toEqual([]);
    expect(body.failed).toEqual([]);
  });

  it('mixed batch: archived valid text, skipped not_found / is_category / is_archive_category / already_archived', async () => {
    const ALREADY_ARCHIVED_ID = '666666666666666666' as Discord.Snowflake;
    const NOT_FOUND_ID = '123456789012345678' as Discord.Snowflake;

    // is_archive_category: a text channel whose id coincidentally equals the archiveCategoryId
    // (the impl checks channel_id === archiveCategoryId before checking parent_id,
    // but AFTER checking type !== 4 — so give this "channel" type 0)
    const discordLayer = makeDiscordLayer([
      // valid text channel → should be archived
      { channel_id: DISCORD_TEXT_CHANNEL_ID, name: 'general', type: 0, parent_id: Option.none() },
      // category channel → is_category
      {
        channel_id: DISCORD_CATEGORY_CHANNEL_ID,
        name: 'Category',
        type: 4,
        parent_id: Option.none(),
      },
      // A type=0 channel whose id equals archiveCategoryId → is_archive_category
      // (In practice the real archive category is type=4 and would hit is_category first;
      // we exercise the is_archive_category branch by giving it type 0.)
      {
        channel_id: ARCHIVE_CATEGORY_ID,
        name: 'archive-sentinel',
        type: 0,
        parent_id: Option.none(),
      },
      // already under archive category → already_archived
      {
        channel_id: ALREADY_ARCHIVED_ID,
        name: 'archived-chan',
        type: 0,
        parent_id: Option.some(ARCHIVE_CATEGORY_ID),
      },
      // NOT_FOUND_ID not in the list → returns none
    ]);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discordChannelIds: [
            DISCORD_TEXT_CHANNEL_ID,
            DISCORD_CATEGORY_CHANNEL_ID,
            ARCHIVE_CATEGORY_ID,
            ALREADY_ARCHIVED_ID,
            NOT_FOUND_ID,
          ],
        }),
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    // Valid text channel archived
    expect(body.archived).toContain(DISCORD_TEXT_CHANNEL_ID);
    expect(body.archived).toHaveLength(1);

    // failed should be empty
    expect(body.failed).toHaveLength(0);

    // Skipped entries
    const reasons = new Map(body.skipped.map((s: any) => [s.discordChannelId, s.reason]));
    expect(reasons.get(NOT_FOUND_ID)).toBe('not_found');
    expect(reasons.get(DISCORD_CATEGORY_CHANNEL_ID)).toBe('is_category');
    expect(reasons.get(ARCHIVE_CATEGORY_ID)).toBe('is_archive_category');
    expect(reasons.get(ALREADY_ARCHIVED_ID)).toBe('already_archived');
    expect(body.skipped).toHaveLength(4);
  });

  it('managed channel in batch (active) → managed archive path emits channel_archived', async () => {
    // Pre-seed a managed team_channels row linked to DISCORD_TEXT_CHANNEL_ID
    channelsStore.set(TEST_CHANNEL_ID, {
      id: TEST_CHANNEL_ID,
      team_id: TEST_TEAM_ID,
      name: 'managed-chan',
      category: Option.none(),
      position: 0,
      archived: false,
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    const discordLayer = makeDiscordLayer([
      {
        channel_id: DISCORD_TEXT_CHANNEL_ID,
        name: 'managed-chan',
        type: 0,
        parent_id: Option.none(),
      },
    ]);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordChannelIds: [DISCORD_TEXT_CHANNEL_ID] }),
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toContain(DISCORD_TEXT_CHANNEL_ID);
    expect(body.failed).toHaveLength(0);

    // emitManagedChannelArchived should have been called (not discord archived)
    const managedArchiveCalls = managedSyncCalls.filter((c) => c.type === 'channel_archived');
    expect(managedArchiveCalls).toHaveLength(1);
    const discordArchiveCalls = managedSyncCalls.filter(
      (c) => c.type === 'discord_channel_archived',
    );
    expect(discordArchiveCalls).toHaveLength(0);
  });

  it('already-archived managed channel in batch → skipped already_archived', async () => {
    // Pre-seed an already-archived managed channel
    const archivedId = '00000000-0000-0000-0005-bulkarch00001' as TeamChannel.TeamChannelId;
    channelsStore.set(archivedId, {
      id: archivedId,
      team_id: TEST_TEAM_ID,
      name: 'already-managed-archived',
      category: Option.none(),
      position: 0,
      archived: true, // already archived
      discord_channel_id: Option.some(DISCORD_TEXT_CHANNEL_ID),
      discord_role_id: Option.none(),
    });

    const discordLayer = makeDiscordLayer([
      {
        channel_id: DISCORD_TEXT_CHANNEL_ID,
        name: 'already-managed-archived',
        type: 0,
        parent_id: Option.none(),
      },
    ]);

    const customApp = HttpRouter.toWebHandler(buildLayer({ discordChannelsLayer: discordLayer }));
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ discordChannelIds: [DISCORD_TEXT_CHANNEL_ID] }),
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.archived).toHaveLength(0);
    expect(body.skipped).toHaveLength(1);
    expect(body.skipped[0].reason).toBe('already_archived');
    expect(body.failed).toHaveLength(0);
    expect(managedSyncCalls).toHaveLength(0);
  });

  it('genuine emit failure for one id → that id in failed, others still processed', async () => {
    // Two channels: TEXT_CHANNEL succeeds, VOICE_CHANNEL triggers a sync failure
    const FAIL_CHANNEL_ID = DISCORD_VOICE_CHANNEL_ID;

    const discordLayer = makeDiscordLayer([
      {
        channel_id: DISCORD_TEXT_CHANNEL_ID,
        name: 'good-chan',
        type: 0,
        parent_id: Option.none(),
      },
      {
        channel_id: FAIL_CHANNEL_ID,
        name: 'fail-chan',
        type: 0,
        parent_id: Option.none(),
      },
    ]);

    // Channel sync layer that fails for FAIL_CHANNEL_ID
    const failingSyncLayer = Layer.succeed(ChannelSyncEventsRepository, {
      ...(MockChannelSyncEventsRepositoryLayer as any),
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
      emitManagedChannelArchived: (_args: { teamId: Team.TeamId }) => {
        managedSyncCalls.push({ type: 'channel_archived', teamChannelId: 'stub' as any });
        return Effect.void;
      },
      emitManagedChannelDeleted: () => Effect.void,
      emitManagedAccessGrantedBatch: () => {
        managedSyncCalls.push({ type: 'access_granted' });
        return Effect.void;
      },
      emitManagedAccessRevokedBatch: () => {
        managedSyncCalls.push({ type: 'access_revoked' });
        return Effect.void;
      },
      emitManagedChannelAdopted: () => Effect.void,
      emitDiscordChannelArchived: (args: {
        teamId: Team.TeamId;
        discordChannelId: Discord.Snowflake;
        archiveCategoryId: Discord.Snowflake;
      }) => {
        if (args.discordChannelId === FAIL_CHANNEL_ID) {
          return Effect.fail(new Error('Simulated emit failure') as any);
        }
        managedSyncCalls.push({
          type: 'discord_channel_archived',
          discordChannelId: args.discordChannelId,
          archiveCategoryId: args.archiveCategoryId,
        });
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

    const customApp = HttpRouter.toWebHandler(
      buildLayer({
        discordChannelsLayer: discordLayer,
        channelSyncLayer: failingSyncLayer,
      }),
    );
    const customHandler: (...args: any) => Promise<Response> = customApp.handler;

    const response = await customHandler(
      new Request(bulkArchiveUrl, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          discordChannelIds: [DISCORD_TEXT_CHANNEL_ID, FAIL_CHANNEL_ID],
        }),
      }),
    );
    await customApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();

    // The good channel should be archived
    expect(body.archived).toContain(DISCORD_TEXT_CHANNEL_ID);
    // The failing channel should be in failed, NOT in skipped
    const failedIds = body.failed.map((f: any) => f.discordChannelId);
    expect(failedIds).toContain(FAIL_CHANNEL_ID);
    const skippedIds = body.skipped.map((s: any) => s.discordChannelId);
    expect(skippedIds).not.toContain(FAIL_CHANNEL_ID);
  });
});
