// Plan §7 C — the server API half of "Make Event Types Custom" (Notion
// 3e393506-0818-80bd-b034-c5ff5ea668ea). Mock-repository harness, modelled on
// `applications/server/test/TrainingType.test.ts` / `test/api/activity-type.test.ts`.
//
// `api/event-type.ts` bakes `EventTypesRepository.Default` INTO the `eventType` HttpApi
// group itself (`.pipe(Layer.provide(EventTypesRepository.Default))`) rather than taking the
// repository as an external dependency the way every sibling *Type API does. That means this
// group's `EventTypesRepository` cannot be swapped for an in-memory mock from outside — the
// only seam left is the `SqlClient.SqlClient` the internal `.Default` layer itself needs. So
// this file supplies a small fake `SqlClient` that recognises the handful of literal SQL shapes
// `EventTypesRepository.ts` issues (matched by distinctive substrings — this file and that one
// must be read together) and serves them from an in-memory array, INCLUDING a synthetic
// `SqlError`/`ConstraintError` with a real `{ code: '23505' }` cause so
// `SqlErrors.catchUniqueViolation` — which walks the cause chain — actually fires. Every other
// query text (e.g. anything BankSyncApiLive's own internal default might issue) falls through to
// `Effect.succeed([])`, exactly like the inert `MockGenericSqlClientLayer` it replaces.
import type { Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { SqlClient } from 'effect/unstable/sql';
import { ConstraintError, SqlError } from 'effect/unstable/sql/SqlError';
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
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { LlmClient } from '~/services/LlmClient.js';
import {
  MockAiActionProposalsRepositoryLayer,
  MockChatAgentLayer,
  MockChatRateLimiterLayer,
} from '../mocks/aiChatMocks.js';
import { MockBankSyncLayers } from '../mocks/bankSyncMocks.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from '../mocks/playerRatingMocks.js';
import { MockRulesAttemptsRepositoryLayer } from '../mocks/rulesTrainerMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// --- Test IDs ---
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

// Seeded default event types for TEST_TEAM_ID, positions 0..5 (matches the migration's seed
// order — see `1792400000_create_event_types.ts` step 2).
const ET_TRAINING = '00000000-0000-0000-0000-000000000080';
const ET_MATCH = '00000000-0000-0000-0000-000000000081';
const ET_TOURNAMENT = '00000000-0000-0000-0000-000000000082';
const ET_MEETING = '00000000-0000-0000-0000-000000000083';
const ET_SOCIAL = '00000000-0000-0000-0000-000000000084';
const ET_OTHER = '00000000-0000-0000-0000-000000000085';
// A single seeded type for TEST_OTHER_TEAM_ID, used for cross-team 404 + reorder-foreign-id.
const ET_OTHER_TEAM = '00000000-0000-0000-0000-000000000090';

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

// --- User fixtures ---
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

const testOtherTeam = {
  id: TEST_OTHER_TEAM_ID,
  name: 'Other Team',
  guild_id: '888888888888888888' as Discord.Snowflake,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

type UserLike = typeof testUser;

const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin as unknown as UserLike);

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('user-token', TEST_USER_ID);
sessionsStore.set('admin-token', TEST_ADMIN_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS,
  is_profile_complete: true,
  require_complete_profile: Option.none(),
});
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
  is_profile_complete: true,
  require_complete_profile: Option.none(),
});

const buildRosterEntry = (
  memberId: TeamMember.TeamMemberId,
  userId: Auth.UserId,
  roleNames: readonly string[],
  permissions: readonly Role.Permission[],
): RosterEntry => {
  const user = usersMap.get(userId);
  if (!user) throw new Error(`User ${userId} not found in usersMap`);
  return new RosterEntry({
    member_id: memberId,
    user_id: userId,
    discord_id: user.discord_id as Discord.Snowflake,
    role_names: roleNames,
    permissions: permissions,
    name: user.name,
    birth_date: user.birth_date.pipe(Option.map(DateTime.formatIsoDateUtc)),
    gender: user.gender,
    jersey_number: Option.none(),
    username: user.username,
    avatar: user.avatar,
    discord_nickname: Option.none(),
    discord_display_name: Option.none(),
    joined_at: '2024-01-01T00:00:00.000Z',
    active: true,
  });
};

// ---------------------------------------------------------------------------
// Fake `event_types` table, driven by a fake `SqlClient` (see header comment).
// ---------------------------------------------------------------------------

type FakeEventTypeRow = {
  id: string;
  team_id: string;
  name: string | null;
  kind: string;
  color: string;
  position: number;
  archived_at: string | null;
  seq: number;
};

