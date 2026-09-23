// Guard regression pins for `api/role.ts`: cross-tenant role lookups (BLOCKER 2) and the
// name-only `CannotModifyBuiltIn` guard. The role-sync emission cases that used to live here
// went with the Sideline-role -> Discord mirroring subsystem.

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
import { AiChatEnabledConfig } from '~/services/AiChatEnabledConfig.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordJoinEnforcementConfig } from '~/services/DiscordJoinEnforcementConfig.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { LlmClient } from '~/services/LlmClient.js';
import {
  MockAiActionProposalsRepositoryLayer,
  MockChatAgentLayer,
  MockChatRateLimiterLayer,
} from '../mocks/aiChatMocks.js';
import { MockBankSyncLayers, MockGenericSqlClientLayer } from '../mocks/bankSyncMocks.js';
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
// Regression fixture for the group-linking fix: a member who holds the role being
// unassigned BOTH directly (member_roles) AND through a group. Deleting the direct
// `member_roles` row must not emit `role_unassigned` / `role_removed` if the member
// still effectively holds the role via the group.
const TEST_MEMBER_GROUP_ROLE_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const TEST_ROLE_ID = '00000000-0000-0000-0000-000000000040' as Role.RoleId;
// T-S2 (`.work-plans/configurable-default-roles.md`, BLOCKER 2): a role belonging to a
// DIFFERENT team, and a built-in role of `TEST_TEAM_ID` — regression pins for the team-scope
// guard on `getRole`/`updateRole`/`deleteRole` and for the built-in-name-only guard.
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const OTHER_TEAM_ROLE_ID = '00000000-0000-0000-0000-000000000098' as Role.RoleId;
const BUILT_IN_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '111111111111111111' as Discord.Snowflake;
const GROUP_MEMBER_DISCORD_ID = '222222222222222222' as Discord.Snowflake;

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
// Roles state
// ---------------------------------------------------------------------------

type RoleRow = { id: Role.RoleId; team_id: Team.TeamId; name: string; is_built_in: boolean };

let rolesStore: RoleRow[] = [];

// T-S2: call counters for the BLOCKER 2 guard pins ("...roleId belonging to another team ...
// NOT called") — a plain `Effect.die`/filter body gives no way to assert non-invocation.
let updateRoleCalls = 0;
let archiveRoleByIdCalls = 0;

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
    updateRole: (id: Role.RoleId, name: Option.Option<string>) => {
      updateRoleCalls += 1;
      const existing = rolesStore.find((r) => r.id === id);
      if (!existing) return Effect.die(new Error('Not implemented'));
      const updated = { ...existing, name: Option.getOrElse(name, () => existing.name) };
      rolesStore = rolesStore.map((r) => (r.id === id ? updated : r));
      return Effect.succeed(updated);
    },
    archiveRoleById: (id: Role.RoleId) => {
      archiveRoleByIdCalls += 1;
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

// Simulates the effective-roles-after-the-write query a fixed `unassignRole` must
// consult: keyed by member id, the roles that member STILL effectively holds (e.g.
// through a group) after the direct `member_roles` row has been deleted. Defaults to
// empty (nothing retained) for any member not explicitly configured by a test.
let effectiveRolesAfterUnassign = new Map<
  TeamMember.TeamMemberId,
  ReadonlyArray<{ role_id: Role.RoleId; role_name: string }>
>();

// Simulates `findEffectiveRoleIdsForMember` dying with a defect (what `catchSqlErrors`
// turns a `SqlError` into) — regression for the guard degrading instead of 500ing the
// captain's already-committed `unassignRole` (fix/role-linking review blocker 5).
let effectiveRolesLookupShouldDie = false;

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
    findEffectiveRoleIdsForMember: (memberId: TeamMember.TeamMemberId) =>
      effectiveRolesLookupShouldDie
        ? Effect.die(new Error('boom'))
        : Effect.succeed(effectiveRolesAfterUnassign.get(memberId) ?? []),
    findMembershipByDiscordAndTeam: () => Effect.succeed(Option.none()),
    findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
      if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
      if (memberId === TEST_MEMBER_ID)
        return Effect.succeed(Option.some(rosterEntry(memberId, MEMBER_DISCORD_ID)));
      if (memberId === TEST_MEMBER_NO_DISCORD_ID)
        return Effect.succeed(Option.some(rosterEntry(memberId, '')));
      if (memberId === TEST_MEMBER_GROUP_ROLE_ID)
        return Effect.succeed(Option.some(rosterEntry(memberId, GROUP_MEMBER_DISCORD_ID)));
      return Effect.succeed(Option.none());
    },
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    reactivateMember: () => Effect.die(new Error('Not implemented')),
    getDefaultRoleId: () => Effect.succeed(Option.none()),
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

