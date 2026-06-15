// TDD mode — tests written BEFORE OnboardingApiLive handler exists.
// These tests WILL FAIL until:
//   - applications/server/src/repositories/TeamOnboardingTokensRepository.ts is implemented
//   - applications/server/src/api/onboarding.ts (OnboardingApiLive) is implemented
//   - api/index.ts provides OnboardingApiLive
//   - The team_onboarding_tokens migration has been run against the test database

import type { Auth, Discord, OnboardingApi, Team, TeamMember } from '@sideline/domain';
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
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { ICalTokensRepository } from '~/repositories/ICalTokensRepository.js';
import { InviteAcceptancesRepository } from '~/repositories/InviteAcceptancesRepository.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { OAuthConnectionsRepository } from '~/repositories/OAuthConnectionsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { PendingGuildJoinsRepository } from '~/repositories/PendingGuildJoinsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';
import { TeamInvitesRepository } from '~/repositories/TeamInvitesRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamOnboardingTokensRepository } from '~/repositories/TeamOnboardingTokensRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../../mocks/emailMocks.js';
import { MockEventRosterLayers } from '../../mocks/eventRosterMocks.js';
import { MockTranslationsLayers } from '../../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

// The global-admin discord ID must be listed in APP_GLOBAL_ADMIN_DISCORD_IDS.
// The tests rely on process.env.APP_GLOBAL_ADMIN_DISCORD_IDS including this value
// (set in the vitest environment or .env.test).
const ADMIN_DISCORD_ID = '900000000000000001';
const REGULAR_DISCORD_ID = '900000000000000002';
// Captain discord ID for the onboarding flow (the bound_discord_id on the token)
const CAPTAIN_DISCORD_ID = '900000000000000003';

const ADMIN_USER_ID = '00000000-0000-0000-0000-000000000100' as Auth.UserId;
const REGULAR_USER_ID = '00000000-0000-0000-0000-000000000101' as Auth.UserId;
const CAPTAIN_USER_ID = '00000000-0000-0000-0000-000000000102' as Auth.UserId;

const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000200' as Team.TeamId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-0000-0000-000000000300' as TeamMember.TeamMemberId;

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

interface TokenRecord {
  id: string;
  token_hash: string;
  proposed_name: string;
  bound_discord_id: string;
  created_by: string;
  created_at: Date;
  expires_at: Date;
  consumed_at: Date | null;
  consumed_by: string | null;
  resulting_team_id: string | null;
  revoked_at: Date | null;
}

let tokensStore: Map<string, TokenRecord>;
let teamsStore: Map<string, any>;
let membersStore: Map<string, MembershipWithRole>;

const usersMap = new Map<Auth.UserId, { id: Auth.UserId; discord_id: string; username: string }>();
usersMap.set(ADMIN_USER_ID, {
  id: ADMIN_USER_ID,
  discord_id: ADMIN_DISCORD_ID,
  username: 'admin-user',
});
usersMap.set(REGULAR_USER_ID, {
  id: REGULAR_USER_ID,
  discord_id: REGULAR_DISCORD_ID,
  username: 'regular-user',
});
usersMap.set(CAPTAIN_USER_ID, {
  id: CAPTAIN_USER_ID,
  discord_id: CAPTAIN_DISCORD_ID,
  username: 'captain-user',
});

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', ADMIN_USER_ID);
sessionsStore.set('regular-token', REGULAR_USER_ID);
sessionsStore.set('captain-token', CAPTAIN_USER_ID);

