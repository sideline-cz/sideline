// TDD — root cause D's regression tests.
//
// `emitRoleAssigned` / `emitRoleUnassigned` / `emitRoleCreated` / `emitRoleDeleted`
// (RoleSyncEventsRepository.ts) had zero production callers: `role.ts`'s `assignRole`,
// `unassignRole`, `createRole` and `deleteRole` wrote their primary state change and a
// notification, and never touched `role_sync_events`. The bot's role loop has been polling an
// always-empty table. These tests fail before the four `emit*` calls are added to `role.ts` and
// pass after.

import type { Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
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
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { CustomAchievementsRepository } from '~/repositories/CustomAchievementsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { DiscordChannelsRepository } from '~/repositories/DiscordChannelsRepository.js';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { DiscordRolesRepository } from '~/repositories/DiscordRolesRepository.js';
import { EventRosterRequestsRepository } from '~/repositories/EventRosterRequestsRepository.js';
import { EventRostersRepository } from '~/repositories/EventRostersRepository.js';
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
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { RostersRepository } from '~/repositories/RostersRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';
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
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockRulesAttemptsRepositoryLayer } from '../mocks/rulesTrainerMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_MEMBER_NO_DISCORD_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROLE_ID = '00000000-0000-0000-0000-000000000040' as Role.RoleId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '111111111111111111' as Discord.Snowflake;

const ADMIN_PERMISSIONS: readonly Role.Permission[] = ['role:manage', 'role:view'];

const adminMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
} as unknown as MembershipWithRole;

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_USER_ID);

// ---------------------------------------------------------------------------
// Recorder for RoleSyncEventsRepository
// ---------------------------------------------------------------------------

type RecordedEvent =
  | {
      readonly type: 'role_assigned';
      readonly roleId: string;
      readonly memberId: string;
      readonly discordId: string;
    }
  | {
      readonly type: 'role_unassigned';
      readonly roleId: string;
      readonly memberId: string;
      readonly discordId: string;
    }
  | { readonly type: 'role_created'; readonly roleId: string; readonly roleName: string }
  | { readonly type: 'role_deleted'; readonly roleId: string; readonly roleName: string };

let recordedEvents: RecordedEvent[] = [];
let emitShouldFail = false;