// Records every notification insert so tests can assert a `role_removed` notification
// was (or was NOT) created without needing a real NotificationsRepository.
type RecordedNotification = { readonly type: string; readonly userId: Auth.UserId };
let recordedNotifications: RecordedNotification[] = [];

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  insert: (_teamId: Team.TeamId, userId: Auth.UserId, type: string) => {
    recordedNotifications.push({ type, userId });
    return Effect.void;
  },
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
  Layer.provide(MockNotificationsRepositoryLayer),
  Layer.provide(MockBotGuildsRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockNoopLayers),
)
  .pipe(Layer.provide(MockBankSyncLayers))
  .pipe(Layer.provide(MockGenericSqlClientLayer))
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
  .pipe(Layer.provide(MockChatAgentLayer))
  .pipe(Layer.provide(MockChatRateLimiterLayer))
  .pipe(Layer.provide(MockAiActionProposalsRepositoryLayer))
  .pipe(Layer.provide(AiChatEnabledConfig.Default))
  .pipe(Layer.provide(LlmClient.Default))
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
  rolesStore = [
    { id: TEST_ROLE_ID, team_id: TEST_TEAM_ID, name: 'Coach', is_built_in: false },
    { id: BUILT_IN_ROLE_ID, team_id: TEST_TEAM_ID, name: 'Player', is_built_in: true },
    { id: OTHER_TEAM_ROLE_ID, team_id: OTHER_TEAM_ID, name: 'Foreign', is_built_in: false },
  ];
  recordedNotifications = [];
  effectiveRolesAfterUnassign = new Map();
  effectiveRolesLookupShouldDie = false;
  updateRoleCalls = 0;
  archiveRoleByIdCalls = 0;
});

const authHeaders = { Authorization: 'Bearer admin-token' };

// ---------------------------------------------------------------------------
// T-S2 (`.work-plans/configurable-default-roles.md`) — BLOCKER 2 (cross-tenant role lookups)
// + the `CannotModifyBuiltIn` false-alarm pins. Cases 1-3 should already PASS on `main`: the
// team-scope guard on `getRole`/`updateRole`/`deleteRole` was implemented ahead of this test
// suite. They stay here as regression pins — a future refactor of `findRoleById` (e.g. adding a
// team-scoped variant and dropping the app-level check as "redundant") would silently reopen the
// IDOR the guard closes. Cases 4-5 pin that the built-in guard stays name-only in both
// directions, per the plan's "verified, keep the pins" note.
// ---------------------------------------------------------------------------

describe('role.ts — BLOCKER 2: cross-tenant role lookups are rejected', () => {
  it('1. getRole with a roleId from another team → 404, not that role detail', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${OTHER_TEAM_ROLE_ID}`, {
        method: 'GET',
        headers: authHeaders,
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { _tag?: string };
    expect(body._tag).toBe('RoleNotFound');
  });

  it('2. updateRole with a roleId from another team → 404, roles.updateRole NOT called', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${OTHER_TEAM_ROLE_ID}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Hijacked', permissions: null }),
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { _tag?: string };
    expect(body._tag).toBe('RoleNotFound');
    expect(updateRoleCalls).toBe(0);
  });

  it('3. deleteRole with a roleId from another team → 404, archiveRoleById NOT called', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${OTHER_TEAM_ROLE_ID}`, {
        method: 'DELETE',
        headers: authHeaders,
      }),
    );

    expect(response.status).toBe(404);
    const body = (await response.json()) as { _tag?: string };
    expect(body._tag).toBe('RoleNotFound');
    expect(archiveRoleByIdCalls).toBe(0);
    // The foreign role must still exist — nothing was archived.
    expect(rolesStore.find((r) => r.id === OTHER_TEAM_ROLE_ID)).toBeDefined();
  });
});

describe('role.ts — the CannotModifyBuiltIn guard stays name-only (false-alarm pins)', () => {
  it('4. updateRole on a BUILT-IN role with name: None + permissions succeeds (200)', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${BUILT_IN_ROLE_ID}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: null, permissions: ['roster:view'] }),
      }),
    );

    expect(response.status).toBe(200);
    // The name-only guard never fires when `name` is absent — permissions on a built-in role are
    // editable today, and this pin stops that from being "hardened" into a blanket built-in block.
    expect(updateRoleCalls).toBe(0);
  });

  it("5. updateRole on a built-in with name: Some('X') still 400s CannotModifyBuiltIn", async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/roles/${BUILT_IN_ROLE_ID}`, {
        method: 'PATCH',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Renamed', permissions: null }),
      }),
    );

    expect(response.status).toBe(400);
    const body = (await response.json()) as { _tag?: string };
    expect(body._tag).toBe('CannotModifyBuiltIn');
    expect(updateRoleCalls).toBe(0);
  });
});