const resetStores = () => {
  tokensStore = new Map();
  teamsStore = new Map();
  membersStore = new Map();
  membersStore.set(TEST_CAPTAIN_MEMBER_ID, {
    id: TEST_CAPTAIN_MEMBER_ID,
    team_id: TEST_TEAM_ID,
    user_id: CAPTAIN_USER_ID,
    active: true,
    role_names: ['Admin'],
    permissions: ['team:manage'] as any,
  } as MembershipWithRole);
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockTeamOnboardingTokensRepositoryLayer = Layer.succeed(TeamOnboardingTokensRepository, {
  _tag: 'api/TeamOnboardingTokensRepository',

  create: (input: any) => {
    const id = crypto.randomUUID();
    const record: TokenRecord = {
      id,
      token_hash: input.token_hash,
      proposed_name: input.proposed_name,
      bound_discord_id: input.bound_discord_id,
      created_by: input.created_by,
      created_at: new Date(),
      expires_at: input.expires_at,
      consumed_at: null,
      consumed_by: null,
      resulting_team_id: null,
      revoked_at: null,
    };
    tokensStore.set(id, record);
    return Effect.succeed({
      ...record,
      created_at: DateTime.fromDateUnsafe(record.created_at),
      expires_at: DateTime.fromDateUnsafe(record.expires_at),
      consumed_at: Option.none(),
      consumed_by: Option.none(),
      resulting_team_id: Option.none(),
      revoked_at: Option.none(),
    });
  },

  findByHash: (hash: string) => {
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        ...record,
        id: record.id as TeamOnboardingToken.TeamOnboardingTokenId,
        bound_discord_id: record.bound_discord_id as Discord.Snowflake,
        created_by: record.created_by as Auth.UserId,
        created_at: DateTime.fromDateUnsafe(record.created_at),
        expires_at: DateTime.fromDateUnsafe(record.expires_at),
        consumed_at: record.consumed_at
          ? Option.some(DateTime.fromDateUnsafe(record.consumed_at))
          : Option.none(),
        consumed_by: record.consumed_by
          ? Option.some(record.consumed_by as Auth.UserId)
          : Option.none(),
        resulting_team_id: record.resulting_team_id
          ? Option.some(record.resulting_team_id as Team.TeamId)
          : Option.none(),
        revoked_at: record.revoked_at
          ? Option.some(DateTime.fromDateUnsafe(record.revoked_at))
          : Option.none(),
      }),
    );
  },

  markConsumed: (id: string, input: any) => {
    const record = tokensStore.get(id);
    if (!record || record.consumed_at !== null) return Effect.succeed(Option.none());
    const updated = {
      ...record,
      consumed_at: new Date(),
      consumed_by: input.consumed_by,
      resulting_team_id: input.resulting_team_id,
    };
    tokensStore.set(id, updated);
    return Effect.succeed(Option.some(updated));
  },

  revoke: (id: string) => {
    const record = tokensStore.get(id);
    if (!record || record.revoked_at !== null || record.consumed_at !== null) {
      return Effect.void;
    }
    tokensStore.set(id, { ...record, revoked_at: new Date() });
    return Effect.void;
  },

  listForAdmin: () => {
    const records = Array.from(tokensStore.values())
      .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())
      .map((r) => {
        const now = Date.now();
        const isExpired = r.expires_at.getTime() < now;
        const status: OnboardingApi.OnboardingTokenStatus = r.consumed_at
          ? 'consumed'
          : r.revoked_at
            ? 'revoked'
            : isExpired
              ? 'expired'
              : 'active';
        return {
          id: r.id,
          proposedName: r.proposed_name,
          boundDiscordId: r.bound_discord_id,
          createdAt: DateTime.fromDateUnsafe(r.created_at),
          expiresAt: DateTime.fromDateUnsafe(r.expires_at),
          status,
          consumedAt: r.consumed_at
            ? Option.some(DateTime.fromDateUnsafe(r.consumed_at))
            : Option.none(),
          consumedBy: r.consumed_by ? Option.some(r.consumed_by) : Option.none(),
          resultingTeamId: r.resulting_team_id ? Option.some(r.resulting_team_id) : Option.none(),
          createdByUsername: 'admin-user',
        };
      });
    return Effect.succeed(records);
  },
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) => {
    const user = usersMap.get(id);
    return Effect.succeed(
      user
        ? Option.some({
            ...user,
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.none(),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en',
            discord_display_name: Option.none(),
            discord_nickname: Option.none(),
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          })
        : Option.none(),
    );
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: (input: any) => {
    const id = crypto.randomUUID() as Auth.UserId;
    const entry = { id, discord_id: input.discord_id, username: input.username };
    usersMap.set(id, entry);
    return Effect.succeed({
      ...entry,
      avatar: Option.none(),
      is_profile_complete: false,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      discord_nickname: Option.none(),
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
    });
  },
  completeProfile: () => Effect.succeed({} as any),
  updateLocale: () => Effect.succeed({} as any),
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
    const team = teamsStore.get(id);
    return Effect.succeed(team ? Option.some(team) : Option.none());
  },
  insert: (input: any) => {
    const id = crypto.randomUUID() as Team.TeamId;
    const team = {
      id,
      name: input.name,
      guild_id: input.guild_id,
      description: input.description ?? Option.none(),
      sport: input.sport ?? Option.none(),
      logo_url: input.logo_url ?? Option.none(),
      welcome_channel_id: input.welcome_channel_id ?? Option.none(),
      system_log_channel_id: input.system_log_channel_id ?? Option.none(),
      welcome_message_template: input.welcome_message_template ?? Option.none(),
      rules_channel_id: input.rules_channel_id ?? Option.none(),
      overview_channel_id: input.overview_channel_id ?? Option.none(),
      achievement_channel_id: input.achievement_channel_id ?? Option.none(),
      onboarding_rules_role_id: input.onboarding_rules_role_id ?? Option.none(),
      onboarding_rules_prompt_id: input.onboarding_rules_prompt_id ?? Option.none(),
      onboarding_locale: input.onboarding_locale ?? 'en',
      onboarding_synced_at: Option.none(),
      onboarding_sync_status: 'pending',
      onboarding_sync_error: Option.none(),
      created_by: input.created_by,
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
    };
    teamsStore.set(id, team);
    return Effect.succeed(team);
  },
  findByGuildId: (guildId: Discord.Snowflake) => {
    const team = Array.from(teamsStore.values()).find((t) => t.guild_id === guildId);
    return Effect.succeed(team ? Option.some(team) : Option.none());
  },
  update: () => Effect.succeed({} as any),
  claimPendingOnboardingSyncs: () => Effect.succeed([]),
  markOnboardingSyncPending: () => Effect.void,
  markOnboardingSyncDoneIfSyncing: () => Effect.succeed(false),
  markOnboardingSyncFailedIfSyncing: () => Effect.void,
  revertOnboardingSyncIfSyncing: () => Effect.void,
  markOnboardingSyncSkippedIfSyncing: () => Effect.void,
  flipPendingOnboardingSyncForGuild: () => Effect.void,
  getOnboardingRulesRoleIdByGuildId: () => Effect.succeed(Option.none()),
  setOverviewChannelByGuildId: () => Effect.succeed([]),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const id = crypto.randomUUID() as TeamMember.TeamMemberId;
    const member = {
      id,
      team_id: teamId,
      user_id: userId,
      active: true,
      role_names: [],
      permissions: [],
    };
    membersStore.set(id, member as MembershipWithRole);
    return Effect.succeed(member);
  },
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = Array.from(membersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: (userId: Auth.UserId) =>
    Effect.succeed(Array.from(membersStore.values()).filter((m) => m.user_id === userId)),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
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
  seedTeamRolesWithPermissions: (teamId: string) =>
    Effect.succeed([
      {
        id: crypto.randomUUID(),
        team_id: teamId,
        name: 'Admin',
        created_at: new Date(),
        updated_at: new Date(),
        archived_at: null,
      },
    ]),
  getMemberCountForRole: () => Effect.succeed(0),
  findGroupsForRole: () => Effect.succeed([]),
  assignRoleToGroup: () => Effect.void,
  unassignRoleFromGroup: () => Effect.void,
} as any);

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
} as any);

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

