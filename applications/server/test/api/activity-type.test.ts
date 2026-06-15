import type { ActivityType, Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
import { ActivityTypeApi } from '@sideline/domain';
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
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockEventRosterLayers } from '../mocks/eventRosterMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from '../mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// --- Test IDs ---
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_CAPTAIN_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

// Activity type IDs for test scenarios
const GLOBAL_GYM_ID = '00000000-0000-0000-0000-000000000060' as ActivityType.ActivityTypeId;
const CUSTOM_TYPE_ID = '00000000-0000-0000-0000-000000000061' as ActivityType.ActivityTypeId;
const OTHER_TEAM_CUSTOM_ID = '00000000-0000-0000-0000-000000000062' as ActivityType.ActivityTypeId;
const CUSTOM_WITH_LOGS_ID = '00000000-0000-0000-0000-000000000063' as ActivityType.ActivityTypeId;
const ADMIN_DELETE_ID = '00000000-0000-0000-0000-000000000064' as ActivityType.ActivityTypeId;

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
  'activity-type:create',
  'activity-type:delete',
  'training-type:create',
  'training-type:delete',
];
const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'role:view',
  'activity-type:create',
  'activity-type:delete',
  'training-type:create',
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

const testCaptain = {
  id: TEST_CAPTAIN_ID,
  discord_id: '11111',
  username: 'captainuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Captain User'),
  birth_date: Option.some(DateTime.makeUnsafe('1992-01-01')),
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

type UserLike = typeof testUser;

const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin as unknown as UserLike);
usersMap.set(TEST_CAPTAIN_ID, testCaptain as unknown as UserLike);

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('user-token', TEST_USER_ID);
sessionsStore.set('admin-token', TEST_ADMIN_ID);
sessionsStore.set('captain-token', TEST_CAPTAIN_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(TEST_MEMBER_ID, {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: ['Player'],
  permissions: PLAYER_PERMISSIONS,
});
membersStore.set(TEST_ADMIN_MEMBER_ID, {
  id: TEST_ADMIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: ADMIN_PERMISSIONS,
});
membersStore.set(TEST_CAPTAIN_MEMBER_ID, {
  id: TEST_CAPTAIN_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_CAPTAIN_ID,
  active: true,
  role_names: ['Captain'],
  permissions: CAPTAIN_PERMISSIONS,
});

// --- In-memory activity types store ---
type ActivityTypeRecord = {
  id: ActivityType.ActivityTypeId;
  team_id: Option.Option<Team.TeamId>;
  name: string;
  slug: Option.Option<string>;
  emoji: Option.Option<string>;
  description: Option.Option<string>;
  usageCount: number;
};

let activityTypesStore: Map<ActivityType.ActivityTypeId, ActivityTypeRecord>;

const resetStores = () => {
  activityTypesStore = new Map();
  // Global types (team_id = None, slug present)
  activityTypesStore.set(GLOBAL_GYM_ID, {
    id: GLOBAL_GYM_ID,
    team_id: Option.none(),
    name: 'Gym',
    slug: Option.some('gym'),
    emoji: Option.none(),
    description: Option.none(),
    usageCount: 0,
  });
  // Custom type for TEST_TEAM_ID
  activityTypesStore.set(CUSTOM_TYPE_ID, {
    id: CUSTOM_TYPE_ID,
    team_id: Option.some(TEST_TEAM_ID),
    name: 'Swimming',
    slug: Option.none(),
    emoji: Option.some('🏊'),
    description: Option.some('Water sport'),
    usageCount: 0,
  });
  // Custom type for OTHER_TEAM_ID (different team)
  activityTypesStore.set(OTHER_TEAM_CUSTOM_ID, {
    id: OTHER_TEAM_CUSTOM_ID,
    team_id: Option.some(TEST_OTHER_TEAM_ID),
    name: 'Archery',
    slug: Option.none(),
    emoji: Option.none(),
    description: Option.none(),
    usageCount: 0,
  });
  // Custom type for TEST_TEAM_ID with usage count > 0
  activityTypesStore.set(CUSTOM_WITH_LOGS_ID, {
    id: CUSTOM_WITH_LOGS_ID,
    team_id: Option.some(TEST_TEAM_ID),
    name: 'Volleyball',
    slug: Option.none(),
    emoji: Option.none(),
    description: Option.none(),
    usageCount: 3,
  });
  // Custom type for TEST_TEAM_ID used for admin DELETE happy-path
  activityTypesStore.set(ADMIN_DELETE_ID, {
    id: ADMIN_DELETE_ID,
    team_id: Option.some(TEST_TEAM_ID),
    name: 'Boxing',
    slug: Option.none(),
    emoji: Option.none(),
    description: Option.none(),
    usageCount: 0,
  });
};

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
  });
};

