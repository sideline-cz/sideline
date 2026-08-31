import type {
  Auth,
  Discord,
  GroupModel,
  Role,
  Team,
  TeamInvite,
  TeamMember,
} from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from './mocks/playerRatingMocks.js';
import { MockRulesAttemptsRepositoryLayer } from './mocks/rulesTrainerMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none(),
  is_profile_complete: false,
  name: Option.none(),
  birth_date: Option.none(),
  gender: Option.none(),
  locale: 'en' as const,
  discord_display_name: Option.none(),
  discord_nickname: Option.none(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testAdmin = {
  id: TEST_ADMIN_ID,
  discord_id: '67890',
  username: 'adminuser',
  avatar: Option.none(),
  is_profile_complete: true,
  name: Option.some('Admin User'),
  birth_date: Option.some(DateTime.makeUnsafe('1990-01-01')),
  gender: Option.some('male' as const),
  locale: 'en' as const,
  discord_display_name: Option.none(),
  discord_nickname: Option.none(),
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

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('user-token', TEST_USER_ID);
sessionsStore.set('admin-token', TEST_ADMIN_ID);

const membersStore = new Map<string, MembershipWithRole>();
membersStore.set(`${TEST_TEAM_ID}:${TEST_ADMIN_ID}`, {
  id: '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId,
  team_id: TEST_TEAM_ID,
  user_id: TEST_ADMIN_ID,
  active: true,
  role_names: ['Admin'],
  permissions: [
    'team:manage',
    'team:invite',
    'roster:view',
    'roster:manage',
    'member:view',
    'member:edit',
    'member:remove',
    'role:view',
    'role:manage',
  ] as readonly Role.Permission[],
});

const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000040' as GroupModel.GroupId;
const TEST_OTHER_TEAM_GROUP_ID = '00000000-0000-0000-0000-000000000041' as GroupModel.GroupId;

type InviteRecord = {
  id: TeamInvite.TeamInviteId;
  team_id: Team.TeamId;
  code: string;
  active: boolean;
  created_by: Auth.UserId;
  created_at: DateTime.Utc;
  expires_at: Option.Option<DateTime.Utc>;
  group_id: Option.Option<GroupModel.GroupId>;
};

const invitesStore = new Map<string, InviteRecord>();
invitesStore.set('valid-invite', {
  id: '00000000-0000-0000-0000-000000000030' as TeamInvite.TeamInviteId,
  team_id: TEST_TEAM_ID,
  code: 'valid-invite',
  active: true,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  expires_at: Option.none(),
  group_id: Option.none(),
});
invitesStore.set('inactive-invite', {
  id: '00000000-0000-0000-0000-000000000031' as TeamInvite.TeamInviteId,
  team_id: TEST_TEAM_ID,
  code: 'inactive-invite',
  active: false,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  expires_at: Option.none(),
  group_id: Option.none(),
});
invitesStore.set('invite-with-group', {
  id: '00000000-0000-0000-0000-000000000032' as TeamInvite.TeamInviteId,
  team_id: TEST_TEAM_ID,
  code: 'invite-with-group',
  active: true,
  created_by: TEST_ADMIN_ID,
  created_at: DateTime.nowUnsafe(),
  expires_at: Option.none(),
  group_id: Option.some(TEST_GROUP_ID),
});

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
    if (id === TEST_USER_ID) return Effect.succeed(Option.some(testUser));
    if (id === TEST_ADMIN_ID) return Effect.succeed(Option.some(testAdmin));
    return Effect.succeed(Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
  updateAdminProfile: () => Effect.succeed(testUser),
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
  addMember: (input: { team_id: string; user_id: string; active: boolean }) => {
    const key = `${input.team_id}:${input.user_id}`;
    const member: MembershipWithRole = {
      id: crypto.randomUUID() as TeamMember.TeamMemberId,
      team_id: input.team_id as Team.TeamId,
      user_id: input.user_id as Auth.UserId,
      active: input.active,
      role_names: ['Player'],
      permissions: ['roster:view', 'member:view'] as readonly Role.Permission[],
    };
    membersStore.set(key, member);
    return Effect.succeed({
      id: member.id,
      team_id: input.team_id,
      user_id: input.user_id,
      active: input.active,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    });
  },
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const key = `${teamId}:${userId}`;
    const member = membersStore.get(key);
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_PLAYER_ROLE_ID })),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  // PR-9 / CC-15 — reads `discordJoinedAtStore`, mutated per-test.
  findDiscordJoinedAt: (_teamId: Team.TeamId, userId: Auth.UserId) =>
    Effect.succeed(Option.fromNullishOr(discordJoinedAtStore.get(userId))),
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: (code: string) => {
    const invite = invitesStore.get(code);
    if (invite?.active) return Effect.succeed(Option.some(invite));
    return Effect.succeed(Option.none());
  },
  findByCodeWithContext: (code: string) => {
    const invite = invitesStore.get(code);
    if (!invite?.active) return Effect.succeed(Option.none());
    const group_name =
      Option.isSome(invite.group_id) && invite.group_id.value === TEST_GROUP_ID
        ? Option.some('Test Group')
        : Option.none<string>();
    return Effect.succeed(
      Option.some({
        ...invite,
        group_name,
        inviter_username: 'adminuser',
        inviter_discord_id: Option.some('67890'),
        team_name: 'Test Team',
      }),
    );
  },
  findByTeam: (teamId: string) =>
    Effect.succeed(Array.from(invitesStore.values()).filter((i) => i.team_id === teamId)),
  listForTeam: (teamId: string) =>
    Effect.succeed(
      Array.from(invitesStore.values())
        .filter((i) => i.team_id === teamId)
        .sort((a, b) => {
          const aMs = DateTime.toEpochMillis(a.created_at);
          const bMs = DateTime.toEpochMillis(b.created_at);
          return bMs - aMs;
        })
        .map((i) => ({
          id: i.id,
          code: i.code,
          active: i.active,
          groupId: i.group_id,
          groupName:
            Option.isSome(i.group_id) && i.group_id.value === TEST_GROUP_ID
              ? Option.some('Test Group')
              : Option.none<string>(),
          inviterName: Option.some('adminuser'),
          expiresAt: i.expires_at,
          createdAt: i.created_at,
          createdBy: i.created_by,
        })),
    ),
  create: (input: {
    team_id: Team.TeamId;
    code: string;
    active: boolean;
    created_by: Auth.UserId;
    expires_at: Option.Option<DateTime.Utc>;
    group_id?: Option.Option<GroupModel.GroupId>;
  }) => {
    const invite: InviteRecord = {
      id: crypto.randomUUID() as TeamInvite.TeamInviteId,
      team_id: input.team_id,
      code: input.code,
      active: input.active,
      created_by: input.created_by,
      created_at: DateTime.nowUnsafe(),
      expires_at: input.expires_at,
      group_id: input.group_id ?? Option.none(),
    };
    invitesStore.set(invite.code, invite);
    return Effect.succeed(invite);
  },
  deactivateByTeam: () => Effect.void,
  deactivateByTeamExcept: () => Effect.void,
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
  findGroupById: (groupId: GroupModel.GroupId) => {
    if (groupId === TEST_GROUP_ID) {
      return Effect.succeed(
        Option.some({
          id: TEST_GROUP_ID,
          team_id: TEST_TEAM_ID,
          name: 'Test Group',
          parent_id: Option.none(),
          sort_order: 0,
          archived: false,
          color: Option.none(),
          created_at: DateTime.nowUnsafe(),
        }),
      );
    }
    return Effect.succeed(Option.none());
  },
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
  insert: () => Effect.die(new Error('Not implemented')),
  insertTrainingType: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateTrainingType: () => Effect.die(new Error('Not implemented')),
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
  getGrantedScopes: () => Effect.succeed(Option.some('identify guilds guilds.join')),
} as any);

const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(false),
  findAll: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.none()),
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

// ---------------------------------------------------------------------------
// PR-4 (Discord onboarding fix) — `resolveOrCreateAcceptance` recorders.
//
// `acceptancesStore` tracks the newest acceptance created per (team_invite_id,
// user_id) pair so `findOpenByUserAndInvite` / `findNewestByUserAndInvite` can
// reflect it — this is what lets the "already a member" test below observe
// CC-14's idempotent reuse instead of a hardcoded stub. `acceptancesCreateCalls`
// and `pendingGuildJoinsEnqueueCalls` pin, respectively, "does resolveOrCreateAcceptance
// avoid minting a second acceptance" (CC-14) and "does the enqueue tap actually fire"
// (S4/step 6) — both silently true today only because `enqueue`/`create` are unconditional,
// which is exactly the bug PR-4's test list (items 4, 5) exists to catch.
// ---------------------------------------------------------------------------
type AcceptanceRecord = {
  id: string;
  team_invite_id: string;
  user_id: string;
  discord_code: Option.Option<string>;
  discord_code_error_code: Option.Option<string>;
  discord_code_error_detail: Option.Option<string>;
  created_at: DateTime.Utc;
  generated_at: Option.Option<Date>;
};

const acceptancesStore = new Map<string, AcceptanceRecord>();
const acceptancesCreateCalls: Array<{ team_invite_id: string; user_id: string }> = [];
const pendingGuildJoinsEnqueueCalls: Array<{ userId: string; teamId: string }> = [];
let acceptanceIdCounter = 0;