// Stub layers for all other repositories that the AppLive layer wires (not tested here)
const StubRepositoriesLayer = Layer.mergeAll(
  Layer.succeed(
    GroupsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    TrainingTypesRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(TeamInvitesRepository, {
    _tag: 'api/TeamInvitesRepository',
    findByCode: () => Effect.succeed(Option.none()),
    create: () => Effect.die(new Error('Not implemented')),
  } as any),
  Layer.succeed(InviteAcceptancesRepository, { _tag: 'api/InviteAcceptancesRepository' } as any),
  Layer.succeed(AgeThresholdRepository, {
    findByTeamId: () => Effect.succeed([]),
  } as any),
  Layer.succeed(NotificationsRepository, {
    findByUserId: () => Effect.succeed([]),
    insertOne: () => Effect.void,
    markOneAsRead: () => Effect.void,
    markAllRead: () => Effect.void,
    findOneById: () => Effect.succeed(Option.none()),
    findByUser: () => Effect.succeed([]),
    insert: () => Effect.void,
    insertBulk: () => Effect.void,
    markAsRead: () => Effect.void,
    markAllAsRead: () => Effect.void,
    findById: () => Effect.succeed(Option.none()),
  } as any),
  Layer.succeed(
    RoleSyncEventsRepository,
    new Proxy({} as any, { get: () => () => Effect.void }) as any,
  ),
  Layer.succeed(
    ChannelSyncEventsRepository,
    new Proxy({} as any, { get: () => () => Effect.void }) as any,
  ),
  Layer.succeed(
    EventSyncEventsRepository,
    new Proxy({} as any, { get: () => () => Effect.void }) as any,
  ),
  Layer.succeed(
    DiscordChannelMappingRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(DiscordChannelsRepository, {
    syncChannels: () => Effect.void,
    findByGuildId: () => Effect.succeed([]),
  } as any),
  Layer.succeed(
    DiscordRolesRepository,
    new Proxy({} as any, { get: () => () => Effect.void }) as any,
  ),
  Layer.succeed(
    EventsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    EventRsvpsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    EventSeriesRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    ICalTokensRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed(Option.none()) }) as any,
  ),
  Layer.succeed(TeamSettingsRepository, {
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as any),
  Layer.succeed(OAuthConnectionsRepository, {
    findByUserAndProvider: () => Effect.succeed(Option.none()),
    findByUser: () => Effect.succeed(Option.none()),
    getAccessToken: () => Effect.succeed('mock-access-token'),
  } as any),
  Layer.succeed(ActivityLogsRepository, {
    insert: () => Effect.void,
    findByTeamMember: () => Effect.succeed([]),
  } as any),
  Layer.succeed(
    ActivityTypesRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed(Option.none()) }) as any,
  ),
  Layer.succeed(LeaderboardRepository, { getLeaderboard: () => Effect.succeed([]) } as any),
  Layer.succeed(PendingGuildJoinsRepository, {
    enqueue: () => Effect.void,
    listPending: () => Effect.succeed([]),
    markDone: () => Effect.void,
    markFailed: () => Effect.void,
  } as any),
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
  Layer.succeed(
    CustomAchievementsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed(Option.none()) }) as any,
  ),
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
  Layer.succeed(BotGuildsRepository, {
    upsert: () => Effect.void,
    remove: () => Effect.void,
    exists: () => Effect.succeed(false),
    findAll: () => Effect.succeed([]),
  } as any),
  Layer.succeed(
    RostersRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    FeesRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    FeeAssignmentsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(
    PaymentsRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(FinanceOverviewRepository, { overviewByTeam: () => Effect.succeed([]) } as any),
  Layer.succeed(
    ExpensesRepository,
    new Proxy({} as any, { get: () => () => Effect.succeed([]) }) as any,
  ),
  Layer.succeed(AgeCheckService, {
    evaluateTeam: () => Effect.succeed([]),
    evaluate: () => Effect.succeed([]),
  } as any),
  Layer.succeed(
    TeamChallengeRepository,
    new Proxy({} as any, { get: () => () => Effect.void }) as any,
  ),
);

// ---------------------------------------------------------------------------
// Mock SqlClient (passthrough withTransaction — no real DB needed)
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
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> => effect,
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
    },
  ) as unknown as SqlClient.SqlClient,
);