const makeRoleSyncEventsRepositoryLayer = () =>
  Layer.succeed(RoleSyncEventsRepository, {
    emitRoleCreated: (_teamId: Team.TeamId, roleId: Role.RoleId, roleName: string) => {
      if (emitShouldFail) return Effect.die(new Error('boom'));
      recordedEvents.push({ type: 'role_created', roleId, roleName });
      return Effect.void;
    },
    emitRoleDeleted: (_teamId: Team.TeamId, roleId: Role.RoleId, roleName: string) => {
      if (emitShouldFail) return Effect.die(new Error('boom'));
      recordedEvents.push({ type: 'role_deleted', roleId, roleName });
      return Effect.void;
    },
    emitRoleAssigned: (
      _teamId: Team.TeamId,
      roleId: Role.RoleId,
      _roleName: string,
      memberId: TeamMember.TeamMemberId,
      discordId: Discord.Snowflake,
    ) => {
      if (emitShouldFail) return Effect.die(new Error('boom'));
      recordedEvents.push({ type: 'role_assigned', roleId, memberId, discordId });
      return Effect.void;
    },
    emitRoleUnassigned: (
      _teamId: Team.TeamId,
      roleId: Role.RoleId,
      _roleName: string,
      memberId: TeamMember.TeamMemberId,
      discordId: Discord.Snowflake,
    ) => {
      if (emitShouldFail) return Effect.die(new Error('boom'));
      recordedEvents.push({ type: 'role_unassigned', roleId, memberId, discordId });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Roles state
// ---------------------------------------------------------------------------

type RoleRow = { id: Role.RoleId; team_id: Team.TeamId; name: string; is_built_in: boolean };

let rolesStore: RoleRow[] = [];

const makeRolesRepositoryLayer = () =>
  Layer.succeed(RolesRepository, {
    findRolesByTeamId: () => Effect.succeed([]),
    findRoleById: (id: Role.RoleId) => {
      const role = rolesStore.find((r) => r.id === id);
      return Effect.succeed(role ? Option.some(role) : Option.none());
    },
    getPermissionsForRoleId: () => Effect.succeed([]),
    insertRole: (teamId: Team.TeamId, name: string) => {
      const role: RoleRow = {
        id: `${rolesStore.length + 100}` as Role.RoleId,
        team_id: teamId,
        name,
        is_built_in: false,
      };
      rolesStore.push(role);
      return Effect.succeed(role);
    },
    updateRole: () => Effect.die(new Error('Not implemented')),
    archiveRoleById: (id: Role.RoleId) => {
      rolesStore = rolesStore.filter((r) => r.id !== id);
      return Effect.void;
    },
    setRolePermissions: () => Effect.void,
    initializeTeamRoles: () => Effect.void,
    findRoleByTeamAndName: () => Effect.succeed(Option.none()),
    seedTeamRolesWithPermissions: () => Effect.succeed([]),
    getMemberCountForRole: () => Effect.succeed(0),
    findGroupsForRole: () => Effect.succeed([]),
    assignRoleToGroup: () => Effect.void,
    unassignRoleFromGroup: () => Effect.void,
  } as any);

// ---------------------------------------------------------------------------
// Team members
// ---------------------------------------------------------------------------

const rosterEntry = (memberId: TeamMember.TeamMemberId, discordId: string) =>
  new RosterEntry({
    member_id: memberId,
    user_id: TEST_USER_ID,
    discord_id: discordId as Discord.Snowflake,
    role_names: [],
    permissions: [],
    name: Option.none(),
    birth_date: Option.none(),
    gender: Option.none(),
    jersey_number: Option.none(),
    username: 'user',
    avatar: Option.none(),
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    joined_at: '2024-01-01T00:00:00.000Z',
    active: true,
  });

const makeTeamMembersRepositoryLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    addMember: () => Effect.die(new Error('Not implemented')),
    findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) =>
      teamId === TEST_TEAM_ID && userId === TEST_USER_ID
        ? Effect.succeed(Option.some(adminMembership))
        : Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findTeamMembersWithNames: () => Effect.succeed([]),
    findEffectiveRoleIdsForMember: () => Effect.die(new Error('Not exercised in this test file')),
    findMembershipByDiscordAndTeam: () => Effect.succeed(Option.none()),
    findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
      if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
      if (memberId === TEST_MEMBER_ID)
        return Effect.succeed(Option.some(rosterEntry(memberId, MEMBER_DISCORD_ID)));
      if (memberId === TEST_MEMBER_NO_DISCORD_ID)
        return Effect.succeed(Option.some(rosterEntry(memberId, '')));
      return Effect.succeed(Option.none());
    },
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    reactivateMember: () => Effect.die(new Error('Not implemented')),
    getPlayerRoleId: () => Effect.succeed(Option.none()),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.die(new Error('Not implemented')),
    hasOtherActiveManager: () => Effect.succeed(true),
    resetMissedRsvps: () => Effect.void,
    hardDelete: () => Effect.die(new Error('Not implemented')),
  } as any);

// ---------------------------------------------------------------------------
// Static mocks (auth plumbing, unrelated repositories)
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
            username: 'testuser',
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.some('Test User'),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en' as const,
            discord_display_name: Option.none(),
            discord_nickname: Option.none(),
            created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
            updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
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
            guild_id: GUILD_ID,
            created_by: TEST_USER_ID,
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          })
        : Option.none(),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.void,
  insertBulk: () => Effect.void,
  markAsRead: () => Effect.void,
  markAllAsRead: () => Effect.void,
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(false),
  findAll: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.some({ is_community_enabled: true })),
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