// PR-9 / CC-15 — mutable per-user "have we observed this user in the guild" store, read by
// `MockTeamMembersRepositoryLayer.findDiscordJoinedAt` below. Keyed by `userId` alone (every
// acceptance in this describe block belongs to `TEST_TEAM_ID`), so tests 4/5 can flip a single
// user's observed-join state between requests without rebuilding the router.
const discordJoinedAtStore = new Map<string, Date>();

const acceptanceKey = (teamInviteId: string, userId: string) => `${teamInviteId}:${userId}`;

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
  Layer.provide(MockRolesRepositoryLayer),
  Layer.provide(MockGroupsRepositoryLayer),
  Layer.provide(MockTrainingTypesRepositoryLayer),
  Layer.provide(
    Layer.merge(
      MockTeamInvitesRepositoryLayer,
      Layer.merge(
        Layer.succeed(PendingGuildJoinsRepository, {
          _tag: 'api/PendingGuildJoinsRepository',
          enqueue: (userId: string, teamId: string) => {
            pendingGuildJoinsEnqueueCalls.push({ userId, teamId });
            return Effect.void;
          },
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
          requeueFailedForUser: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {
          _tag: 'api/InviteAcceptancesRepository',
          create: ({ team_invite_id, user_id }: { team_invite_id: string; user_id: string }) => {
            acceptanceIdCounter += 1;
            const record: AcceptanceRecord = {
              id: `acc-${acceptanceIdCounter}`,
              team_invite_id,
              user_id,
              discord_code: Option.none(),
              discord_code_error_code: Option.none(),
              discord_code_error_detail: Option.none(),
              created_at: DateTime.nowUnsafe(),
              generated_at: Option.none(),
            };
            acceptancesCreateCalls.push({ team_invite_id, user_id });
            acceptancesStore.set(acceptanceKey(team_invite_id, user_id), record);
            return Effect.succeed(record);
          },
          findById: (id: string) => {
            for (const record of acceptancesStore.values()) {
              if (record.id === id) return Effect.succeed(Option.some(record));
            }
            return Effect.succeed(Option.none());
          },
          // CC-14: "open" = an existing row with no terminal error code. Reads the
          // same store `create` writes, so a returning member's second join
          // observes the acceptance the first join created.
          findOpenByUserAndInvite: (userId: string, teamInviteId: string) => {
            const record = acceptancesStore.get(acceptanceKey(teamInviteId, userId));
            return Effect.succeed(
              record && Option.isNone(record.discord_code_error_code)
                ? Option.some(record)
                : Option.none(),
            );
          },
          findNewestByUserAndInvite: (userId: string, teamInviteId: string) =>
            Effect.succeed(
              Option.fromNullishOr(acceptancesStore.get(acceptanceKey(teamInviteId, userId))),
            ),
          countRecentByUserAndInvite: () => Effect.succeed(0),
          findPending: () => Effect.succeed([]),
          setDiscordCode: () => Effect.void,
          markFailed: () => Effect.void,
          findByDiscordCodeWithContext: () => Effect.succeed(Option.none()),
          // PR-9 / CC-15 — every acceptance in this describe block belongs to `TEST_TEAM_ID`.
          findTeamIdById: () => Effect.succeed(Option.some(TEST_TEAM_ID)),
        } as never),
      ),
    ),
  ),
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
              MockBotGuildsRepositoryLayer,
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
  .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
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

describe('Invite API', () => {
  // Set by the "valid token joins team" test below, consumed by the idempotent-rejoin test
  // right after it (PR-4 / CC-14) — these two tests must run in this order.
  let firstJoinAcceptanceId: string | undefined;

  it('GET /invite/:code returns team info for valid invite', async () => {
    const response = await handler(new Request('http://localhost/invite/valid-invite'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.teamName).toBe('Test Team');
    expect(body.teamId).toBe(TEST_TEAM_ID);
    expect(body.code).toBe('valid-invite');
  });

  it('GET /invite/:code returns 404 for unknown invite', async () => {
    const response = await handler(new Request('http://localhost/invite/nonexistent'));
    expect(response.status).toBe(404);
  });

  it('GET /invite/:code returns 404 for inactive invite', async () => {
    const response = await handler(new Request('http://localhost/invite/inactive-invite'));
    expect(response.status).toBe(404);
  });

  it('POST /invite/:code/join without token returns 401', async () => {
    const response = await handler(
      new Request('http://localhost/invite/valid-invite/join', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
  });

  // PR-4 test list item 1: `joinViaInvite enqueues a pending guild join when the user has
  // guilds.join`. `MockOAuthConnectionsRepositoryLayer.getGrantedScopes` always returns
  // 'identify guilds guilds.join' in this describe block, so requiresReauth is false here and
  // `pendingGuildJoins.enqueue` must fire (step 6). FAILS before PR-4 — nothing calls `enqueue`
  // in production today.
  it('POST /invite/:code/join with valid token joins team, and enqueues a pending guild join', async () => {
    const enqueueCallsBefore = pendingGuildJoinsEnqueueCalls.length;
    const response = await handler(
      new Request('http://localhost/invite/valid-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.teamId).toBe(TEST_TEAM_ID);
    expect(body.roleNames).toEqual(['Player']);
    expect(body.isProfileComplete).toBe(false);
    firstJoinAcceptanceId = body.acceptanceId;
    expect(firstJoinAcceptanceId).toBeTruthy();
    expect(pendingGuildJoinsEnqueueCalls.length).toBe(enqueueCallsBefore + 1);
  });

  // CC-14 inverts rev 2's "still returns 409" test: `Invite.AlreadyMember` is no longer raised.
  // An active member re-clicking Join is the idempotent path — `resolveOrCreateAcceptance` finds
  // the acceptance the previous test created (still "open": no error code) and reuses it.
  // Combines PR-4 test list items 3 ("idempotent for an active member with an open acceptance"),
  // 4 ("does not create a second acceptance"), and 5 ("the idempotent path DOES enqueue").
  // FAILS before PR-4 — today this 409s via the unconditional `AlreadyMember` tap.
  it('POST /invite/:code/join when already a member is idempotent — 200, reuses the open acceptance, does not create a second one, and still enqueues', async () => {
    const createCallsBefore = acceptancesCreateCalls.length;
    const enqueueCallsBefore = pendingGuildJoinsEnqueueCalls.length;
    const response = await handler(
      new Request('http://localhost/invite/valid-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBe(firstJoinAcceptanceId);
    expect(acceptancesCreateCalls.length).toBe(createCallsBefore);
    expect(pendingGuildJoinsEnqueueCalls.length).toBe(enqueueCallsBefore + 1);
  });

  // PR-4 test list item 10 — step 7's ownership check. Today `getJoinStatus` looks the
  // acceptance up by id with no owner comparison at all, so any authenticated caller holding an
  // acceptanceId gets a working Discord invite for a team they were never invited to.
  // FAILS before PR-4 (returns 200 today).
  it("GET /invite/acceptances/:acceptanceId returns 404 for another user's acceptance", async () => {
    expect(firstJoinAcceptanceId).toBeTruthy();
    const response = await handler(
      new Request(`http://localhost/invite/acceptances/${firstJoinAcceptanceId}`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  // PR-4 test list item 11 — the owner must still be able to read their own acceptance. Passes
  // both before and after PR-4 (it's the regression guard for item 10's fix).
  it('GET /invite/acceptances/:acceptanceId returns the acceptance for its owner', async () => {
    expect(firstJoinAcceptanceId).toBeTruthy();
    const response = await handler(
      new Request(`http://localhost/invite/acceptances/${firstJoinAcceptanceId}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBe(firstJoinAcceptanceId);
  });

  // PR-9 test list item 6 (rewritten from the PR-2 test of the same name): CC-3's projection
  // now carries `'bot_not_in_guild'` all the way through — `Invite.JoinStatusErrorCode` gained
  // the literal and the `→ 'unknown'` mapping in `inviteErrorWireProjection.ts` is deleted.
  it('getJoinStatus returns the true bot_not_in_guild code once that mapping is removed', async () => {
    acceptanceIdCounter += 1;
    const id = `acc-${acceptanceIdCounter}`;
    acceptancesStore.set(acceptanceKey('pr2-bot-not-in-guild-invite', TEST_USER_ID), {
      id,
      team_invite_id: 'pr2-bot-not-in-guild-invite',
      user_id: TEST_USER_ID,
      discord_code: Option.none(),
      discord_code_error_code: Option.some('bot_not_in_guild'),
      discord_code_error_detail: Option.none(),
      created_at: DateTime.nowUnsafe(),
      generated_at: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/invite/acceptances/${id}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errorCode).toBe('bot_not_in_guild');
  });

  // PR-2 test list item 11 — `'expired'` collapses to `None` permanently (CC-3): an old browser
  // with no `state` field must see `errorCode: null`, not an unrecognized literal.
  it('getJoinStatus returns errorCode None for an expired row', async () => {
    acceptanceIdCounter += 1;
    const id = `acc-${acceptanceIdCounter}`;
    acceptancesStore.set(acceptanceKey('pr2-expired-invite', TEST_USER_ID), {
      id,
      team_invite_id: 'pr2-expired-invite',
      user_id: TEST_USER_ID,
      discord_code: Option.none(),
      discord_code_error_code: Option.some('expired'),
      discord_code_error_detail: Option.none(),
      created_at: DateTime.nowUnsafe(),
      generated_at: Option.none(),
    });

    const response = await handler(
      new Request(`http://localhost/invite/acceptances/${id}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errorCode).toBeNull();
  });

  // PR-9 test list item 4 — CC-15's top-priority derivation: `discord_joined_at` set means
  // `'joined'`, regardless of what the acceptance row itself says (a `discord_code` is still
  // Some here, which would otherwise derive `'ready'`).
  it("getJoinStatus returns state 'joined' when discord_joined_at is set", async () => {
    acceptanceIdCounter += 1;
    const id = `acc-${acceptanceIdCounter}`;
    acceptancesStore.set(acceptanceKey('pr9-joined-invite', TEST_USER_ID), {
      id,
      team_invite_id: 'pr9-joined-invite',
      user_id: TEST_USER_ID,
      discord_code: Option.some('some-code'),
      discord_code_error_code: Option.none(),
      discord_code_error_detail: Option.none(),
      created_at: DateTime.nowUnsafe(),
      generated_at: Option.none(),
    });
    discordJoinedAtStore.set(TEST_USER_ID, new Date());

    const response = await handler(
      new Request(`http://localhost/invite/acceptances/${id}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('joined');

    discordJoinedAtStore.delete(TEST_USER_ID);
  });

  // PR-9 test list item 5 — pins CC-15 against the sticky-`'done'` bug rev 2 would have
  // shipped: once `Guild/RemoveMember` clears `discord_joined_at` (simulated here by removing
  // the entry from the store), the SAME acceptance row must stop reporting `'joined'`.
  it("getJoinStatus returns state 'joined' → not joined again after Guild/RemoveMember clears the timestamp", async () => {
    acceptanceIdCounter += 1;
    const id = `acc-${acceptanceIdCounter}`;
    acceptancesStore.set(acceptanceKey('pr9-left-invite', TEST_USER_ID), {
      id,
      team_invite_id: 'pr9-left-invite',
      user_id: TEST_USER_ID,
      discord_code: Option.none(),
      discord_code_error_code: Option.none(),
      discord_code_error_detail: Option.none(),
      created_at: DateTime.nowUnsafe(),
      generated_at: Option.none(),
    });
    discordJoinedAtStore.set(TEST_USER_ID, new Date());

    const joinedResponse = await handler(
      new Request(`http://localhost/invite/acceptances/${id}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect((await joinedResponse.json()).state).toBe('joined');

    // Guild/RemoveMember clears the timestamp.
    discordJoinedAtStore.delete(TEST_USER_ID);

    const afterLeaveResponse = await handler(
      new Request(`http://localhost/invite/acceptances/${id}`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(afterLeaveResponse.status).toBe(200);
    const body = await afterLeaveResponse.json();
    expect(body.state).not.toBe('joined');
  });

  it('POST /invite/:code/join with invalid code returns 404', async () => {
    const response = await handler(
      new Request('http://localhost/invite/nonexistent/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('POST /teams/:id/invite/regenerate by admin returns new invite', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invite/regenerate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBeDefined();
    expect(body.active).toBe(true);
  });

  it('POST /teams/:id/invite/regenerate by non-admin returns 403', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invite/regenerate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('POST /teams/:id/invite/regenerate by non-member returns 403', async () => {
    const nonMemberTeamId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`http://localhost/teams/${nonMemberTeamId}/invite/regenerate`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('DELETE /teams/:id/invite by admin returns 204', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invite`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(204);
  });

  it('DELETE /teams/:id/invite by non-admin returns 403', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invite`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  // -------------------------------------------------------------------------
  // New createInvite endpoint tests (TDD — added before implementation)
  // -------------------------------------------------------------------------

  it('POST /teams/:teamId/invites with groupId: null → 200 invite created without group', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invites`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ groupId: null, expiresAt: null }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBeDefined();
    expect(body.active).toBe(true);
  });

  it('POST /teams/:teamId/invites with valid groupId → 200 InviteCode returned', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invites`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ groupId: TEST_GROUP_ID, expiresAt: null }),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBeDefined();
    expect(body.active).toBe(true);
  });

  it('POST /teams/:teamId/invites with groupId from a different team → 422 InvalidGroup', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invites`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ groupId: TEST_OTHER_TEAM_GROUP_ID, expiresAt: null }),
      }),
    );
    expect(response.status).toBe(422);
  });

  it('POST /teams/:teamId/invites without permission → 403 Forbidden', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invites`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ groupId: null, expiresAt: null }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('GET /teams/:teamId/invites returns array of InviteListItem with groupName populated', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/invites`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    // The 'invite-with-group' entry should have groupName populated
    const withGroup = body.find((i: { code: string }) => i.code === 'invite-with-group');
    if (withGroup) {
      expect(withGroup.groupName).toBeTruthy();
    }
  });

  it('GET /invite/:code returns groupName and inviterName when present', async () => {
    const response = await handler(new Request('http://localhost/invite/invite-with-group'));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.code).toBe('invite-with-group');
    // groupName and inviterName should be present
    expect(body.groupName).toBeDefined();
    expect(body.inviterName).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// TDD: Handle removing user — invite re-join behaviour
// ---------------------------------------------------------------------------
// These tests verify the NEW behaviour introduced by the "Handle removing user" bug fix:
//   - A previously-removed user (active=false membership exists) re-joins via invite
//     → should call reactivateMember (NOT addMember) and return a JoinResult
//   - Already-active user → AlreadyMember (regression guard)
//   - Never-member → addMember path (regression guard)
//
// The mock layer for this suite tracks reactivateMember vs addMember calls.

describe('Invite API — removed-user re-join (TDD: Handle removing user)', () => {
  // We build a dedicated mini-test-setup for these cases to isolate the
  // reactivateMember vs addMember behaviour without touching the shared handler.

  const REJOIN_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
  const REJOIN_USER_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
  const REJOIN_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000051' as Role.RoleId;
  const REJOIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;

  const rejoinUser = {
    id: REJOIN_USER_ID,
    discord_id: '99999',
    username: 'rejoinuser',
    avatar: Option.none(),
    is_profile_complete: true,
    name: Option.none(),
    birth_date: Option.none(),
    gender: Option.none(),
    locale: 'en' as const,
    discord_display_name: Option.none(),
    discord_nickname: Option.none(),
    created_at: DateTime.nowUnsafe(),
    updated_at: DateTime.nowUnsafe(),
  };

  // Track which methods were called during the test run
  let reactivateCalled = false;
  let addMemberCalled = false;

  // Inactive membership (the "was removed" state)
  const inactiveMembership: MembershipWithRole = {
    id: REJOIN_MEMBER_ID,
    team_id: REJOIN_TEAM_ID,
    user_id: REJOIN_USER_ID,
    active: false,
    role_names: [],
    permissions: [],
  };

  const rejoinSessions = new Map<string, Auth.UserId>();
  rejoinSessions.set('rejoin-token', REJOIN_USER_ID);

  // Mock members repo that has an inactive membership for the rejoin user
  const makeRejoinMembersLayer = (
    existingMembership: Option.Option<MembershipWithRole>,
    playerRoleId: Option.Option<{ id: Role.RoleId }> = Option.some({ id: REJOIN_PLAYER_ROLE_ID }),
  ) =>
    Layer.succeed(TeamMembersRepository, {
      _tag: 'api/TeamMembersRepository',
      addMember: (_input: any) => {
        addMemberCalled = true;
        return Effect.succeed({
          id: REJOIN_MEMBER_ID,
          team_id: REJOIN_TEAM_ID,
          user_id: REJOIN_USER_ID,
          active: true,
          jersey_number: Option.none(),
          joined_at: DateTime.nowUnsafe(),
        });
      },
      reactivateMember: (_memberId: any) => {
        reactivateCalled = true;
        return Effect.succeed({
          id: REJOIN_MEMBER_ID,
          team_id: REJOIN_TEAM_ID,
          user_id: REJOIN_USER_ID,
          active: true,
          jersey_number: Option.none(),
          joined_at: DateTime.nowUnsafe(),
        });
      },
      findMembershipByIds: (
        _teamId: Team.TeamId,
        _userId: Auth.UserId,
        options?: { includeInactive?: boolean },
      ) => {
        // The fixed code calls findMembershipByIds with { includeInactive: true }
        // so that removed users are found for the reactivation path
        if (options?.includeInactive === true) {
          return Effect.succeed(existingMembership);
        }
        // Without the option, only active memberships are visible
        if (Option.isSome(existingMembership) && existingMembership.value.active === false) {
          return Effect.succeed(Option.none());
        }
        return Effect.succeed(existingMembership);
      },
      findByTeam: () => Effect.succeed([]),
      findByUser: () => Effect.succeed([]),
      findRosterByTeam: () => Effect.succeed([]),
      findRosterMemberByIds: () => Effect.succeed(Option.none()),
      deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
      getPlayerRoleId: () => Effect.succeed(playerRoleId),
      assignRole: () => Effect.void,
      unassignRole: () => Effect.void,
      setJerseyNumber: () => Effect.void,
    } as any);

  // Session mock that recognises 'rejoin-token'
  const RejoinSessionsLayer = Layer.succeed(SessionsRepository, {
    _tag: 'api/SessionsRepository',
    create: (input: { token: string; user_id: Auth.UserId }) => {
      rejoinSessions.set(input.token, input.user_id);
      return Effect.succeed({
        id: 'session-rejoin',
        user_id: input.user_id,
        token: input.token,
        expires_at: DateTime.nowUnsafe(),
        created_at: DateTime.nowUnsafe(),
      });
    },
    findByToken: (token: string) => {
      const userId = rejoinSessions.get(token);
      if (!userId) return Effect.succeed(Option.none());
      return Effect.succeed(
        Option.some({
          id: 'session-rejoin',
          user_id: userId,
          token,
          expires_at: DateTime.nowUnsafe(),
          created_at: DateTime.nowUnsafe(),
        }),
      );
    },
    deleteByToken: () => Effect.void,
  } as any);

  // Users mock that knows about the rejoin user
  const RejoinUsersLayer = Layer.succeed(UsersRepository, {
    _tag: 'api/UsersRepository',
    findById: (id: Auth.UserId) => {
      if (id === REJOIN_USER_ID) return Effect.succeed(Option.some(rejoinUser));
      if (id === TEST_ADMIN_ID) return Effect.succeed(Option.some(testAdmin));
      return Effect.succeed(Option.none());
    },
    findByDiscordId: () => Effect.succeed(Option.none()),
    upsertFromDiscord: () => Effect.succeed(rejoinUser),
    completeProfile: () => Effect.succeed(rejoinUser),
    updateLocale: () => Effect.succeed(rejoinUser),
    updateAdminProfile: () => Effect.succeed(rejoinUser),
  } as any);

  // Invite pointing to REJOIN_TEAM_ID
  const rejoinInvitesStore = new Map<string, InviteRecord>();
  rejoinInvitesStore.set('rejoin-invite', {
    id: '00000000-0000-0000-0000-000000000035' as TeamInvite.TeamInviteId,
    team_id: REJOIN_TEAM_ID,
    code: 'rejoin-invite',
    active: true,
    created_by: TEST_ADMIN_ID,
    created_at: DateTime.nowUnsafe(),
    expires_at: Option.none(),
    group_id: Option.none(),
  });

  const RejoinTeamInvitesLayer = Layer.succeed(TeamInvitesRepository, {
    _tag: 'api/TeamInvitesRepository',
    findByCode: (code: string) => {
      const invite = rejoinInvitesStore.get(code);
      if (invite?.active) return Effect.succeed(Option.some(invite));
      return Effect.succeed(Option.none());
    },
    findByCodeWithContext: (code: string) => {
      const invite = rejoinInvitesStore.get(code);
      if (!invite?.active) return Effect.succeed(Option.none());
      return Effect.succeed(
        Option.some({
          ...invite,
          group_name: Option.none<string>(),
          inviter_username: 'adminuser',
          inviter_discord_id: Option.some('67890'),
          team_name: 'Rejoin Test Team',
        }),
      );
    },
    findByTeam: () => Effect.succeed([]),
    listForTeam: () => Effect.succeed([]),
    create: () =>
      Effect.succeed({
        id: '00000000-0000-0000-0000-000000000035' as TeamInvite.TeamInviteId,
        team_id: REJOIN_TEAM_ID,
        code: 'rejoin-invite',
        active: true,
        created_by: TEST_ADMIN_ID,
        created_at: DateTime.nowUnsafe(),
        expires_at: Option.none(),
        group_id: Option.none(),
      }),
    deactivateByTeam: () => Effect.void,
    deactivateByTeamExcept: () => Effect.void,
  } as any);

  const RejoinTeamsLayer = Layer.succeed(TeamsRepository, {
    _tag: 'api/TeamsRepository',
    findById: (id: Team.TeamId) => {
      if (id === REJOIN_TEAM_ID)
        return Effect.succeed(
          Option.some({
            id: REJOIN_TEAM_ID,
            name: 'Rejoin Test Team',
            guild_id: '777777777777777777',
            created_by: TEST_ADMIN_ID,
            created_at: DateTime.nowUnsafe(),
            updated_at: DateTime.nowUnsafe(),
          }),
        );
      if (id === TEST_TEAM_ID) return Effect.succeed(Option.some(testTeam));
      return Effect.succeed(Option.none());
    },
    insert: () => Effect.succeed(testTeam),
    findByGuildId: () => Effect.succeed(Option.none()),
  } as any);

  const buildRejoinLayer = (
    existingMembership: Option.Option<MembershipWithRole>,
    recorders: {
      createCalls: Array<{ team_invite_id: string; user_id: string }>;
      enqueueCalls: Array<{ userId: string; teamId: string }>;
    } = { createCalls: [], enqueueCalls: [] },
    playerRoleId: Option.Option<{ id: Role.RoleId }> = Option.some({ id: REJOIN_PLAYER_ROLE_ID }),
  ) =>
    ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(RejoinUsersLayer),
      Layer.provide(RejoinSessionsLayer),
      Layer.provide(RejoinTeamsLayer),
      Layer.provide(makeRejoinMembersLayer(existingMembership, playerRoleId)),
      Layer.provide(
        Layer.merge(
          Layer.merge(
            Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
            MockActivityTypesRepositoryLayer,
          ),
          MockLeaderboardRepositoryLayer,
        ),
      ),
      Layer.provide(MockRolesRepositoryLayer),
      Layer.provide(MockGroupsRepositoryLayer),
      Layer.provide(MockTrainingTypesRepositoryLayer),
      Layer.provide(
        Layer.merge(
          RejoinTeamInvitesLayer,
          Layer.merge(
            Layer.succeed(PendingGuildJoinsRepository, {
              _tag: 'api/PendingGuildJoinsRepository',
              enqueue: (userId: string, teamId: string) => {
                recorders.enqueueCalls.push({ userId, teamId });
                return Effect.void;
              },
              listPending: () => Effect.succeed([]),
              markDone: () => Effect.void,
              markFailed: () => Effect.void,
              requeueFailedForUser: () => Effect.void,
            } as never),
            Layer.succeed(InviteAcceptancesRepository, {
              _tag: 'api/InviteAcceptancesRepository',
              create: ({
                team_invite_id,
                user_id,
              }: {
                team_invite_id: string;
                user_id: string;
              }) => {
                recorders.createCalls.push({ team_invite_id, user_id });
                return Effect.succeed({
                  id: `${team_invite_id}:${user_id}`,
                  team_invite_id,
                  user_id,
                  discord_code: Option.none(),
                  discord_code_error_code: Option.none(),
                  discord_code_error_detail: Option.none(),
                  created_at: DateTime.nowUnsafe(),
                  generated_at: Option.none(),
                });
              },
              findById: () => Effect.succeed(Option.none()),
              // No prior acceptance exists for any of these rejoin scenarios, so
              // resolveOrCreateAcceptance's `open` lookup is always None here (CC-14) —
              // every rejoin test that reaches this point creates exactly one acceptance.
              findOpenByUserAndInvite: () => Effect.succeed(Option.none()),
              findNewestByUserAndInvite: () => Effect.succeed(Option.none()),
              countRecentByUserAndInvite: () => Effect.succeed(0),
              findPending: () => Effect.succeed([]),
              setDiscordCode: () => Effect.void,
              markFailed: () => Effect.void,
              findByDiscordCodeWithContext: () => Effect.succeed(Option.none()),
            } as never),
          ),
        ),
      ),
      Layer.provide(MockHttpClientLayer),
      Layer.provide(MockAgeCheckServiceLayer),
      Layer.provide(MockAgeThresholdRepositoryLayer),
      Layer.provide(
        Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer),
      ),
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
                  MockBotGuildsRepositoryLayer,
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
      .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
      .pipe(Layer.provide(MockChannelManagementLayers))
      .pipe(Layer.provide(MockEmailLayers))
      .pipe(Layer.provide(MockEventRosterLayers))
      .pipe(Layer.provide(BotInfoStore.Default))
      .pipe(
        Layer.provide(
          Layer.succeed(GlobalAdminAllowlist, {
            asEffect: Effect.succeed(new Set<string>()),
          } as any),
        ),
      );

  it('removed user re-joins via invite — reactivateMember is called, NOT addMember, returns JoinResult', async () => {
    reactivateCalled = false;
    addMemberCalled = false;

    const rejoinApp = HttpRouter.toWebHandler(buildRejoinLayer(Option.some(inactiveMembership)));
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.teamId).toBe(REJOIN_TEAM_ID);
    // The fix: reactivateMember must be called, not addMember
    expect(reactivateCalled).toBe(true);
    expect(addMemberCalled).toBe(false);
  });

  // CC-14 inverts this test (it used to assert 409 — see git history / rev 2). PR-4 test list
  // item 7: "an active member with no acceptance at all gets a new acceptance" — the pre-feature
  // cohort. `Invite.AlreadyMember` is no longer raised; an active member re-clicking Join with no
  // prior acceptance gets a freshly created one instead of a permanent dead end.
  // FAILS before PR-4 (this scenario 409s today).
  it('already-active user with no prior acceptance gets a new acceptance — 200, not 409 (CC-14)', async () => {
    reactivateCalled = false;
    addMemberCalled = false;
    const recorders = { createCalls: [], enqueueCalls: [] };

    const activeMembership2: MembershipWithRole = {
      ...inactiveMembership,
      active: true,
    };

    const rejoinApp = HttpRouter.toWebHandler(
      buildRejoinLayer(Option.some(activeMembership2), recorders),
    );
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBeTruthy();
    // Neither reactivateMember nor addMember runs for an already-active member — only the
    // acceptance-resolution tail (resolveOrCreateAcceptance + enqueue) is new here.
    expect(reactivateCalled).toBe(false);
    expect(addMemberCalled).toBe(false);
    expect(recorders.createCalls.length).toBe(1);
    expect(recorders.enqueueCalls.length).toBe(1);
  });

  it('never-member user calls addMember + assignRole, returns JoinResult — regression guard', async () => {
    reactivateCalled = false;
    addMemberCalled = false;

    const rejoinApp = HttpRouter.toWebHandler(buildRejoinLayer(Option.none()));
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.teamId).toBe(REJOIN_TEAM_ID);
    expect(addMemberCalled).toBe(true);
    expect(reactivateCalled).toBe(false);
  });

  // Should-fix 5 regression (third review of PR-4, invite.ts:83): `getPlayerRoleId` returning
  // `Option.none()` (team renamed/deleted its "Player" role) must no longer fail the request
  // for an already-active member re-joining — the assignRole tap is skipped entirely for that
  // cohort, so a missing role has nothing to bite. Before the fix, `playerRole` was consumed
  // unconditionally above the tap and 404'd every idempotent re-join for such a team.
  // FAILS if the `getPlayerRoleId` change in invite.ts is reverted (404s InviteNotFound instead
  // of returning the existing acceptance).
  it('already-active member re-joins a team with no "Player" role — 200, returns existing acceptance', async () => {
    reactivateCalled = false;
    addMemberCalled = false;
    const recorders = { createCalls: [], enqueueCalls: [] };

    const activeMembershipNoRole: MembershipWithRole = {
      ...inactiveMembership,
      active: true,
    };

    const rejoinApp = HttpRouter.toWebHandler(
      buildRejoinLayer(Option.some(activeMembershipNoRole), recorders, Option.none()),
    );
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBeTruthy();
    expect(reactivateCalled).toBe(false);
    expect(addMemberCalled).toBe(false);
    expect(recorders.createCalls.length).toBe(1);
  });

  // Should-fix 5 regression, other side of the guard (invite.ts:104-115): a new member (or a
  // reactivated one — both take the `assignRole` tap) joining a team with no "Player" role must
  // still fail `InviteNotFound`. The role is genuinely required here since `assignRole` is about
  // to run, so this path must keep failing closed.
  // Passes both before and after the invite.ts fix — this pins that the guard was not weakened.
  it('new member joins a team with no "Player" role — still fails InviteNotFound', async () => {
    reactivateCalled = false;
    addMemberCalled = false;

    const rejoinApp = HttpRouter.toWebHandler(
      buildRejoinLayer(Option.none(), { createCalls: [], enqueueCalls: [] }, Option.none()),
    );
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(404);
    expect(addMemberCalled).toBe(true);
    expect(reactivateCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// TDD for PR-4 (Discord onboarding fix) — `resolveOrCreateAcceptance` (CC-14) and
// the requiresReauth / enqueue gating (S4/S5). See
// `.work-plans/discord-onboarding-fix-plan.md`, PR-4 section, test list items 2, 6, 8, 9.
//
// This suite uses its own dedicated layer (mirroring the "removed-user re-join" suite
// above) driven by a single mutable `scenario` object, so each test can independently
// control:
//   - whether the caller already has an open/newest/rate-limited acceptance
//     (`resolveOrCreateAcceptance`'s three-way branch, CC-14)
//   - whether the caller currently holds the `guilds.join` OAuth scope (requiresReauth,
//     which gates the enqueue tap per S4/step 6)
//
// All tests here are expected to FAIL against current code: `resolveOrCreateAcceptance`
// does not exist yet, `joinViaInvite` unconditionally calls `acceptances.create` (never
// consults an "open" acceptance) and unconditionally raises `AlreadyMember` for any active
// membership before ever reaching the acceptance/enqueue logic.
// ---------------------------------------------------------------------------
describe('Invite API — resolveOrCreateAcceptance / requiresReauth gating (TDD: PR-4 CC-14)', () => {
  const PR4_TEAM_ID = '00000000-0000-0000-0000-000000000013' as Team.TeamId;
  const PR4_ROLE_ID = '00000000-0000-0000-0000-000000000052' as Role.RoleId;
  const PR4_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
  const PR4_INVITE_ID = '00000000-0000-0000-0000-000000000036' as TeamInvite.TeamInviteId;
  const PR4_INVITE_CODE = 'pr4-invite';

  const pr4ActiveMembership: MembershipWithRole = {
    id: PR4_MEMBER_ID,
    team_id: PR4_TEAM_ID,
    user_id: TEST_USER_ID,
    active: true,
    role_names: ['Player'],
    permissions: [],
  };

  type Pr4AcceptanceRecord = {
    id: string;
    team_invite_id: string;
    user_id: string;
    discord_code: Option.Option<string>;
    discord_code_error_code: Option.Option<string>;
  };

  // Mutated by each `it` before dispatching a request; read by the mock layer's closures.
  let scenario: {
    findOpen: Option.Option<Pr4AcceptanceRecord>;
    findNewest: Option.Option<Pr4AcceptanceRecord>;
    countRecent: number;
    grantedScopes: Option.Option<string>;
  };
  let pr4CreateCalls: Array<{ team_invite_id: string; user_id: string }>;
  let pr4EnqueueCalls: Array<{ userId: string; teamId: string }>;
  let pr4AssignRoleCalls: Array<{ memberId: string; roleId: string }>;
  let pr4CountRecentCalls: Array<{ userId: string; teamInviteId: string }>;
  let pr4CreatedIdCounter: number;

  const resetScenario = () => {
    scenario = {
      findOpen: Option.none(),
      findNewest: Option.none(),
      countRecent: 0,
      grantedScopes: Option.some('identify guilds guilds.join'),
    };
    pr4CreateCalls = [];
    pr4EnqueueCalls = [];
    pr4AssignRoleCalls = [];
    pr4CountRecentCalls = [];
    pr4CreatedIdCounter = 0;
  };
  resetScenario();

  const Pr4TeamMembersLayer = Layer.succeed(TeamMembersRepository, {
    _tag: 'api/TeamMembersRepository',
    findMembershipByIds: () => Effect.succeed(Option.some(pr4ActiveMembership)),
    addMember: () => Effect.die(new Error('Not expected — caller is already an active member')),
    reactivateMember: () =>
      Effect.die(new Error('Not expected — caller is already an active member')),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findRosterMemberByIds: () => Effect.succeed(Option.none()),
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    getPlayerRoleId: () => Effect.succeed(Option.some({ id: PR4_ROLE_ID })),
    assignRole: (memberId: string, roleId: string) => {
      pr4AssignRoleCalls.push({ memberId, roleId });
      return Effect.void;
    },
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
  } as any);

  const Pr4TeamInvitesLayer = Layer.succeed(TeamInvitesRepository, {
    _tag: 'api/TeamInvitesRepository',
    findByCode: (code: string) =>
      code === PR4_INVITE_CODE
        ? Effect.succeed(
            Option.some({
              id: PR4_INVITE_ID,
              team_id: PR4_TEAM_ID,
              code: PR4_INVITE_CODE,
              active: true,
              created_by: TEST_ADMIN_ID,
              created_at: DateTime.nowUnsafe(),
              expires_at: Option.none(),
              group_id: Option.none(),
            }),
          )
        : Effect.succeed(Option.none()),
    findByCodeWithContext: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    listForTeam: () => Effect.succeed([]),
    create: () => Effect.die(new Error('Not implemented')),
    deactivateByTeam: () => Effect.void,
    deactivateByTeamExcept: () => Effect.void,
  } as any);

  const Pr4PendingGuildJoinsLayer = Layer.succeed(PendingGuildJoinsRepository, {
    _tag: 'api/PendingGuildJoinsRepository',
    enqueue: (userId: string, teamId: string) => {
      pr4EnqueueCalls.push({ userId, teamId });
      return Effect.void;
    },
    listPending: () => Effect.succeed([]),
    markDone: () => Effect.void,
    markFailed: () => Effect.void,
    requeueFailedForUser: () => Effect.void,
  } as never);

  const Pr4InviteAcceptancesLayer = Layer.succeed(InviteAcceptancesRepository, {
    _tag: 'api/InviteAcceptancesRepository',
    create: ({ team_invite_id, user_id }: { team_invite_id: string; user_id: string }) => {
      pr4CreatedIdCounter += 1;
      pr4CreateCalls.push({ team_invite_id, user_id });
      return Effect.succeed({
        id: `pr4-created-${pr4CreatedIdCounter}`,
        team_invite_id,
        user_id,
        discord_code: Option.none(),
        discord_code_error_code: Option.none(),
        discord_code_error_detail: Option.none(),
        created_at: DateTime.nowUnsafe(),
        generated_at: Option.none(),
      });
    },
    findById: () => Effect.succeed(Option.none()),
    findOpenByUserAndInvite: () => Effect.succeed(scenario.findOpen),
    findNewestByUserAndInvite: () => Effect.succeed(scenario.findNewest),
    // BLOCKER 1 (third review of PR-4): records its arguments so tests can pin that
    // `resolveOrCreateAcceptance` scopes the rate-limit lookup to THIS invite, not just the
    // user — see the "does not count acceptances for other invites" test below.
    countRecentByUserAndInvite: (userId: string, teamInviteId: string) => {
      pr4CountRecentCalls.push({ userId, teamInviteId });
      return Effect.succeed(scenario.countRecent);
    },
    findPending: () => Effect.succeed([]),
    setDiscordCode: () => Effect.void,
    markFailed: () => Effect.void,
    findByDiscordCodeWithContext: () => Effect.succeed(Option.none()),
  } as never);

  const Pr4OAuthConnectionsLayer = Layer.succeed(OAuthConnectionsRepository, {
    _tag: 'api/OAuthConnectionsRepository',
    upsertConnection: () => Effect.succeed({} as never),
    upsert: () => Effect.succeed({} as never),
    findByUserAndProvider: () => Effect.succeed(Option.none()),
    findByUser: () => Effect.succeed(Option.none()),
    findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
    getAccessToken: () => Effect.succeed('mock-access-token'),
    getGrantedScopes: () => Effect.succeed(scenario.grantedScopes),
  } as any);

  const Pr4Layer = ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(MockDiscordOAuthLayer),
    Layer.provide(MockUsersRepositoryLayer),
    Layer.provide(MockSessionsRepositoryLayer),
    Layer.provide(MockTeamsRepositoryLayer),
    Layer.provide(Pr4TeamMembersLayer),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
          MockActivityTypesRepositoryLayer,
        ),
        MockLeaderboardRepositoryLayer,
      ),
    ),
    Layer.provide(MockRolesRepositoryLayer),
    Layer.provide(MockGroupsRepositoryLayer),
    Layer.provide(MockTrainingTypesRepositoryLayer),
    Layer.provide(
      Layer.merge(
        Pr4TeamInvitesLayer,
        Layer.merge(Pr4PendingGuildJoinsLayer, Pr4InviteAcceptancesLayer),
      ),
    ),
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
                MockBotGuildsRepositoryLayer,
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
        Pr4OAuthConnectionsLayer,
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
    .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
      ),
    );

  let pr4Handler: (...args: any[]) => Promise<Response>;
  let pr4Dispose: () => Promise<void>;

  beforeAll(() => {
    const app = HttpRouter.toWebHandler(Pr4Layer);
    pr4Handler = app.handler;
    pr4Dispose = app.dispose;
  });

  afterAll(async () => {
    await pr4Dispose();
  });

  const joinPr4Invite = () =>
    pr4Handler(
      new Request(`http://localhost/invite/${PR4_INVITE_CODE}/join`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );

  // PR-4 test list item 2: "joinViaInvite does NOT enqueue when the user lacks guilds.join" —
  // requiresReauth: true, enqueue recorder empty. FAILS before PR-4: today the handler
  // unconditionally raises AlreadyMember for an active member before ever computing
  // requiresReauth or touching the enqueue tap, so this never gets the chance to prove the
  // *right* thing (recorder empty for the *right* reason) — it 409s instead of returning 200
  // with requiresReauth: true.
  it('does NOT enqueue when the user lacks guilds.join (requiresReauth: true)', async () => {
    resetScenario();
    scenario.grantedScopes = Option.none(); // no OAuth connection at all → requiresReauth true

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.requiresReauth).toBe(true);
    expect(pr4EnqueueCalls.length).toBe(0);
  });

  // Must-fix 7 (review of PR-4): `assignRole` now runs unconditionally, whereas the removed
  // `AlreadyMember` tap previously short-circuited above it. A captain or coach without the
  // Player role who re-opens their own team's invite link would silently gain it. `assignRole`
  // must be skipped for a returning ACTIVE member — only a new member or a reactivated member
  // should get the Player role assigned. FAILS before the fix (today's code always calls
  // `assignRole`, so this test's `pr4AssignRoleCalls` recorder is non-empty).
  it('does NOT assign the Player role to a returning active member', async () => {
    resetScenario();

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    expect(pr4AssignRoleCalls.length).toBe(0);
  });

  // PR-4 test list item 6: "an active member whose newest acceptance is terminally failed gets
  // a NEW acceptance" — this is the regenerate primitive, and it inverts rev 2's "still returns
  // 409" test. FAILS before PR-4 (409s today; resolveOrCreateAcceptance doesn't exist).
  it('an active member whose newest acceptance is terminally failed gets a NEW acceptance', async () => {
    resetScenario();
    scenario.findOpen = Option.none(); // the failed row is not "open"
    scenario.findNewest = Option.some({
      id: 'pr4-failed-1',
      team_invite_id: PR4_INVITE_ID,
      user_id: TEST_USER_ID,
      discord_code: Option.none(),
      discord_code_error_code: Option.some('bot_missing_perms' as never),
    });
    scenario.countRecent = 0;

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pr4CreateCalls.length).toBe(1);
    expect(body.acceptanceId).toBe('pr4-created-1');
    expect(body.acceptanceId).not.toBe('pr4-failed-1');
  });

  // PR-4 test list item 8: "the 4th regeneration within an hour reuses the newest row instead of
  // creating" — CC-14's rate limit (≤3/hour/user). Exceeding it does not error; it silently
  // returns the newest existing (failed/expired) row unchanged. FAILS before PR-4 (this rate
  // limit does not exist yet — today's code always creates, and 409s here besides).
  it('the 4th regeneration within an hour reuses the newest row instead of creating — no error', async () => {
    resetScenario();
    scenario.findOpen = Option.none();
    scenario.findNewest = Option.some({
      id: 'pr4-rate-limited-1',
      team_invite_id: PR4_INVITE_ID,
      user_id: TEST_USER_ID,
      discord_code: Option.none(),
      discord_code_error_code: Option.some('bot_missing_perms' as never),
    });
    scenario.countRecent = 3; // at the cap

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pr4CreateCalls.length).toBe(0);
    expect(body.acceptanceId).toBe('pr4-rate-limited-1');
  });

  // BLOCKER 1 (third review of PR-4): pins the plumbing fix directly — the SQL semantics are
  // covered by the repository-level regression test (four-squads scenario) in
  // `test/integration/repositories/InviteAcceptancesRepository.test.ts`; this pins that
  // `joinViaInvite` passes THIS invite's id through to the rate-limit lookup rather than, say,
  // a user-only key. FAILS before the fix (the pre-fix helper never took an invite id at all).
  it('scopes the rate-limit lookup to this invite (not just the user)', async () => {
    resetScenario();

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    expect(pr4CountRecentCalls).toEqual([{ userId: TEST_USER_ID, teamInviteId: PR4_INVITE_ID }]);
  });

  // BLOCKER 1 (third review of PR-4): the OLD rate limit counted every acceptance the user
  // created in the last hour across ALL invites, which is bypassable in the exact opposite
  // direction of a real fix — a user who had recently joined three OTHER invites got failed
  // CLOSED (no acceptance, no banner, no error — the reported production bug) on the very
  // FIRST click of an invite they had never touched. The fix scopes both the count and the
  // lookup to the same (user, invite) pair (see the repository-level regression test in
  // `test/integration/repositories/InviteAcceptancesRepository.test.ts`), which makes hitting
  // the cap for THIS invite PROVE a newest row already exists for it — `findNewestByUserAndInvite`
  // returning `None` while `countRecentByUserAndInvite` says the cap is hit is therefore an
  // invariant violation, not a legitimate state. `resolveOrCreateAcceptance` now surfaces that
  // as a defect (`LogicError.die`) rather than silently returning a `JoinResult` with no
  // acceptance, so this models the (unreachable in production) violation via the mock and pins
  // that the request fails loudly instead of the pre-fix silent-nothing bug.
  it('a rate-limit/lookup invariant violation surfaces as a defect, not a silently missing acceptance', async () => {
    resetScenario();
    scenario.findOpen = Option.none();
    scenario.findNewest = Option.none(); // models an impossible state — see comment above
    scenario.countRecent = 3; // at the cap

    const response = await joinPr4Invite();

    expect(response.status).toBeGreaterThanOrEqual(500);
    expect(pr4CreateCalls.length).toBe(0);
  });

  // PR-4 test list item 9: "joinViaInvite reuses an acceptance that already has a discord_code"
  // — the link is still usable; a row with a discord_code is still "open" (only a
  // discord_code_error_code makes it terminal). FAILS before PR-4 (409s today).
  it('reuses an acceptance that already has a discord_code — the link is still usable', async () => {
    resetScenario();
    scenario.findOpen = Option.some({
      id: 'pr4-already-generated-1',
      team_invite_id: PR4_INVITE_ID,
      user_id: TEST_USER_ID,
      discord_code: Option.some('already-generated-code'),
      discord_code_error_code: Option.none(),
    });

    const response = await joinPr4Invite();

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(pr4CreateCalls.length).toBe(0);
    expect(body.acceptanceId).toBe('pr4-already-generated-1');
  });
});

// ---------------------------------------------------------------------------
// TDD for PR-5 (Discord onboarding fix) — durable link surface + the
// regenerate endpoint. See `.work-plans/discord-onboarding-fix-plan.md`,
// PR-5 test list items 1-15.
//
// NONE of the following exists yet, so every test below MUST FAIL against
// current code:
//   - `Invite.JoinStatus.state` (domain) — `getJoinStatus` only returns
//     `discordInviteUrl` + `errorCode` today, never `state`.
//   - `GET /teams/:teamId/me/discord-join` (`getMyPendingDiscordJoin`).
//   - `POST /teams/:teamId/me/discord-join` (`regenerateMyDiscordInvite`).
//   - `InviteAcceptancesRepository.findOpenByUserAndTeam`.
//   - `applications/server/src/utils/joinStatusState.ts`.
// The two new routes 404 today (nothing in `InviteApiGroup` declares them),
// and the existing `getJoinStatus` response body never has a `state` key.
//
// SPEC GAP flagged for the architect: CC-3 puts `'expired'` / `'bot_not_in_guild'`
// on the STORED `Onboarding.InviteGeneratorErrorCode` enum in PR-2, and CC-4's
// derived-expiry window constants live in `inviteExpiry.ts`, created in PR-3.
// Neither PR-2 nor PR-3 has merged in this checkout (only PR-4, `aa1ed611`,
// has — see `git log -- applications/server/src/utils/resolveOrCreateAcceptance.ts`).
// Tests 4 and 6 below are written to the PR-5 spec regardless: the mock
// repository below stores `discord_code_error_code` as a plain `Option<string>`
// with no schema validation, so seeding it with `'expired'` compiles and runs
// fine here. A REAL implementation reading `invite_acceptances` through
// `InviteAcceptance.InviteAcceptance` (a `SELECT *` decode against
// `Onboarding.InviteGeneratorErrorCode`) cannot write or read an `'expired'`
// row until that stored enum is widened — that widening is out of scope for
// this test file and must land before or alongside PR-5's server code.
// ---------------------------------------------------------------------------

describe('Invite API — PR-5 durable link surface + regenerate endpoint (TDD)', () => {
  const PR5_TEAM_ID = '00000000-0000-0000-0000-000000000014' as Team.TeamId;
  const PR5_OTHER_MEMBER_ID = '00000000-0000-0000-0000-000000000023' as TeamMember.TeamMemberId;
  const PR5_INVITE_ID = '00000000-0000-0000-0000-000000000037' as TeamInvite.TeamInviteId;
  const PR5_INVITE_CODE = 'pr5-invite';

  type Pr5AcceptanceRecord = {
    id: string;
    team_invite_id: string;
    user_id: string;
    discord_code: Option.Option<string>;
    discord_code_error_code: Option.Option<string>;
    created_at: DateTime.Utc;
  };

  const freshRecord = (overrides: Partial<Pr5AcceptanceRecord> = {}): Pr5AcceptanceRecord => ({
    id: 'pr5-default-id',
    team_invite_id: PR5_INVITE_ID,
    user_id: TEST_USER_ID,
    discord_code: Option.none(),
    discord_code_error_code: Option.none(),
    created_at: DateTime.nowUnsafe(),
    ...overrides,
  });

  // Mutated by each `it` before dispatching a request; read by the mock layer's closures.
  let scenario: {
    isMember: boolean;
    // GET /invite/acceptances/:acceptanceId (existing endpoint — tests 1-6)
    findById: Option.Option<Pr5AcceptanceRecord>;
    // GET /teams/:teamId/me/discord-join (tests 7-9), keyed per calling user so a
    // cross-user leak (test 9) is observable rather than hidden by a single shared value.
    findOpenByUserAndTeamByUser: Map<string, Option.Option<Pr5AcceptanceRecord>>;
    // POST /teams/:teamId/me/discord-join → resolveOrCreateAcceptance (tests 10-15)
    findOpenByUserAndInvite: Option.Option<Pr5AcceptanceRecord>;
    findNewestByUserAndInvite: Option.Option<Pr5AcceptanceRecord>;
    countRecent: number;
    activeInvite: Option.Option<{ id: string; team_id: string }>;
  };
  let pr5CreateCalls: Array<{ team_invite_id: string; user_id: string }>;
  let pr5EnqueueCalls: Array<{ userId: string; teamId: string }>;
  let pr5FindOpenByUserAndTeamCalls: Array<{ userId: string; teamId: string }>;
  let pr5CreatedIdCounter: number;

  const resetPr5Scenario = () => {
    scenario = {
      isMember: true,
      findById: Option.none(),
      findOpenByUserAndTeamByUser: new Map(),
      findOpenByUserAndInvite: Option.none(),
      findNewestByUserAndInvite: Option.none(),
      countRecent: 0,
      activeInvite: Option.some({ id: PR5_INVITE_ID, team_id: PR5_TEAM_ID }),
    };
    pr5CreateCalls = [];
    pr5EnqueueCalls = [];
    pr5FindOpenByUserAndTeamCalls = [];
    pr5CreatedIdCounter = 0;
  };
  resetPr5Scenario();

  const pr5Membership: MembershipWithRole = {
    id: PR5_OTHER_MEMBER_ID,
    team_id: PR5_TEAM_ID,
    user_id: TEST_USER_ID,
    active: true,
    role_names: ['Player'],
    permissions: [],
  };

  const Pr5TeamMembersLayer = Layer.succeed(TeamMembersRepository, {
    _tag: 'api/TeamMembersRepository',
    findMembershipByIds: (_teamId: string, userId: string) =>
      Effect.succeed(
        scenario.isMember ? Option.some({ ...pr5Membership, user_id: userId }) : Option.none(),
      ),
    addMember: () => Effect.die(new Error('Not expected in PR-5 tests')),
    reactivateMember: () => Effect.die(new Error('Not expected in PR-5 tests')),
    findByTeam: () => Effect.succeed([]),
    findByUser: () => Effect.succeed([]),
    findRosterByTeam: () => Effect.succeed([]),
    findRosterMemberByIds: () => Effect.succeed(Option.none()),
    deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
    getPlayerRoleId: () => Effect.succeed(Option.none()),
    assignRole: () => Effect.void,
    unassignRole: () => Effect.void,
    setJerseyNumber: () => Effect.void,
    // PR-9 / CC-15 — none of the PR-5 scenarios below exercise the 'joined' derivation.
    findDiscordJoinedAt: () => Effect.succeed(Option.none()),
  } as any);

  const Pr5TeamInvitesLayer = Layer.succeed(TeamInvitesRepository, {
    _tag: 'api/TeamInvitesRepository',
    findByCode: (code: string) =>
      code === PR5_INVITE_CODE
        ? Effect.succeed(
            Option.some({
              id: PR5_INVITE_ID,
              team_id: PR5_TEAM_ID,
              code: PR5_INVITE_CODE,
              active: true,
              created_by: TEST_ADMIN_ID,
              created_at: DateTime.nowUnsafe(),
              expires_at: Option.none(),
              group_id: Option.none(),
            }),
          )
        : Effect.succeed(Option.none()),
    findByCodeWithContext: () => Effect.succeed(Option.none()),
    findByTeam: () => Effect.succeed([]),
    listForTeam: () => Effect.succeed([]),
    create: () => Effect.die(new Error('Not implemented')),
    deactivateByTeam: () => Effect.void,
    deactivateByTeamExcept: () => Effect.void,
    // Net-new for PR-5 step 5/8 — `regenerateMyDiscordInvite` resolves the team's active
    // invite through this before calling `resolveOrCreateAcceptance`. Does not exist on the
    // real repository yet; the mock accepts it anyway (`as any`) so this layer can drive
    // both "has an active invite" and "no active invite" (test 15) scenarios.
    findActiveByTeamId: (_teamId: string) => Effect.succeed(scenario.activeInvite),
  } as any);

  const Pr5PendingGuildJoinsLayer = Layer.succeed(PendingGuildJoinsRepository, {
    _tag: 'api/PendingGuildJoinsRepository',
    enqueue: (userId: string, teamId: string) => {
      pr5EnqueueCalls.push({ userId, teamId });
      return Effect.void;
    },
    listPending: () => Effect.succeed([]),
    markDone: () => Effect.void,
    markFailed: () => Effect.void,
    requeueFailedForUser: () => Effect.void,
  } as never);

  const Pr5InviteAcceptancesLayer = Layer.succeed(InviteAcceptancesRepository, {
    _tag: 'api/InviteAcceptancesRepository',
    create: ({ team_invite_id, user_id }: { team_invite_id: string; user_id: string }) => {
      pr5CreatedIdCounter += 1;
      const record = {
        id: `pr5-created-${pr5CreatedIdCounter}`,
        team_invite_id,
        user_id,
        discord_code: Option.none(),
        discord_code_error_code: Option.none(),
        discord_code_error_detail: Option.none(),
        created_at: DateTime.nowUnsafe(),
        generated_at: Option.none(),
      };
      pr5CreateCalls.push({ team_invite_id, user_id });
      return Effect.succeed(record);
    },
    findById: (_id: string) => Effect.succeed(scenario.findById),
    // Net-new for PR-5 (repository step 5) — `getMyPendingDiscordJoin` reads through this.
    // Records every call so test 9 can prove the handler queries with the CALLING user's
    // own id rather than anything request-controlled, and that two different callers get
    // two independently-scoped answers instead of one shared lookup.
    findOpenByUserAndTeam: (userId: string, teamId: string) => {
      pr5FindOpenByUserAndTeamCalls.push({ userId, teamId });
      return Effect.succeed(scenario.findOpenByUserAndTeamByUser.get(userId) ?? Option.none());
    },
    findOpenByUserAndInvite: () => Effect.succeed(scenario.findOpenByUserAndInvite),
    findNewestByUserAndInvite: () => Effect.succeed(scenario.findNewestByUserAndInvite),
    countRecentByUserAndInvite: () => Effect.succeed(scenario.countRecent),
    findPending: () => Effect.succeed([]),
    setDiscordCode: () => Effect.void,
    markFailed: () => Effect.void,
    findByDiscordCodeWithContext: () => Effect.succeed(Option.none()),
    findTeamIdById: () => Effect.succeed(Option.some(PR5_TEAM_ID)),
  } as never);

  const Pr5Layer = ApiLive.pipe(
    Layer.provideMerge(AuthMiddlewareLive),
    Layer.provideMerge(HttpServer.layerServices),
    Layer.provide(MockDiscordOAuthLayer),
    Layer.provide(MockUsersRepositoryLayer),
    Layer.provide(MockSessionsRepositoryLayer),
    Layer.provide(MockTeamsRepositoryLayer),
    Layer.provide(Pr5TeamMembersLayer),
    Layer.provide(
      Layer.merge(
        Layer.merge(
          Layer.merge(MockRostersRepositoryLayer, MockActivityLogsRepositoryLayer),
          MockActivityTypesRepositoryLayer,
        ),
        MockLeaderboardRepositoryLayer,
      ),
    ),
    Layer.provide(MockRolesRepositoryLayer),
    Layer.provide(MockGroupsRepositoryLayer),
    Layer.provide(MockTrainingTypesRepositoryLayer),
    Layer.provide(
      Layer.merge(
        Pr5TeamInvitesLayer,
        Layer.merge(Pr5PendingGuildJoinsLayer, Pr5InviteAcceptancesLayer),
      ),
    ),
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
                MockBotGuildsRepositoryLayer,
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
    .pipe(Layer.provide(MockRulesAttemptsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(MockEventRosterLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
      ),
    );

  let pr5Handler: (...args: any[]) => Promise<Response>;
  let pr5Dispose: () => Promise<void>;

  beforeAll(() => {
    const app = HttpRouter.toWebHandler(Pr5Layer);
    pr5Handler = app.handler;
    pr5Dispose = app.dispose;
  });

  afterAll(async () => {
    await pr5Dispose();
  });

  const getJoinStatusPr5 = (acceptanceId: string, token = 'user-token') =>
    pr5Handler(
      new Request(`http://localhost/invite/acceptances/${acceptanceId}`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

  const getMyPendingDiscordJoin = (teamId: string, token = 'user-token') =>
    pr5Handler(
      new Request(`http://localhost/teams/${teamId}/me/discord-join`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

  const regenerateMyDiscordInvite = (teamId: string, token = 'user-token') =>
    pr5Handler(
      new Request(`http://localhost/teams/${teamId}/me/discord-join`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }),
    );

  // -------------------------------------------------------------------------
  // Tests 1-6: `getJoinStatus` gains `state`, via `joinStatusState.ts` (step 6).
  // -------------------------------------------------------------------------

  it("getJoinStatus returns state 'preparing' when neither code nor error is set and the row is fresh", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({ id: 'pr5-preparing', created_at: DateTime.nowUnsafe() }),
    );

    const response = await getJoinStatusPr5('pr5-preparing');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('preparing');
  });

  it("getJoinStatus returns state 'ready' with a discord.gg URL when discord_code is set", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({ id: 'pr5-ready', discord_code: Option.some('abc123') }),
    );

    const response = await getJoinStatusPr5('pr5-ready');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('ready');
    expect(body.discordInviteUrl).toBe('https://discord.gg/abc123');
  });

  it("getJoinStatus returns state 'failed' with errorCode when marked bot_missing_perms", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({
        id: 'pr5-failed',
        discord_code_error_code: Option.some('bot_missing_perms'),
      }),
    );

    const response = await getJoinStatusPr5('pr5-failed');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('failed');
    expect(body.errorCode).toBe('bot_missing_perms');
  });

  // Pins CC-3: expiry is carried by `state`, never by `errorCode` — see the SPEC GAP note
  // at the top of this block re: PR-2 not having landed in this checkout yet.
  it("getJoinStatus returns state 'expired' and errorCode None for an expired row", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({ id: 'pr5-expired', discord_code_error_code: Option.some('expired') }),
    );

    const response = await getJoinStatusPr5('pr5-expired');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('expired');
    expect(body.errorCode).toBeNull();
  });

  // Pins CC-6: `discord_code` present wins over everything, including a stale error code —
  // a failed `pending_guild_joins` row (auto-join) is not surfaced as an error here at all
  // (that table isn't read by this endpoint); the only way this scenario is reachable through
  // `invite_acceptances` alone is a row that has BOTH a working code and a leftover error
  // code from an earlier attempt. `state` must still read 'ready'.
  it("getJoinStatus returns 'ready', not 'failed', when a discord_code exists alongside a stale error code", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({
        id: 'pr5-ready-despite-error',
        discord_code: Option.some('still-works'),
        discord_code_error_code: Option.some('bot_missing_perms'),
      }),
    );

    const response = await getJoinStatusPr5('pr5-ready-despite-error');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('ready');
  });

  // Pins CC-4's defensive guard: derives 'expired' for a row the sweep hasn't reached yet.
  // 10 days comfortably exceeds `INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS` (sweep default 3 + 1 =
  // 4, per CC-4) without pinning the exact boundary — that boundary is PR-3's unit test on
  // `inviteExpiry.ts`, not this one.
  it("getJoinStatus derives state 'expired' for an un-swept aged row", async () => {
    resetPr5Scenario();
    scenario.findById = Option.some(
      freshRecord({
        id: 'pr5-aged',
        created_at: DateTime.subtract(DateTime.nowUnsafe(), { days: 10 }),
      }),
    );

    const response = await getJoinStatusPr5('pr5-aged');
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.state).toBe('expired');
    expect(body.errorCode).toBeNull();
  });

  // -------------------------------------------------------------------------
  // Tests 7-9: `getMyPendingDiscordJoin` (GET /teams/:teamId/me/discord-join)
  // -------------------------------------------------------------------------

  it('getMyPendingDiscordJoin returns None when the caller has no open acceptance for the team', async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndTeamByUser.set(TEST_USER_ID, Option.none());

    const response = await getMyPendingDiscordJoin(PR5_TEAM_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();
  });

  it('getMyPendingDiscordJoin returns 403 for a non-member', async () => {
    resetPr5Scenario();
    scenario.isMember = false;

    const response = await getMyPendingDiscordJoin(PR5_TEAM_ID);
    expect(response.status).toBe(403);
  });

  // PR-4 closed this exact hole on `getJoinStatus` (any authenticated caller holding an
  // acceptanceId got a working invite for a team they were never invited to). Pins that
  // `getMyPendingDiscordJoin` doesn't reopen it via a query scoped to team only (or to
  // anything request-controlled) instead of the caller's own id.
  it("getMyPendingDiscordJoin never returns another user's acceptance", async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndTeamByUser.set(TEST_USER_ID, Option.none());
    scenario.findOpenByUserAndTeamByUser.set(
      TEST_ADMIN_ID,
      Option.some(freshRecord({ id: 'admin-owned-acceptance', user_id: TEST_ADMIN_ID })),
    );

    const asUser = await getMyPendingDiscordJoin(PR5_TEAM_ID, 'user-token');
    expect(asUser.status).toBe(200);
    expect(await asUser.json()).toBeNull();

    const asAdmin = await getMyPendingDiscordJoin(PR5_TEAM_ID, 'admin-token');
    expect(asAdmin.status).toBe(200);
    const adminBody = await asAdmin.json();
    expect(adminBody.acceptanceId).toBe('admin-owned-acceptance');

    // The repository must be queried with the CALLING user's own id both times, not a
    // single shared/global lookup.
    expect(pr5FindOpenByUserAndTeamCalls).toEqual(
      expect.arrayContaining([
        { userId: TEST_USER_ID, teamId: PR5_TEAM_ID },
        { userId: TEST_ADMIN_ID, teamId: PR5_TEAM_ID },
      ]),
    );
  });

  // -------------------------------------------------------------------------
  // Tests 10-15: `regenerateMyDiscordInvite` (POST /teams/:teamId/me/discord-join)
  // -------------------------------------------------------------------------

  it("regenerateMyDiscordInvite creates a new acceptance when the newest is expired, returning state 'preparing'", async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndInvite = Option.none(); // newest is terminally expired/absent
    scenario.countRecent = 0;

    const response = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).not.toBeNull();
    expect(body.state).toBe('preparing');
    expect(pr5CreateCalls).toEqual([{ team_invite_id: PR5_INVITE_ID, user_id: TEST_USER_ID }]);
  });

  it('regenerateMyDiscordInvite reuses the open acceptance and creates nothing when one exists', async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndInvite = Option.some(freshRecord({ id: 'pr5-open-acceptance' }));

    const response = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBe('pr5-open-acceptance');
    expect(pr5CreateCalls.length).toBe(0);
  });

  it('regenerateMyDiscordInvite returns 200 and the existing row when rate-limited — no error tag', async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndInvite = Option.none();
    scenario.countRecent = 3; // at CC-14's 3/hour cap
    scenario.findNewestByUserAndInvite = Option.some(
      freshRecord({
        id: 'pr5-rate-limited',
        discord_code_error_code: Option.some('bot_missing_perms'),
      }),
    );

    const response = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.acceptanceId).toBe('pr5-rate-limited');
    expect(pr5CreateCalls.length).toBe(0);
  });

  it('regenerateMyDiscordInvite enqueues a pending guild join only when it created a row', async () => {
    resetPr5Scenario();
    scenario.findOpenByUserAndInvite = Option.some(freshRecord({ id: 'pr5-reused-no-enqueue' }));
    const reuseResponse = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(reuseResponse.status).toBe(200);
    expect(pr5EnqueueCalls.length).toBe(0);

    resetPr5Scenario();
    scenario.findOpenByUserAndInvite = Option.none();
    scenario.countRecent = 0;
    const createResponse = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(createResponse.status).toBe(200);
    expect(pr5EnqueueCalls).toEqual([{ userId: TEST_USER_ID, teamId: PR5_TEAM_ID }]);
  });

  it('regenerateMyDiscordInvite returns 403 for a non-member', async () => {
    resetPr5Scenario();
    scenario.isMember = false;

    const response = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(response.status).toBe(403);
  });

  it('regenerateMyDiscordInvite returns None when the team has no active invite', async () => {
    resetPr5Scenario();
    scenario.activeInvite = Option.none();

    const response = await regenerateMyDiscordInvite(PR5_TEAM_ID);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toBeNull();
    expect(pr5CreateCalls.length).toBe(0);
  });
});