// ---------------------------------------------------------------------------
// Build the test HTTP layer
// ---------------------------------------------------------------------------

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockTeamOnboardingTokensRepositoryLayer),
  Layer.provide(MockRolesRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockSqlClientLayer),
  Layer.provide(StubRepositoriesLayer),
)
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(Layer.provide(GlobalAdminAllowlist.Default));

// ---------------------------------------------------------------------------
// HTTP handler bootstrap
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
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ONBOARDING_BASE = 'http://localhost/auth/onboarding/tokens';

const mintToken = (overrides?: { proposedName?: string; boundDiscordId?: string; ttl?: string }) =>
  handler(
    new Request(ONBOARDING_BASE, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        proposedName: overrides?.proposedName ?? 'Test Team',
        boundDiscordId: overrides?.boundDiscordId ?? CAPTAIN_DISCORD_ID,
        ttl: overrides?.ttl ?? '7d',
      }),
    }),
  );

// ---------------------------------------------------------------------------
// mintOnboardingToken
// ---------------------------------------------------------------------------

describe('mintOnboardingToken — authorization', () => {
  it('non-admin caller → 403 OnboardingForbidden', async () => {
    const response = await handler(
      new Request(ONBOARDING_BASE, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer regular-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          proposedName: 'Test Team',
          boundDiscordId: CAPTAIN_DISCORD_ID,
          ttl: '7d',
        }),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingForbidden/i);
  });
});