const MockPendingGuildJoinsLayer = Layer.succeed(PendingGuildJoinsRepository, {
  enqueue: () => Effect.void,
  listPending: () => Effect.succeed([]),
  markDone: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

// Minimal stubs for repositories not exercised by these tests.
const noopMockLayer = <T>(tag: T) =>
  Layer.succeed(
    tag as any,
    new Proxy(
      {},
      {
        get: () => () => Effect.void,
      },
    ),
  );

const MockNoopLayers = Layer.mergeAll(
  noopMockLayer(GroupsRepository),
  noopMockLayer(TeamInvitesRepository),
  noopMockLayer(InviteAcceptancesRepository),
  MockPendingGuildJoinsLayer,
  noopMockLayer(TrainingTypesRepository),
  noopMockLayer(RostersRepository),
  noopMockLayer(DiscordChannelsRepository),
  noopMockLayer(DiscordRoleMappingRepository),
  noopMockLayer(DiscordRolesRepository),
  noopMockLayer(DiscordChannelMappingRepository),
  noopMockLayer(EventsRepository),
  noopMockLayer(EventSeriesRepository),
  noopMockLayer(EventRsvpsRepository),
  noopMockLayer(ICalTokensRepository),
  noopMockLayer(ActivityLogsRepository),
  noopMockLayer(ActivityTypesRepository),
  noopMockLayer(LeaderboardRepository),
  noopMockLayer(ChannelSyncEventsRepository),
  noopMockLayer(EventSyncEventsRepository),
  noopMockLayer(AgeThresholdRepository),
  noopMockLayer(OAuthConnectionsRepository),
  noopMockLayer(TeamChallengeRepository),
  noopMockLayer(PlayerRatingsRepository),
  noopMockLayer(AgeCheckService),
  noopMockLayer(AchievementRoleMappingsRepository),
  noopMockLayer(AchievementSettingsRepository),
  noopMockLayer(CustomAchievementsRepository),
  noopMockLayer(DiscordRoleProvisionEventsRepository),
  noopMockLayer(AchievementPreview),
  noopMockLayer(EventRostersRepository),
  noopMockLayer(EventRosterRequestsRepository),
  noopMockLayer(EventRosterProvisioningService),
  MockTeamSettingsRepositoryLayer,
  MockTranslationsLayers,
);

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(makeTeamMembersRepositoryLayer()),
  Layer.provide(makeRolesRepositoryLayer()),
  Layer.provide(makeRoleSyncEventsRepositoryLayer()),
  Layer.provide(MockNotificationsRepositoryLayer),
  Layer.provide(MockBotGuildsRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockNoopLayers),
)
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(
    Layer.provide(
      Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
    ),
  );

// ---------------------------------------------------------------------------
// Test setup
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
  recordedEvents = [];
  emitShouldFail = false;
  rolesStore = [{ id: TEST_ROLE_ID, team_id: TEST_TEAM_ID, name: 'Coach', is_built_in: false }];
});

const authHeaders = { Authorization: 'Bearer admin-token' };

describe('role.ts — root cause D: role sync event emission', () => {
  it('assignRole emits a role_assigned event with the member discord_id', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/roles`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: TEST_ROLE_ID }),
      }),
    );

    expect(response.status).toBe(204);
    expect(recordedEvents).toContainEqual({
      type: 'role_assigned',
      roleId: TEST_ROLE_ID,
      memberId: TEST_MEMBER_ID,
      discordId: MEMBER_DISCORD_ID,
    });
  });

  it('unassignRole emits a role_unassigned event', async () => {
    const response = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/roles/${TEST_ROLE_ID}`,
        {
          method: 'DELETE',
          headers: authHeaders,
        },
      ),
    );

    expect(response.status).toBe(204);
    expect(recordedEvents).toContainEqual({
      type: 'role_unassigned',
      roleId: TEST_ROLE_ID,
      memberId: TEST_MEMBER_ID,
      discordId: MEMBER_DISCORD_ID,
    });
  });

  it('createRole emits a role_created event', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'New Role', permissions: [] }),
      }),
    );

    expect(response.status).toBe(201);
    const created = recordedEvents.find((e) => e.type === 'role_created');
    expect(created).toBeDefined();
    expect(created && 'roleName' in created ? created.roleName : undefined).toBe('New Role');
  });

  it('deleteRole emits a role_deleted event with the role name captured before archiving', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${TEST_ROLE_ID}`, {
        method: 'DELETE',
        headers: authHeaders,
      }),
    );

    expect(response.status).toBe(204);
    expect(recordedEvents).toContainEqual({
      type: 'role_deleted',
      roleId: TEST_ROLE_ID,
      roleName: 'Coach',
    });
    // The role row itself is gone (archived) by the time the event is emitted, but the emitted
    // name still reflects the pre-archive name.
    expect(rolesStore.find((r) => r.id === TEST_ROLE_ID)).toBeUndefined();
  });

  it('assignRole does not emit when the member has no discord_id', async () => {
    const response = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_NO_DISCORD_ID}/roles`,
        {
          method: 'POST',
          headers: { ...authHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify({ roleId: TEST_ROLE_ID }),
        },
      ),
    );

    expect(response.status).toBe(204);
    expect(recordedEvents).toHaveLength(0);
  });

  it('assignRole still succeeds when the emit fails (best-effort tap)', async () => {
    emitShouldFail = true;

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/roles`, {
        method: 'POST',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ roleId: TEST_ROLE_ID }),
      }),
    );

    expect(response.status).toBe(204);
    expect(recordedEvents).toHaveLength(0);
  });
});
