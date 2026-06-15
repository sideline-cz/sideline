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
          enqueue: () => Effect.void,
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
          requeueFailedForUser: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {
          _tag: 'api/InviteAcceptancesRepository',
          create: ({ team_invite_id, user_id }: { team_invite_id: string; user_id: string }) =>
            Effect.succeed({
              id: `${team_invite_id}:${user_id}`,
              team_invite_id,
              user_id,
              discord_code: Option.none(),
              discord_code_error_code: Option.none(),
              discord_code_error_detail: Option.none(),
              created_at: DateTime.nowUnsafe(),
              generated_at: Option.none(),
            }),
          findById: () => Effect.succeed(Option.none()),
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
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
  .pipe(Layer.provide(MockEventRosterLayers))
  .pipe(Layer.provide(BotInfoStore.Default))
  .pipe(Layer.provide(GlobalAdminAllowlist.Default));

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

  it('POST /invite/:code/join with valid token joins team', async () => {
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
  });

  it('POST /invite/:code/join when already a member returns 409', async () => {
    const response = await handler(
      new Request('http://localhost/invite/valid-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(409);
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
  const makeRejoinMembersLayer = (existingMembership: Option.Option<MembershipWithRole>) =>
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
      getPlayerRoleId: () => Effect.succeed(Option.some({ id: REJOIN_PLAYER_ROLE_ID })),
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

  const buildRejoinLayer = (existingMembership: Option.Option<MembershipWithRole>) =>
    ApiLive.pipe(
      Layer.provideMerge(AuthMiddlewareLive),
      Layer.provideMerge(HttpServer.layerServices),
      Layer.provide(MockDiscordOAuthLayer),
      Layer.provide(RejoinUsersLayer),
      Layer.provide(RejoinSessionsLayer),
      Layer.provide(RejoinTeamsLayer),
      Layer.provide(makeRejoinMembersLayer(existingMembership)),
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
              enqueue: () => Effect.void,
              listPending: () => Effect.succeed([]),
              markDone: () => Effect.void,
              markFailed: () => Effect.void,
              requeueFailedForUser: () => Effect.void,
            } as never),
            Layer.succeed(InviteAcceptancesRepository, {
              _tag: 'api/InviteAcceptancesRepository',
              create: ({ team_invite_id, user_id }: { team_invite_id: string; user_id: string }) =>
                Effect.succeed({
                  id: `${team_invite_id}:${user_id}`,
                  team_invite_id,
                  user_id,
                  discord_code: Option.none(),
                  discord_code_error_code: Option.none(),
                  discord_code_error_detail: Option.none(),
                  created_at: DateTime.nowUnsafe(),
                  generated_at: Option.none(),
                }),
              findById: () => Effect.succeed(Option.none()),
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
      .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
      .pipe(Layer.provide(MockChannelManagementLayers))
      .pipe(Layer.provide(MockEmailLayers))
      .pipe(Layer.provide(MockEventRosterLayers))
      .pipe(Layer.provide(BotInfoStore.Default))
      .pipe(Layer.provide(GlobalAdminAllowlist.Default));

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

  it('already-active user gets AlreadyMember (409) — regression guard', async () => {
    reactivateCalled = false;
    addMemberCalled = false;

    const activeMembership2: MembershipWithRole = {
      ...inactiveMembership,
      active: true,
    };

    const rejoinApp = HttpRouter.toWebHandler(buildRejoinLayer(Option.some(activeMembership2)));
    const rejoinHandler = rejoinApp.handler as (...args: any[]) => Promise<Response>;

    const response = await rejoinHandler(
      new Request('http://localhost/invite/rejoin-invite/join', {
        method: 'POST',
        headers: { Authorization: 'Bearer rejoin-token' },
      }),
    );

    await rejoinApp.dispose();

    expect(response.status).toBe(409);
    // Neither should be called — we fail before reaching the join logic
    expect(reactivateCalled).toBe(false);
    expect(addMemberCalled).toBe(false);
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
});