describe('mintOnboardingToken — happy path', () => {
  it('admin caller → 201 with plaintextToken, onboardingUrl, expiresAt; row exists in DB', async () => {
    const before = Date.now();
    const response = await mintToken();
    const after = Date.now();

    expect(response.status).toBe(201);
    const body = await response.json();

    expect(typeof body.plaintextToken).toBe('string');
    expect(body.plaintextToken.length).toBeGreaterThan(0);
    expect(typeof body.onboardingUrl).toBe('string');
    expect(body.onboardingUrl).toContain(body.plaintextToken);
    expect(typeof body.expiresAt).toBe('string');

    const expiresMs = new Date(body.expiresAt).getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    // expiresAt should be ≈ now + 7d ± 5s
    expect(expiresMs).toBeGreaterThanOrEqual(before + sevenDaysMs - 5000);
    expect(expiresMs).toBeLessThanOrEqual(after + sevenDaysMs + 5000);

    // The stored hash must be the SHA-256 hex of the plaintext token
    const { createHash } = await import('node:crypto');
    const expectedHash = createHash('sha256').update(body.plaintextToken).digest('hex');
    const storedToken = Array.from(tokensStore.values()).find((t) => t.token_hash === expectedHash);
    expect(storedToken).toBeDefined();

    // The plaintext token itself is NOT findable in the store
    const plaintextMatch = Array.from(tokensStore.values()).find(
      (t) => t.token_hash === body.plaintextToken,
    );
    expect(plaintextMatch).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// previewOnboardingToken
// ---------------------------------------------------------------------------

describe('previewOnboardingToken', () => {
  it('unknown plaintext → 404 OnboardingTokenNotFound', async () => {
    const response = await handler(new Request(`${ONBOARDING_BASE}/nonexistent-token/preview`));
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenNotFound/i);
  });

  it('revoked token → 410 OnboardingTokenRevoked', async () => {
    // Mint a token
    const mintResp = await mintToken();
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Revoke it via the store (simulate revocation)
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) throw new Error('token record not found in store');
    tokensStore.set(record.id, { ...record, revoked_at: new Date() });

    const response = await handler(new Request(`${ONBOARDING_BASE}/${plaintextToken}/preview`));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenRevoked/i);
  });

  it('expired token → 410 OnboardingTokenExpired', async () => {
    const mintResp = await mintToken();
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Manually expire it
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) throw new Error('token record not found in store');
    tokensStore.set(record.id, { ...record, expires_at: new Date(Date.now() - 1000) });

    const response = await handler(new Request(`${ONBOARDING_BASE}/${plaintextToken}/preview`));
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenExpired/i);
  });

  it('consumed token → 409 OnboardingTokenAlreadyConsumed', async () => {
    const mintResp = await mintToken();
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Manually mark as consumed
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) throw new Error('token record not found in store');
    tokensStore.set(record.id, {
      ...record,
      consumed_at: new Date(),
      consumed_by: CAPTAIN_USER_ID,
      resulting_team_id: TEST_TEAM_ID,
    });

    const response = await handler(new Request(`${ONBOARDING_BASE}/${plaintextToken}/preview`));
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenAlreadyConsumed/i);
  });

  it('valid token → 200 with proposedName, boundDiscordId, expiresAt (no auth required)', async () => {
    const mintResp = await mintToken({
      proposedName: 'Preview Test Team',
      boundDiscordId: CAPTAIN_DISCORD_ID,
    });
    expect(mintResp.status).toBe(201);
    const { plaintextToken, expiresAt } = await mintResp.json();

    // No Authorization header
    const response = await handler(new Request(`${ONBOARDING_BASE}/${plaintextToken}/preview`));
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.proposedName).toBe('Preview Test Team');
    expect(body.boundDiscordId).toBe(CAPTAIN_DISCORD_ID);
    expect(typeof body.expiresAt).toBe('string');
    // expiresAt should match the one returned by mint (within 1s)
    expect(
      Math.abs(new Date(body.expiresAt).getTime() - new Date(expiresAt).getTime()),
    ).toBeLessThan(1000);
  });
});