// --- Mock ActivityTypesRepository ---
const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  _tag: 'api/ActivityTypesRepository',
  findBySlug: (slug: string) => {
    const found = Array.from(activityTypesStore.values()).find(
      (t) => Option.isSome(t.slug) && Option.getOrNull(t.slug) === slug,
    );
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  findByTeamId: (teamId: Team.TeamId) => {
    const results = Array.from(activityTypesStore.values()).filter(
      (t) => Option.isNone(t.team_id) || Option.getOrNull(t.team_id) === teamId,
    );
    return Effect.succeed(results);
  },
  findById: (id: ActivityType.ActivityTypeId) => {
    const found = activityTypesStore.get(id);
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  // New methods required by Phase 5:
  findByIdScoped: (id: ActivityType.ActivityTypeId, teamId: Team.TeamId) => {
    const found = activityTypesStore.get(id);
    if (!found) return Effect.succeed(Option.none());
    // Global types (no team_id) are accessible to all teams
    if (Option.isNone(found.team_id)) return Effect.succeed(Option.some(found));
    // Scoped types only accessible to their owning team
    if (Option.getOrNull(found.team_id) === teamId) return Effect.succeed(Option.some(found));
    return Effect.succeed(Option.none());
  },
  findByNameInScope: (name: string, teamId: Team.TeamId) => {
    const lower = name.toLowerCase();
    const found = Array.from(activityTypesStore.values()).find(
      (t) =>
        t.name.toLowerCase() === lower &&
        (Option.isNone(t.team_id) || Option.getOrNull(t.team_id) === teamId),
    );
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  insertCustom: (input: {
    team_id: Team.TeamId;
    name: string;
    emoji: Option.Option<string>;
    description: Option.Option<string>;
  }) => {
    // Check uniqueness
    const lower = input.name.toLowerCase();
    const conflict = Array.from(activityTypesStore.values()).find(
      (t) =>
        t.name.toLowerCase() === lower &&
        (Option.isNone(t.team_id) || Option.getOrNull(t.team_id) === input.team_id),
    );
    if (conflict) {
      return Effect.fail(new ActivityTypeApi.ActivityTypeNameAlreadyTaken({ name: input.name }));
    }
    const id = crypto.randomUUID() as ActivityType.ActivityTypeId;
    const record: ActivityTypeRecord = {
      id,
      team_id: Option.some(input.team_id),
      name: input.name,
      slug: Option.none(),
      emoji: input.emoji,
      description: input.description,
      usageCount: 0,
    };
    activityTypesStore.set(id, record);
    return Effect.succeed(record);
  },
  updateCustom: (input: {
    id: ActivityType.ActivityTypeId;
    team_id: Team.TeamId;
    name: string;
    emoji: Option.Option<string>;
    description: Option.Option<string>;
  }) => {
    const existing = activityTypesStore.get(input.id);
    if (!existing || Option.isNone(existing.team_id)) {
      return Effect.succeed(Option.none());
    }
    if (Option.getOrNull(existing.team_id) !== input.team_id) {
      return Effect.succeed(Option.none());
    }
    const updated = {
      ...existing,
      name: input.name,
      emoji: input.emoji,
      description: input.description,
    };
    activityTypesStore.set(input.id, updated);
    return Effect.succeed(Option.some(updated));
  },
  deleteCustom: (id: ActivityType.ActivityTypeId, teamId: Team.TeamId) => {
    const existing = activityTypesStore.get(id);
    if (
      existing &&
      Option.isSome(existing.team_id) &&
      Option.getOrNull(existing.team_id) === teamId
    ) {
      activityTypesStore.delete(id);
    }
    return Effect.void;
  },
  countLogsForType: (id: ActivityType.ActivityTypeId) => {
    const type = activityTypesStore.get(id);
    return Effect.succeed(type?.usageCount ?? 0);
  },
} as any);

// --- Other mock layers (re-used from TrainingType.test.ts pattern) ---
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
  getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_PLAYER_ROLE_ID })),
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
  _tag: 'api/GroupsRepository',
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
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
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
  resetStores();
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/activity-types`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Activity Types API', () => {
  describe('GET /teams/:teamId/activity-types (list)', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(new Request(BASE));
      expect(response.status).toBe(401);
    });

    it('returns 200 with globals + customs, canAdmin:true for admin', async () => {
      const response = await handler(
        new Request(BASE, { headers: { Authorization: 'Bearer admin-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canAdmin).toBe(true);
      // Should include the global gym type and the two custom types for TEST_TEAM_ID
      expect(Array.isArray(body.activityTypes)).toBe(true);
      expect(body.activityTypes.length).toBeGreaterThanOrEqual(1);
    });

    it('returns 200 with canAdmin:true for Captain', async () => {
      const response = await handler(
        new Request(BASE, { headers: { Authorization: 'Bearer captain-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canAdmin).toBe(true);
    });

    it('returns 200 with canAdmin:false for regular member (Player)', async () => {
      const response = await handler(
        new Request(BASE, { headers: { Authorization: 'Bearer user-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canAdmin).toBe(false);
    });
  });

  describe('POST /teams/:teamId/activity-types (create)', () => {
    it('returns 201 for admin creating a new activity type', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Yoga', emoji: null, description: null }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('Yoga');
    });

    it('returns 201 for Captain creating an activity type', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'CaptainSport', emoji: null, description: null }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('CaptainSport');
    });

    it('returns 403 Forbidden for Player attempting to create an activity type', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'PlayerSport', emoji: null, description: null }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 409 ActivityTypeNameAlreadyTaken when name matches global (case-insensitive)', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          // "Gym" matches the global "Gym" type (case-insensitive)
          body: JSON.stringify({ name: 'Gym', emoji: null, description: null }),
        }),
      );
      expect(response.status).toBe(409);
    });
  });

  describe('PATCH /teams/:teamId/activity-types/:activityTypeId (update)', () => {
    it('returns 422 ActivityTypeProtected when updating a global row', async () => {
      const response = await handler(
        new Request(`${BASE}/${GLOBAL_GYM_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'HackedGym' }),
        }),
      );
      expect(response.status).toBe(422);
    });

    it('returns 404 ActivityTypeNotFound for unknown id', async () => {
      const unknownId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`${BASE}/${unknownId}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Ghost' }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 404 ActivityTypeNotFound for another team custom type (tenant scoped)', async () => {
      const response = await handler(
        new Request(`${BASE}/${OTHER_TEAM_CUSTOM_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'ShouldNotUpdate' }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 200 for Captain updating a custom activity type', async () => {
      const response = await handler(
        new Request(`${BASE}/${CUSTOM_TYPE_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'CaptainRenamed' }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('CaptainRenamed');
    });
  });

  describe('DELETE /teams/:teamId/activity-types/:activityTypeId (delete)', () => {
    it('returns 409 ActivityTypeHasLogs when usageCount > 0', async () => {
      const response = await handler(
        new Request(`${BASE}/${CUSTOM_WITH_LOGS_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(409);
    });

    it('returns 422 ActivityTypeProtected when deleting a global row', async () => {
      const response = await handler(
        new Request(`${BASE}/${GLOBAL_GYM_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(422);
    });

    it('returns 204 for admin deleting a custom type with no logs', async () => {
      const response = await handler(
        new Request(`${BASE}/${ADMIN_DELETE_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
    });

    it('returns 204 for Captain deleting a custom type with no logs', async () => {
      const response = await handler(
        new Request(`${BASE}/${CUSTOM_TYPE_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer captain-token' },
        }),
      );
      expect(response.status).toBe(204);
    });

    it('returns 409 ActivityTypeHasLogs for Captain deleting a type with logs', async () => {
      const response = await handler(
        new Request(`${BASE}/${CUSTOM_WITH_LOGS_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer captain-token' },
        }),
      );
      expect(response.status).toBe(409);
    });
  });
});