let eventTypesStore: FakeEventTypeRow[] = [];
let eventTypesSeq = 0;
let eventTypeUsageCounts = new Map<string, number>();

const mkEventType = (
  id: string,
  teamId: string,
  name: string | null,
  kind: string,
  color: string,
  position: number,
): FakeEventTypeRow => ({
  id,
  team_id: teamId,
  name,
  kind,
  color,
  position,
  archived_at: null,
  seq: eventTypesSeq++,
});

const resetEventTypesStore = () => {
  eventTypesSeq = 0;
  eventTypesStore = [
    mkEventType(ET_TRAINING, TEST_TEAM_ID, null, 'training', 'blue', 0),
    mkEventType(ET_MATCH, TEST_TEAM_ID, null, 'match', 'red', 1),
    mkEventType(ET_TOURNAMENT, TEST_TEAM_ID, null, 'tournament', 'orange', 2),
    mkEventType(ET_MEETING, TEST_TEAM_ID, null, 'meeting', 'slate', 3),
    mkEventType(ET_SOCIAL, TEST_TEAM_ID, null, 'social', 'pink', 4),
    mkEventType(ET_OTHER, TEST_TEAM_ID, null, 'other', 'gray', 5),
    mkEventType(ET_OTHER_TEAM, TEST_OTHER_TEAM_ID, null, 'training', 'blue', 0),
  ];
  // Test C2 — "usageCount populated": the training type has 3 referencing events, every
  // other type has none.
  eventTypeUsageCounts = new Map([[ET_TRAINING, 3]]);
};

const activeRows = (teamId: string) =>
  eventTypesStore.filter((r) => r.team_id === teamId && r.archived_at === null);

const nameTakenActive = (teamId: string, name: string, excludeId?: string) =>
  eventTypesStore.some(
    (r) =>
      r.team_id === teamId &&
      r.archived_at === null &&
      r.name !== null &&
      r.id !== excludeId &&
      r.name.toLowerCase() === name.toLowerCase(),
  );

// A real Postgres unique-violation shape: `SqlErrors.isUniqueViolation` walks
// `error.cause` (the SqlError's `reason`) looking for `{ code: '23505' }` on the reason itself
// or anywhere down its own `.cause` chain — `ConstraintError`'s `cause` field carries it here.
const uniqueViolation = () =>
  new SqlError({
    reason: new ConstraintError({
      cause: { code: '23505' },
      message: 'duplicate key value violates unique constraint "idx_event_types_team_name"',
    }),
  });

const toPlainRow = (r: FakeEventTypeRow) => ({
  id: r.id,
  team_id: r.team_id,
  name: r.name,
  kind: r.kind,
  color: r.color,
  position: r.position,
});

// Dispatches on distinctive substrings of the literal SQL text in
// `~/repositories/EventTypesRepository.ts` — this fake and that file must be read together.
// Any query that doesn't match one of these six shapes (e.g. some unrelated internal default
// elsewhere in the app reaching for a generic `SqlClient`) falls through to `Effect.succeed([])`,
// exactly like the inert `MockGenericSqlClientLayer` this replaces.
const fakeEventTypesSql = ((strings: TemplateStringsArray, ...values: ReadonlyArray<unknown>) => {
  const text = strings.join('');

  if (text.includes('"usageCount"')) {
    const teamId = values[0] as string;
    const rows = activeRows(teamId)
      .slice()
      .sort((a, b) => a.position - b.position || a.seq - b.seq)
      .map((r) => ({ ...toPlainRow(r), usageCount: eventTypeUsageCounts.get(r.id) ?? 0 }));
    return Effect.succeed(rows);
  }

  if (text.includes('COUNT(*)::int AS count')) {
    const teamId = values[0] as string;
    return Effect.succeed([{ count: activeRows(teamId).length }]);
  }

  if (text.includes('INSERT INTO event_types')) {
    const [teamId, name, kind, color] = values as [string, string, string, string];
    if (nameTakenActive(teamId, name)) return Effect.fail(uniqueViolation());
    const active = activeRows(teamId);
    const position = active.length > 0 ? Math.max(...active.map((r) => r.position)) + 1 : 0;
    const row = mkEventType(crypto.randomUUID(), teamId, name, kind, color, position);
    eventTypesStore.push(row);
    return Effect.succeed([toPlainRow(row)]);
  }

  if (text.includes('SET archived_at = now()')) {
    const [id, teamId] = values as [string, string];
    const row = eventTypesStore.find(
      (r) => r.id === id && r.team_id === teamId && r.archived_at === null,
    );
    if (row) row.archived_at = new Date().toISOString();
    return Effect.succeed([]);
  }

  if (text.includes('unnest(')) {
    const [ids, teamId] = values as [ReadonlyArray<string>, string];
    ids.forEach((id, index) => {
      const row = eventTypesStore.find(
        (r) => r.id === id && r.team_id === teamId && r.archived_at === null,
      );
      if (row) row.position = index;
    });
    return Effect.succeed([]);
  }

  if (text.includes('SET name =')) {
    const [name, color, id, teamId] = values as [string | null, string, string, string];
    const row = eventTypesStore.find(
      (r) => r.id === id && r.team_id === teamId && r.archived_at === null,
    );
    if (!row) return Effect.succeed([]);
    if (name !== null && nameTakenActive(teamId, name, id)) return Effect.fail(uniqueViolation());
    row.name = name;
    row.color = color;
    return Effect.succeed([toPlainRow(row)]);
  }

  // findEventTypeByIdScoped — the only remaining shape.
  if (text.includes('FROM event_types') && text.includes('WHERE id =')) {
    const [id, teamId] = values as [string, string];
    const row = eventTypesStore.find(
      (r) => r.id === id && r.team_id === teamId && r.archived_at === null,
    );
    return Effect.succeed(row ? [toPlainRow(row)] : []);
  }

  return Effect.succeed([]);
}) as unknown as SqlClient.SqlClient & { withTransaction: (effect: unknown) => unknown };
(
  fakeEventTypesSql as unknown as { withTransaction: (effect: unknown) => unknown }
).withTransaction = (effect: unknown) => effect;

const FakeEventTypesSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  fakeEventTypesSql as unknown as SqlClient.SqlClient,
);

// --- Other mock layers (re-used from TrainingType.test.ts / activity-type.test.ts pattern) ---
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
    const user = usersMap.get(id);
    return Effect.succeed(user ? Option.some(user) : Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
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
    if (id === TEST_OTHER_TEAM_ID) return Effect.succeed(Option.some(testOtherTeam));
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
  findByUser: (userId: Auth.UserId) =>
    Effect.succeed(Array.from(membersStore.values()).filter((m) => m.user_id === userId)),
  findRosterByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(
      Array.from(membersStore.values())
        .filter((m) => m.team_id === teamId && m.active)
        .map((m) => buildRosterEntry(m.id, m.user_id, m.role_names, m.permissions)),
    ),
  findRosterMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
    const member = membersStore.get(memberId);
    if (!member || member.team_id !== teamId || !member.active) {
      return Effect.succeed(Option.none());
    }
    return Effect.succeed(
      Option.some(
        buildRosterEntry(member.id, member.user_id, member.role_names, member.permissions),
      ),
    );
  },
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getDefaultRoleId: () => Effect.succeed(Option.some({ id: TEST_PLAYER_ROLE_ID })),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
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

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  findBySlug: () =>
    Effect.succeed(
      Option.some({ id: 'mock-training-type-id', name: 'Training', slug: Option.some('training') }),
    ),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  insert: () => Effect.die(new Error('not implemented')),
  findByTeamMember: () => Effect.succeed([]),
} as any);

const MockLeaderboardRepositoryLayer = Layer.succeed(LeaderboardRepository, {
  getLeaderboard: () => Effect.succeed([]),
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
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
  _tag: 'api/TrainingTypesRepository',
  findByTeamId: () => Effect.succeed([]),
  findTrainingTypesByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  findTrainingTypeById: () => Effect.succeed(Option.none()),
  findByIdWithGroup: () => Effect.succeed(Option.none()),
  findTrainingTypeByIdWithGroup: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  insertTrainingType: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateTrainingType: () => Effect.die(new Error('Not implemented')),
  deleteTrainingType: () => Effect.void,
  deleteTrainingTypeById: () => Effect.void,
} as any);

const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  updateRule: () => Effect.die(new Error('Not implemented')),
  deleteRule: () => Effect.void,
  findAllTeamsWithRules: () => Effect.succeed([]),
  findMembersWithBirthYears: () => Effect.succeed([]),
  findRulesByTeamId: () => Effect.succeed([]),
  findRuleById: () => Effect.succeed(Option.none()),
  insertRule: () => Effect.die(new Error('Not implemented')),
  updateRuleById: () => Effect.die(new Error('Not implemented')),
  deleteRuleById: () => Effect.void,
  getAllTeamsWithRules: () => Effect.succeed([]),
  getMembersForAutoAssignment: () => Effect.succeed([]),
} as any);

