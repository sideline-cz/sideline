// TDD — POST /teams/:teamId/members/:memberId/sync-discord-roles (PR-7 manual role sync).
//
// Pins CC-8's contract: `SyncMemberRolesResult` ships in its final shape once, `removedCount` is
// a real number computed against `discord_role_mappings` (never hard-coded 0), and removal is
// restricted to roles Sideline manages so a hand-granted Discord role is never stripped.

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
import { DiscordJoinEnforcementConfig } from '~/services/DiscordJoinEnforcementConfig.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER } from '~/utils/syncMemberDiscordRoles.js';
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
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_MEMBER_NO_DISCORD_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const MEMBER_DISCORD_ID = '111111111111111111' as Discord.Snowflake;

const ROLE_A = '00000000-0000-0000-0000-000000000040' as Role.RoleId;
const ROLE_B = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const ROLE_C = '00000000-0000-0000-0000-000000000042' as Role.RoleId;

const roleNames = new Map<Role.RoleId, string>([
  [ROLE_A, 'Captain'],
  [ROLE_B, 'Coach'],
  [ROLE_C, 'Treasurer'],
]);

const managerMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ['role:manage'],
} as unknown as MembershipWithRole;

const playerMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: [],
} as unknown as MembershipWithRole;

let currentMembership: MembershipWithRole = managerMembership;

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('token', TEST_USER_ID);

// ---------------------------------------------------------------------------
// Configurable per-test fixtures
// ---------------------------------------------------------------------------

type EffectiveRole = { role_id: Role.RoleId; role_name: string };
type ManagedMapping = {
  role_id: Role.RoleId;
  discord_role_id: Discord.Snowflake;
  adopted?: boolean;
};
type PriorRoleSync = {
  readonly state: 'ok' | 'failed';
  readonly at: DateTime.Utc;
  readonly errorCode: Option.Option<'retryable' | 'captain_action' | 'user_action' | 'unknown'>;
};

let effectiveRoles: EffectiveRole[] = [];
let managedMappings: ManagedMapping[] = [];
let priorRoleSync: Option.Option<PriorRoleSync> = Option.none();

type RecordedEvent =
  | { readonly type: 'role_assigned'; readonly roleId: Role.RoleId }
  | { readonly type: 'role_unassigned'; readonly roleId: Role.RoleId };

let recordedEvents: RecordedEvent[] = [];