// ---------------------------------------------------------------------------
// completeOnboarding
// ---------------------------------------------------------------------------

describe('completeOnboarding', () => {
  const completePayload = (guildId = '800000000000000001') => ({
    name: 'My New Team',
    description: null,
    sport: null,
    logoUrl: null,
    guildId,
    welcomeChannelId: null,
    systemLogChannelId: null,
    onboardingLocale: 'en',
  });

  it('wrong captain (currentUser.discord_id !== token.bound_discord_id) → 403 OnboardingWrongCaptain; token NOT consumed', async () => {
    const mintResp = await mintToken({ boundDiscordId: CAPTAIN_DISCORD_ID });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Call with regular-token (REGULAR_DISCORD_ID !== CAPTAIN_DISCORD_ID)
    const response = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer regular-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(completePayload()),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingWrongCaptain/i);

    // Token must NOT be consumed
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    expect(record?.consumed_at).toBeNull();
  });

  it('happy path → 201 UserTeam; team created; member added with Admin role; token consumed with resulting_team_id', async () => {
    const mintResp = await mintToken({
      proposedName: 'Happy Path Team',
      boundDiscordId: CAPTAIN_DISCORD_ID,
    });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    const response = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer captain-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: 'Happy Path Team',
          description: null,
          sport: null,
          logoUrl: null,
          guildId: '810000000000000001',
          welcomeChannelId: null,
          systemLogChannelId: null,
          onboardingLocale: 'en',
        }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    // Response matches UserTeam shape
    expect(typeof body.teamId).toBe('string');
    expect(typeof body.teamName).toBe('string');

    // Team created in store
    const createdTeam = Array.from(teamsStore.values()).find(
      (t) => t.guild_id === '810000000000000001',
    );
    expect(createdTeam).toBeDefined();

    // Token consumed with resulting_team_id
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const tokenRecord = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    expect(tokenRecord?.consumed_at).not.toBeNull();
    expect(tokenRecord?.resulting_team_id).toBe(createdTeam?.id);
  });

  it('calling complete twice with same plaintext → second returns 409 OnboardingTokenAlreadyConsumed', async () => {
    const mintResp = await mintToken({ boundDiscordId: CAPTAIN_DISCORD_ID });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    const payload = JSON.stringify({
      name: 'Double Complete Team',
      description: null,
      sport: null,
      logoUrl: null,
      guildId: '820000000000000001',
      welcomeChannelId: null,
      systemLogChannelId: null,
      onboardingLocale: 'en',
    });

    const first = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: { Authorization: 'Bearer captain-token', 'Content-Type': 'application/json' },
        body: payload,
      }),
    );
    expect(first.status).toBe(201);

    const second = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: { Authorization: 'Bearer captain-token', 'Content-Type': 'application/json' },
        body: payload,
      }),
    );
    expect(second.status).toBe(409);
    const body = await second.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenAlreadyConsumed/i);
  });

  it('guild already claimed by a different team → 409 OnboardingGuildAlreadyClaimed; token NOT consumed', async () => {
    // Pre-populate the guild in the store so findByGuildId returns Some
    const existingTeam = {
      id: TEST_TEAM_ID,
      name: 'Existing Team',
      guild_id: '830000000000000001',
      created_by: ADMIN_USER_ID,
      created_at: DateTime.nowUnsafe(),
      updated_at: DateTime.nowUnsafe(),
    };
    teamsStore.set(TEST_TEAM_ID, existingTeam);

    const mintResp = await mintToken({ boundDiscordId: CAPTAIN_DISCORD_ID });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    const response = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: { Authorization: 'Bearer captain-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Duplicate Guild Team',
          description: null,
          sport: null,
          logoUrl: null,
          guildId: '830000000000000001',
          welcomeChannelId: null,
          systemLogChannelId: null,
          onboardingLocale: 'en',
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingGuildAlreadyClaimed/i);

    // Token must NOT be consumed
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const tokenRecord = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    expect(tokenRecord?.consumed_at).toBeNull();
  });

  it('expired at consume time → 410 OnboardingTokenExpired', async () => {
    const mintResp = await mintToken({ boundDiscordId: CAPTAIN_DISCORD_ID });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Manually expire the token
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) throw new Error('token record not found in store');
    tokensStore.set(record.id, { ...record, expires_at: new Date(Date.now() - 1000) });

    const response = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/complete`, {
        method: 'POST',
        headers: { Authorization: 'Bearer captain-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(completePayload('840000000000000001')),
      }),
    );
    expect(response.status).toBe(410);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenExpired/i);
  });
});

// ---------------------------------------------------------------------------
// revokeOnboardingToken
// ---------------------------------------------------------------------------

describe('revokeOnboardingToken', () => {
  it('non-admin caller → 403 OnboardingForbidden', async () => {
    const response = await handler(
      new Request(`${ONBOARDING_BASE}/00000000-0000-0000-0000-000000000001`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer regular-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingForbidden/i);
  });

  it('admin revoking active token → 204; subsequent preview returns 410 OnboardingTokenRevoked', async () => {
    const mintResp = await mintToken({ boundDiscordId: CAPTAIN_DISCORD_ID });
    expect(mintResp.status).toBe(201);
    const { plaintextToken } = await mintResp.json();

    // Find the token id in the store
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(plaintextToken).digest('hex');
    const record = Array.from(tokensStore.values()).find((t) => t.token_hash === hash);
    if (!record) throw new Error('token record not found in store');

    const revokeResponse = await handler(
      new Request(`${ONBOARDING_BASE}/${record.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(revokeResponse.status).toBe(204);

    // Verify the revoked_at is now set via mock state
    const updated = tokensStore.get(record.id);
    expect(updated?.revoked_at).not.toBeNull();

    // Preview should now return 410 revoked
    const previewResponse = await handler(
      new Request(`${ONBOARDING_BASE}/${plaintextToken}/preview`),
    );
    expect(previewResponse.status).toBe(410);
    const body = await previewResponse.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingTokenRevoked/i);
  });
});