const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  findByUserId: () => Effect.succeed([]),
  insertOne: () => Effect.die(new Error('Not implemented')),
  markOneAsRead: () => Effect.void,
  markAllRead: () => Effect.void,
  findOneById: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed([]),
  insert: () => Effect.die(new Error('Not implemented')),
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
  _tag: 'api/OAuthConnectionsRepository',
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
  _tag: 'api/EventsRepository',
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
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
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

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: () => Effect.die(new Error('Not implemented')),
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
} as any);

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  _tag: 'api/ICalTokensRepository',
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

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
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
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockAgeCheckServiceLayer),
  Layer.provide(MockAgeThresholdRepositoryLayer),
  Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
  Layer.provide(
    Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(MockDiscordChannelMappingRepositoryLayer, MockICalTokensRepositoryLayer),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.merge(MockEventsRepositoryLayer, MockEventRsvpsRepositoryLayer),
              Layer.succeed(BotGuildsRepository, {
                upsert: () => Effect.void,
                remove: () => Effect.void,
                exists: () => Effect.succeed(false),
                findAll: () => Effect.succeed([]),
              } as any),
            ),
            Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
          ),
          MockEventSeriesRepositoryLayer,
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
  Layer.provide(MockAchievementAdminLayers),
)
  .pipe(Layer.provide(MockBankSyncLayers))
  .pipe(Layer.provide(FakeEventTypesSqlClientLayer))
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
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
  resetEventTypesStore();
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/event-types`;

const adminHeaders = {
  Authorization: 'Bearer admin-token',
  'Content-Type': 'application/json',
};
const userHeaders = {
  Authorization: 'Bearer user-token',
  'Content-Type': 'application/json',
};

// ---------------------------------------------------------------------------
// Tests — plan §7 C
// ---------------------------------------------------------------------------

describe('Event Types API', () => {
  describe('GET /teams/:teamId/event-types (list)', () => {
    it('C1 — plain member: 200, canAdmin:false, ordered by position', async () => {
      const response = await handler(new Request(BASE, { headers: userHeaders }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canAdmin).toBe(false);
      expect(body.eventTypes.map((t: any) => t.kind)).toEqual([
        'training',
        'match',
        'tournament',
        'meeting',
        'social',
        'other',
      ]);
      expect(body.eventTypes.map((t: any) => t.position)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('C2 — team:manage: canAdmin:true, usageCount populated', async () => {
      const response = await handler(new Request(BASE, { headers: adminHeaders }));
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canAdmin).toBe(true);
      const training = body.eventTypes.find((t: any) => t.kind === 'training');
      const match = body.eventTypes.find((t: any) => t.kind === 'match');
      expect(training.usageCount).toBe(3);
      expect(match.usageCount).toBe(0);
    });
  });

  describe('POST /teams/:teamId/event-types (create)', () => {
    it('C3 — without team:manage: 403', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ name: 'Beach', kind: 'training', color: 'cyan' }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('C4 — valid payload: 201, position = max+1', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Beach', kind: 'training', color: 'cyan' }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Beach');
      expect(body.kind).toBe('training');
      expect(body.color).toBe('cyan');
      // 6 seeded types at positions 0..5 → the new row is 6.
      expect(body.position).toBe(6);
    });

    it('C5 — duplicate name differing only by case: 409 EventTypeNameAlreadyTaken', async () => {
      const first = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Beach', kind: 'training', color: 'cyan' }),
        }),
      );
      expect(first.status).toBe(201);

      const second = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'BEACH', kind: 'social', color: 'pink' }),
        }),
      );
      expect(second.status).toBe(409);
      const body = await second.json();
      expect(body._tag).toBe('EventTypeNameAlreadyTaken');
    });

    it('C6 — validation: 400 for empty name, 51-char name, unknown color, unknown kind', async () => {
      const cases = [
        { name: '', kind: 'training', color: 'cyan' },
        { name: 'x'.repeat(51), kind: 'training', color: 'cyan' },
        { name: 'Beach', kind: 'training', color: 'fuchsia' },
        { name: 'Beach', kind: 'party', color: 'cyan' },
      ];
      for (const payload of cases) {
        const response = await handler(
          new Request(BASE, {
            method: 'POST',
            headers: adminHeaders,
            body: JSON.stringify(payload),
          }),
        );
        expect(response.status, JSON.stringify(payload)).toBe(400);
      }
    });
  });

  describe('PATCH /teams/:teamId/event-types/:eventTypeId (update)', () => {
    it('C7 — name + colour update: 200, kind key in payload is ignored', async () => {
      const response = await handler(
        new Request(`${BASE}/${ET_TRAINING}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Trénink', color: 'purple', kind: 'other' }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Trénink');
      expect(body.color).toBe('purple');
      // kind is immutable — the request's `kind: 'other'` must be ignored.
      expect(body.kind).toBe('training');
    });

    it('C8 — type belonging to another team: 404', async () => {
      const response = await handler(
        new Request(`${BASE}/${ET_OTHER_TEAM}`, {
          method: 'PATCH',
          headers: adminHeaders,
          body: JSON.stringify({ name: 'Hijacked' }),
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe('DELETE /teams/:teamId/event-types/:eventTypeId (delete)', () => {
    it('C9 — 2+ active types: 204, archived not deleted', async () => {
      const response = await handler(
        new Request(`${BASE}/${ET_OTHER}`, {
          method: 'DELETE',
          headers: adminHeaders,
        }),
      );
      expect(response.status).toBe(204);

      // Row is archived, not deleted — the raw store still has it.
      const row = eventTypesStore.find((r) => r.id === ET_OTHER);
      expect(row).toBeDefined();
      expect(row?.archived_at).not.toBeNull();

      // The list no longer surfaces it.
      const list = await handler(new Request(BASE, { headers: adminHeaders }));
      const body = await list.json();
      expect(body.eventTypes.some((t: any) => t.eventTypeId === ET_OTHER)).toBe(false);
    });

    it('C10 — team last active type: 409 EventTypeLastRemaining', async () => {
      const allIds = [ET_TRAINING, ET_MATCH, ET_TOURNAMENT, ET_MEETING, ET_SOCIAL, ET_OTHER];
      for (const id of allIds.slice(0, 5)) {
        const response = await handler(
          new Request(`${BASE}/${id}`, { method: 'DELETE', headers: adminHeaders }),
        );
        expect(response.status).toBe(204);
      }
      const last = await handler(
        new Request(`${BASE}/${allIds[5]}`, { method: 'DELETE', headers: adminHeaders }),
      );
      expect(last.status).toBe(409);
      const body = await last.json();
      expect(body._tag).toBe('EventTypeLastRemaining');
    });
  });

  describe('POST /teams/:teamId/event-types/reorder (reorder)', () => {
    it('C11 — full id set: 204, positions match array order', async () => {
      const order = [ET_OTHER, ET_SOCIAL, ET_MEETING, ET_TOURNAMENT, ET_MATCH, ET_TRAINING];
      const response = await handler(
        new Request(`${BASE}/reorder`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ eventTypeIds: order }),
        }),
      );
      expect(response.status).toBe(204);

      const list = await handler(new Request(BASE, { headers: adminHeaders }));
      const body = await list.json();
      expect(body.eventTypes.map((t: any) => t.eventTypeId)).toEqual(order);
      expect(body.eventTypes.map((t: any) => t.position)).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('C12 — rejects a duplicate id, a short array, and a foreign-team id', async () => {
      const full = [ET_TRAINING, ET_MATCH, ET_TOURNAMENT, ET_MEETING, ET_SOCIAL, ET_OTHER];

      const duplicate = [...full.slice(0, 5), full[0]];
      const dupResponse = await handler(
        new Request(`${BASE}/reorder`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ eventTypeIds: duplicate }),
        }),
      );
      expect(dupResponse.status).toBe(400);
      expect((await dupResponse.json())._tag).toBe('EventTypeReorderInvalid');

      const short = full.slice(0, 5);
      const shortResponse = await handler(
        new Request(`${BASE}/reorder`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ eventTypeIds: short }),
        }),
      );
      expect(shortResponse.status).toBe(400);
      expect((await shortResponse.json())._tag).toBe('EventTypeReorderInvalid');

      const foreign = [...full.slice(0, 5), ET_OTHER_TEAM];
      const foreignResponse = await handler(
        new Request(`${BASE}/reorder`, {
          method: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ eventTypeIds: foreign }),
        }),
      );
      expect(foreignResponse.status).toBe(400);
      expect((await foreignResponse.json())._tag).toBe('EventTypeReorderInvalid');
    });

    it('C13 — without team:manage: 403', async () => {
      const full = [ET_TRAINING, ET_MATCH, ET_TOURNAMENT, ET_MEETING, ET_SOCIAL, ET_OTHER];
      const response = await handler(
        new Request(`${BASE}/reorder`, {
          method: 'POST',
          headers: userHeaders,
          body: JSON.stringify({ eventTypeIds: full }),
        }),
      );
      expect(response.status).toBe(403);
    });
  });
});