const makeRoleSyncEventsRepositoryLayer = () =>
  Layer.succeed(RoleSyncEventsRepository, {
    emitRoleCreated: () => Effect.void,
    emitRoleDeleted: () => Effect.void,
    emitRoleAssigned: (_teamId: Team.TeamId, roleId: Role.RoleId) => {
      recordedEvents.push({ type: 'role_assigned', roleId });
      return Effect.void;
    },
    emitRoleUnassigned: (_teamId: Team.TeamId, roleId: Role.RoleId) => {
      recordedEvents.push({ type: 'role_unassigned', roleId });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeRolesRepositoryLayer = () =>
  Layer.succeed(RolesRepository, {
    findRolesByTeamId: () => Effect.succeed([]),
    findRoleById: (id: Role.RoleId) => {
      const name = roleNames.get(id);
      return Effect.succeed(
        name ? Option.some({ id, team_id: TEST_TEAM_ID, name, is_built_in: false }) : Option.none(),
      );
    },
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

const makeDiscordRoleMappingRepositoryLayer = () =>
  Layer.succeed(DiscordRoleMappingRepository, {
    findByRoleId: () => Effect.succeed(Option.none()),
    insert: () => Effect.die(new Error('Not implemented')),
    deleteByRoleId: () => Effect.void,
    findAllByTeam: (teamId: Team.TeamId) =>
      Effect.succeed(
        teamId === TEST_TEAM_ID
          ? managedMappings.map((m) => ({
              id: `mapping-${m.role_id}`,
              team_id: teamId,
              role_id: m.role_id,
              discord_role_id: m.discord_role_id,
              adopted: m.adopted ?? false,
            }))
          : [],
      ),
  } as any);

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
        ? Effect.succeed(Option.some(currentMembership))
        : Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findTeamMembersWithNames: () => Effect.succeed([]),
    findEffectiveRoleIdsForMember: (memberId: TeamMember.TeamMemberId) =>
      memberId === TEST_MEMBER_ID || memberId === TEST_MEMBER_NO_DISCORD_ID
        ? Effect.succeed(effectiveRoles)
        : Effect.succeed([]),
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
    findLastRoleSync: (memberId: TeamMember.TeamMemberId) =>
      memberId === TEST_MEMBER_ID ? Effect.succeed(priorRoleSync) : Effect.succeed(Option.none()),
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
      id === TEST_TEAM_ID || id === OTHER_TEAM_ID
        ? Option.some({
            id,
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
  Layer.provide(makeDiscordRoleMappingRepositoryLayer()),
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
  .pipe(Layer.provide(DiscordJoinEnforcementConfig.Default))
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
  currentMembership = managerMembership;
  effectiveRoles = [];
  managedMappings = [];
  recordedEvents = [];
  priorRoleSync = Option.none();
});

const syncUrl = (memberId: string) =>
  `http://localhost/teams/${TEST_TEAM_ID}/members/${memberId}/sync-discord-roles`;

const syncMember = (memberId: string, token = 'token') =>
  handler(
    new Request(syncUrl(memberId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

describe('POST /teams/:teamId/members/:memberId/sync-discord-roles', () => {
  // Blocker C (whole-series review): the web UI renders the sync button to every member, but
  // `role:manage` (the endpoint's original gate) is Admin-only — not even Captain holds it
  // (`packages/domain/src/models/Role.ts`). The self-serve carve-out below is the designer's
  // intent: a member re-syncing THEIR OWN roles is always allowed; syncing anyone else still
  // requires `role:manage`.
  it('403 for a plain member syncing a DIFFERENT member (no role:manage, not self)', async () => {
    currentMembership = playerMembership;

    const response = await syncMember(TEST_MEMBER_NO_DISCORD_ID);

    expect(response.status).toBe(403);
  });

  it('200 for a plain member syncing THEMSELVES, despite lacking role:manage', async () => {
    currentMembership = playerMembership;
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];

    const response = await syncMember(playerMembership.id);

    expect(response.status).toBe(200);
  });

  it('200 for an Admin (role:manage) syncing a member other than themselves', async () => {
    currentMembership = managerMembership;
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];

    const response = await syncMember(TEST_MEMBER_NO_DISCORD_ID);

    expect(response.status).toBe(200);
  });

  it('404 MemberNotFound for a member of another team', async () => {
    // findRosterMemberByIds filters by team_id — an id that only exists on another team
    // resolves to None here, same as a genuinely unknown id.
    const response = await handler(
      new Request(
        `http://localhost/teams/${TEST_TEAM_ID}/members/00000000-0000-0000-0000-0000000000ff/sync-discord-roles`,
        {
          method: 'POST',
          headers: { Authorization: 'Bearer token' },
        },
      ),
    );

    expect(response.status).toBe(404);
  });

  it('queues one role_assigned event per effective role and returns addedCount', async () => {
    effectiveRoles = [
      { role_id: ROLE_A, role_name: 'Captain' },
      { role_id: ROLE_B, role_name: 'Coach' },
    ];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(2);
    expect(body.removedCount).toBe(0);
    expect(body.skippedCount).toBe(0);
    expect(body.roleSyncState).toBe('queued');
    expect(recordedEvents.filter((e) => e.type === 'role_assigned')).toHaveLength(2);
  });

  it('includes group-inherited roles', () => {
    // findEffectiveRoleIdsForMember (TeamMembersRepository.ts) is the single source of truth for
    // "desired" roles and already unions member_roles with roles inherited through group
    // membership / ancestry (see the paired repository integration test). At the API layer the
    // handler only consumes whatever that query returns, so a group-inherited role is
    // indistinguishable from a directly-assigned one — both simply appear in `effectiveRoles`.
    effectiveRoles = [{ role_id: ROLE_C, role_name: 'Treasurer' }];

    return syncMember(TEST_MEMBER_ID).then(async (response) => {
      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.addedCount).toBe(1);
      expect(recordedEvents).toContainEqual({ type: 'role_assigned', roleId: ROLE_C });
    });
  });

  it('queues role_unassigned for a mapped role the member no longer has, and reports removedCount', async () => {
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];
    managedMappings = [
      { role_id: ROLE_A, discord_role_id: '1' as Discord.Snowflake },
      { role_id: ROLE_B, discord_role_id: '2' as Discord.Snowflake },
    ];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(1);
    expect(body.removedCount).toBe(1);
    expect(recordedEvents).toContainEqual({ type: 'role_unassigned', roleId: ROLE_B });
    expect(recordedEvents.filter((e) => e.type === 'role_unassigned')).toHaveLength(1);
  });

  it('never queues role_unassigned for a Discord role with no mapping', async () => {
    // The member has a role (ROLE_A) that has never been mapped to Discord (no
    // discord_role_mappings row for this team at all). Removal is computed strictly from
    // `managed` (the mapping table), so an empty mapping table must never produce an unassign —
    // this is the anti-stripping guard: Sideline never touches a Discord role it does not own.
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];
    managedMappings = [];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(1);
    expect(body.removedCount).toBe(0);
    expect(recordedEvents.filter((e) => e.type === 'role_unassigned')).toHaveLength(0);
  });

  // Blocker A (whole-series review): unlike the "no mapping at all" case above, an ADOPTED
  // mapping IS present in `managed` — it points at a pre-existing Discord role Sideline adopted
  // rather than created (`ensureMapping.ts`). A member holding it because a captain granted it
  // by hand, with no `member_roles` row, never appears in `effectiveRoles` — before this fix
  // that meant a captain clicking "sync" on ANY member stripped every adopted role that member
  // held but was never assigned through Sideline. Adoption must be as strong a stripping guard
  // as having no mapping at all.
  it('never queues role_unassigned for an adopted mapping the member holds but was never assigned', async () => {
    effectiveRoles = [];
    managedMappings = [
      { role_id: ROLE_A, discord_role_id: '1' as Discord.Snowflake, adopted: true },
    ];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    expect(recordedEvents.filter((e) => e.type === 'role_unassigned')).toHaveLength(0);
  });

  // Symmetric with the above: an adopted mapping is still eligible to be ADDED — only stripping
  // is forbidden.
  it('still queues role_assigned for an adopted mapping the member newly desires', async () => {
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];
    managedMappings = [
      { role_id: ROLE_A, discord_role_id: '1' as Discord.Snowflake, adopted: true },
    ];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(1);
    expect(body.removedCount).toBe(0);
    expect(recordedEvents).toContainEqual({ type: 'role_assigned', roleId: ROLE_A });
  });

  it('returns skippedCount: 1 and queues nothing for a member with no discord_id', async () => {
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];
    managedMappings = [{ role_id: ROLE_B, discord_role_id: '2' as Discord.Snowflake }];

    const response = await syncMember(TEST_MEMBER_NO_DISCORD_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    expect(body.skippedCount).toBe(1);
    expect(body.roleSyncState).toBe('never');
    expect(recordedEvents).toHaveLength(0);
  });

  it('returns all zero and queues nothing when there is nothing to sync', async () => {
    // `teams.guild_id` is NOT NULL in the current schema (every team is guild-linked), so "a team
    // with no guild_id" cannot occur for a team this handler can even reach — the guild-link
    // no-op lives one layer down, in RoleSyncEventsRepository._emitIfGuildLinked, and is pinned by
    // the repository integration test instead. At this layer, the externally equivalent
    // all-zero case is a member with no effective roles and no Discord role mappings.
    effectiveRoles = [];
    managedMappings = [];

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    expect(body.skippedCount).toBe(0);
    // No prior completed attempt on record — distinguishable from a prior success with nothing
    // left to do (see the "fidelity fields" describe block below).
    expect(body.roleSyncState).toBe('never');
    expect(body.lastRoleSyncAt).toBeNull();
    expect(body.lastRoleSyncError).toBeNull();
    expect(recordedEvents).toHaveLength(0);
  });

  it('is safe to call twice', async () => {
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];

    const first = await syncMember(TEST_MEMBER_ID);
    const firstBody = await first.json();
    const second = await syncMember(TEST_MEMBER_ID);
    const secondBody = await second.json();

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(firstBody.addedCount).toBe(1);
    expect(secondBody.addedCount).toBe(1);
  });

  it('caps the fan-out at the configured maximum', async () => {
    effectiveRoles = Array.from({ length: MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER + 5 }, (_, i) => ({
      role_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}` as Role.RoleId,
      role_name: `Role ${i}`,
    }));

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER);
    expect(recordedEvents).toHaveLength(MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER);
  });
});

// Closes the read side of PR-9/9b: `TeamMembersRepository.findLastRoleSync` is what fills
// `roleSyncState` / `lastRoleSyncAt` / `lastRoleSyncError` with the member's PREVIOUS completed
// attempt — a distinct axis from `addedCount`/`removedCount`, which describe THIS click's fresh
// enqueue (see `syncMemberDiscordRoles.ts`'s doc comment for the full precedence rule).
describe('POST /teams/:teamId/members/:memberId/sync-discord-roles — prior-attempt fidelity fields', () => {
  it('reports the prior failure and reason when nothing is enqueued this click', async () => {
    effectiveRoles = [];
    managedMappings = [];
    priorRoleSync = Option.some({
      state: 'failed',
      at: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      errorCode: Option.some('captain_action'),
    });

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(0);
    expect(body.removedCount).toBe(0);
    expect(body.roleSyncState).toBe('failed');
    expect(body.lastRoleSyncError).toBe('captain_action');
    expect(body.lastRoleSyncAt).not.toBeNull();
  });

  it('reports the prior success (not "never") when nothing is enqueued this click', async () => {
    effectiveRoles = [];
    managedMappings = [];
    priorRoleSync = Option.some({
      state: 'ok',
      at: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      errorCode: Option.none(),
    });

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.roleSyncState).toBe('ok');
    expect(body.lastRoleSyncError).toBeNull();
    expect(body.lastRoleSyncAt).not.toBeNull();
  });

  it('reports "queued" (not the prior failure) when this click enqueues new work, but still surfaces the prior failure reason', async () => {
    effectiveRoles = [{ role_id: ROLE_A, role_name: 'Captain' }];
    managedMappings = [];
    priorRoleSync = Option.some({
      state: 'failed',
      at: DateTime.makeUnsafe('2026-01-01T00:00:00Z'),
      errorCode: Option.some('captain_action'),
    });

    const response = await syncMember(TEST_MEMBER_ID);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.addedCount).toBe(1);
    // The headline state reflects THIS click's fresh enqueue...
    expect(body.roleSyncState).toBe('queued');
    // ...but the prior failure reason is still surfaced as context, not discarded.
    expect(body.lastRoleSyncError).toBe('captain_action');
    expect(body.lastRoleSyncAt).not.toBeNull();
  });
});