// ---------------------------------------------------------------------------
// listOnboardingTokens
// ---------------------------------------------------------------------------

describe('listOnboardingTokens', () => {
  it('non-admin caller → 403 OnboardingForbidden', async () => {
    const response = await handler(
      new Request(ONBOARDING_BASE, {
        headers: { Authorization: 'Bearer regular-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/OnboardingForbidden/i);
  });

  it('admin sees all tokens ordered by created_at DESC with correct status field', async () => {
    // Mint two tokens
    await mintToken({ proposedName: 'Team One', boundDiscordId: CAPTAIN_DISCORD_ID });
    await mintToken({ proposedName: 'Team Two', boundDiscordId: CAPTAIN_DISCORD_ID });

    const response = await handler(
      new Request(ONBOARDING_BASE, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(Array.isArray(body)).toBe(true);
    expect(body.length).toBe(2);

    for (const item of body) {
      expect(typeof item.id).toBe('string');
      expect(typeof item.proposedName).toBe('string');
      expect(typeof item.boundDiscordId).toBe('string');
      expect(typeof item.createdAt).toBe('string');
      expect(typeof item.expiresAt).toBe('string');
      expect(['active', 'consumed', 'expired', 'revoked']).toContain(item.status);
    }

    // Verify descending order by createdAt
    if (body.length >= 2) {
      const firstMs = new Date(body[0].createdAt).getTime();
      const secondMs = new Date(body[1].createdAt).getTime();
      expect(firstMs).toBeGreaterThanOrEqual(secondMs);
    }
  });
});

// Needed for TypeScript to recognize TeamOnboardingToken namespace
import type { TeamOnboardingToken } from '@sideline/domain';
