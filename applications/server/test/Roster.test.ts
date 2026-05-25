import type { Auth, Discord, Role, RosterModel, Team, TeamMember } from '@sideline/domain';
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
import { RosterEntry, TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';
import { MockWeeklyChallengeRepositoryLayer } from './mocks/weeklyChallengeMocks.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
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

type UserLike = {
  id: Auth.UserId;
  discord_id: string;
  username: string;
  avatar: Option.Option<string>;
  is_profile_complete: boolean;
  name: Option.Option<string>;
  birth_date: Option.Option<DateTime.Utc>;
  gender: Option.Option<'male' | 'female' | 'other'>;
  locale: 'en' | 'cs';
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin);

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
  });
};

// In-memory roster store
type RosterRecord = {
  id: RosterModel.RosterId;
  team_id: Team.TeamId;
  name: string;
  active: boolean;
  color: Option.Option<string>;
  emoji: Option.Option<string>;
  discord_channel_id: Option.Option<Discord.Snowflake>;
  created_at: DateTime.Utc;
};

type RosterMemberRecord = {
  roster_id: RosterModel.RosterId;
  team_member_id: TeamMember.TeamMemberId;
};

const rostersStore = new Map<RosterModel.RosterId, RosterRecord>();
rostersStore.set(TEST_ROSTER_ID, {
  id: TEST_ROSTER_ID,
  team_id: TEST_TEAM_ID,
  name: 'Test Roster',
  active: true,
  color: Option.none(),
  emoji: Option.none(),
  discord_channel_id: Option.none(),
  created_at: DateTime.nowUnsafe(),
});

const rosterMembersStore = new Map<string, RosterMemberRecord>();

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
  updateAdminProfile: (input: {
    id: Auth.UserId;
    name: Option.Option<string>;
    birth_date: Option.Option<DateTime.Utc>;
    gender: Option.Option<'male' | 'female' | 'other'>;
  }) => {
    const user = usersMap.get(input.id);
    if (!user) return Effect.die(new Error('User not found'));
    const updated = {
      ...user,
      name: input.name,
      birth_date: input.birth_date,
      gender: input.gender,
    };
    usersMap.set(input.id, updated);
    return Effect.succeed(updated);
  },
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
  addMember: (input: { team_id: Team.TeamId; user_id: Auth.UserId; active: boolean }) => {
    const id = crypto.randomUUID() as TeamMember.TeamMemberId;
    const member: MembershipWithRole = {
      id,
      team_id: input.team_id,
      user_id: input.user_id,
      active: input.active,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    };
    membersStore.set(id, member);
    return Effect.succeed({
      id,
      team_id: input.team_id,
      user_id: input.user_id,
      active: input.active,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    });
  },
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = Array.from(membersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(
      Array.from(membersStore.values())
        .filter((m) => m.team_id === teamId && m.active)
        .map((m) => ({
          id: m.id,
          team_id: m.team_id,
          user_id: m.user_id,
          active: m.active,
          jersey_number: Option.none(),
          joined_at: DateTime.nowUnsafe(),
        })),
    ),
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
  deactivateMemberByIds: (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) => {
    const member = membersStore.get(memberId);
    if (!member || member.team_id !== teamId) return Effect.die(new Error('Member not found'));
    const updated = { ...member, active: false };
    membersStore.set(memberId, updated);
    return Effect.succeed({
      id: updated.id,
      team_id: updated.team_id,
      user_id: updated.user_id,
      active: updated.active,
      jersey_number: Option.none(),
      joined_at: DateTime.nowUnsafe(),
    });
  },
  getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_PLAYER_ROLE_ID })),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: (teamId: Team.TeamId) => {
    const rosters = Array.from(rostersStore.values()).filter((r) => r.team_id === teamId);
    return Effect.succeed(
      rosters.map((r) => ({
        id: r.id,
        team_id: r.team_id,
        name: r.name,
        active: r.active,
        color: r.color,
        emoji: r.emoji,
        discord_channel_id: r.discord_channel_id,
        created_at: r.created_at,
        member_count: Array.from(rosterMembersStore.values()).filter((rm) => rm.roster_id === r.id)
          .length,
      })),
    );
  },
  findRosterById: (id: RosterModel.RosterId) => {
    const roster = rostersStore.get(id);
    return Effect.succeed(roster ? Option.some(roster) : Option.none());
  },
  insert: (input: {
    team_id: string;
    name: string;
    active: boolean;
    color: Option.Option<string>;
    emoji: Option.Option<string>;
  }) => {
    const id = crypto.randomUUID() as RosterModel.RosterId;
    const roster: RosterRecord = {
      id,
      team_id: input.team_id as Team.TeamId,
      name: input.name,
      active: input.active,
      color: input.color,
      emoji: input.emoji,
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    };
    rostersStore.set(id, roster);
    return Effect.succeed(roster);
  },
  update: (input: {
    id: RosterModel.RosterId;
    name: Option.Option<string>;
    active: Option.Option<boolean>;
    color: Option.Option<string>;
    emoji: Option.Option<string>;
    discord_channel_id?: Option.Option<Option.Option<Discord.Snowflake>>;
  }) => {
    const roster = rostersStore.get(input.id);
    if (!roster) return Effect.die(new Error('Roster not found'));
    const updated = {
      ...roster,
      name: Option.getOrElse(input.name, () => roster.name),
      active: Option.getOrElse(input.active, () => roster.active),
      color: Option.isSome(input.color) ? input.color : roster.color,
      emoji: Option.isSome(input.emoji) ? input.emoji : roster.emoji,
      discord_channel_id:
        input.discord_channel_id !== undefined
          ? Option.getOrElse(input.discord_channel_id, () => roster.discord_channel_id)
          : roster.discord_channel_id,
    };
    rostersStore.set(input.id, updated);
    return Effect.succeed(updated);
  },
  delete: (id: RosterModel.RosterId) => {
    rostersStore.delete(id);
    return Effect.void;
  },
  findMemberEntriesById: (rosterId: RosterModel.RosterId) => {
    const memberIds = Array.from(rosterMembersStore.values())
      .filter((rm) => rm.roster_id === rosterId)
      .map((rm) => rm.team_member_id);
    const entries = memberIds.flatMap((memberId) => {
      const member = membersStore.get(memberId);
      if (!member) return [];
      return [buildRosterEntry(member.id, member.user_id, member.role_names, member.permissions)];
    });
    return Effect.succeed(entries);
  },
  addMemberById: (rosterId: RosterModel.RosterId, teamMemberId: TeamMember.TeamMemberId) => {
    const key = `${rosterId}:${teamMemberId}`;
    rosterMembersStore.set(key, { roster_id: rosterId, team_member_id: teamMemberId });
    return Effect.void;
  },
  removeMemberById: (rosterId: RosterModel.RosterId, teamMemberId: TeamMember.TeamMemberId) => {
    const key = `${rosterId}:${teamMemberId}`;
    rosterMembersStore.delete(key);
    return Effect.void;
  },
} as any);

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented in roster tests')),
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
  checkCoach: () => Effect.succeed(Option.some({ exists: false })),
  isCoachForTrainingType: () => Effect.succeed(false),
  findByCoach: () => Effect.succeed([]),
  findTrainingTypesByCoach: () => Effect.succeed([]),
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
  emitRosterMemberAdded: () => Effect.void,
  emitRosterMemberRemoved: () => Effect.void,
  emitRosterChannelCreated: () => Effect.void,
  emitRosterChannelDeleted: () => Effect.void,
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
  findByRosterId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  insertRoster: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  deleteByRosterId: () => Effect.void,
  findAllByTeam: () => Effect.succeed([]),
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

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  _tag: 'api/OAuthConnectionsRepository',
  upsertConnection: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  findByUserAndProvider: () => Effect.succeed(Option.none()),
  findByUser: () => Effect.succeed(Option.none()),
  findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
  getAccessToken: () => Effect.succeed('mock-access-token'),
} as any);

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
  .pipe(Layer.provide(MockWeeklyChallengeRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(BotInfoStore.Default));

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

describe('Members API', () => {
  describe('GET /teams/:teamId/members', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(new Request(`http://localhost/teams/${TEST_TEAM_ID}/members`));
      expect(response.status).toBe(401);
    });

    it('returns 403 for non-member', async () => {
      const nonMemberTeamId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${nonMemberTeamId}/members`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 200 with player list for member', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThan(0);
      expect(body[0].username).toBeDefined();
    });
  });

  describe('GET /teams/:teamId/members/:memberId', () => {
    it('returns 200 for member accessing own roster entry', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.memberId).toBe(TEST_MEMBER_ID);
    });

    it('returns 404 for unknown member', async () => {
      const unknownMemberId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${unknownMemberId}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 403 for non-member of team', async () => {
      const nonMemberTeamId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${nonMemberTeamId}/members/${TEST_MEMBER_ID}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('PATCH /teams/:teamId/members/:memberId', () => {
    it('returns 200 for admin updating player', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Updated Name',
            birthDate: null,
            gender: null,
            jerseyNumber: null,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.memberId).toBe(TEST_MEMBER_ID);
    });

    it('returns 403 for regular member trying to update', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: 'Updated Name',
            birthDate: null,
            gender: null,
            jerseyNumber: null,
          }),
        }),
      );
      expect(response.status).toBe(403);
    });
  });

  describe('DELETE /teams/:teamId/members/:memberId', () => {
    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 404 for unknown member', async () => {
      const unknownMemberId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${unknownMemberId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 204 for admin deactivating player', async () => {
      // Re-activate the member first
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
    });
  });
});

describe('Rosters API', () => {
  describe('GET /teams/:teamId/rosters', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`));
      expect(response.status).toBe(401);
    });

    it('returns 403 for non-member', async () => {
      const nonMemberTeamId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${nonMemberTeamId}/rosters`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 200 with roster list for member', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('canManage');
      expect(Array.isArray(body.rosters)).toBe(true);
    });

    it('GET roster list includes discordChannelId in each roster item', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rosters.length).toBeGreaterThan(0);
      const roster = body.rosters[0];
      expect(roster).toHaveProperty('discordChannelId');
      expect(roster).toHaveProperty('discordChannelName');
    });
  });

  describe('POST /teams/:teamId/rosters', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: 'New Roster' }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'New Roster', color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 201 for admin creating roster', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'New Roster', color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.name).toBe('New Roster');
      expect(body.active).toBe(true);
      expect(body.memberCount).toBe(0);
    });
  });

  describe('GET /teams/:teamId/rosters/:rosterId', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`),
      );
      expect(response.status).toBe(401);
    });

    it('returns 404 for unknown roster', async () => {
      const unknownRosterId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${unknownRosterId}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 200 with roster detail for member', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rosterId).toBe(TEST_ROSTER_ID);
      expect(body.name).toBe('Test Roster');
      expect(Array.isArray(body.members)).toBe(true);
    });

    it('GET roster detail includes discordChannelId', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveProperty('discordChannelId');
      expect(body).toHaveProperty('discordChannelName');
      expect(body.discordChannelId).toBeNull();
      expect(body.discordChannelName).toBeNull();
    });
  });

  describe('PATCH /teams/:teamId/rosters/:rosterId', () => {
    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Updated', active: null, color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 200 for admin updating roster', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'Updated Roster', active: null, color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('Updated Roster');
    });

    it('returns 404 for unknown roster', async () => {
      const unknownRosterId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${unknownRosterId}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: null, active: false, color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('PATCH update roster discord_channel_id', async () => {
      // Reset roster to have no discord channel
      rostersStore.set(TEST_ROSTER_ID, {
        id: TEST_ROSTER_ID,
        team_id: TEST_TEAM_ID,
        name: 'Test Roster',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
        discord_channel_id: Option.none(),
        created_at: DateTime.nowUnsafe(),
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: null,
            active: null,
            color: null,
            emoji: null,
            discordChannelId: '123456789',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.discordChannelId).toBe('123456789');
    });

    it('PATCH clear roster discord_channel_id', async () => {
      // Set roster to have a discord channel
      rostersStore.set(TEST_ROSTER_ID, {
        id: TEST_ROSTER_ID,
        team_id: TEST_TEAM_ID,
        name: 'Test Roster',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
        discord_channel_id: Option.some('987654321' as Discord.Snowflake),
        created_at: DateTime.nowUnsafe(),
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            name: null,
            active: null,
            color: null,
            emoji: null,
            discordChannelId: null,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.discordChannelId).toBeNull();
    });

    it('PATCH update roster without discord_channel_id preserves existing', async () => {
      const existingChannelId = '555555555' as Discord.Snowflake;
      // Set roster to have a discord channel
      rostersStore.set(TEST_ROSTER_ID, {
        id: TEST_ROSTER_ID,
        team_id: TEST_TEAM_ID,
        name: 'Test Roster',
        active: true,
        color: Option.none(),
        emoji: Option.none(),
        discord_channel_id: Option.some(existingChannelId),
        created_at: DateTime.nowUnsafe(),
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'New Name', active: null, color: null, emoji: null }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.name).toBe('New Name');
      expect(body.discordChannelId).toBe(existingChannelId);
    });
  });

  describe('DELETE /teams/:teamId/rosters/:rosterId', () => {
    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 404 for unknown roster', async () => {
      const unknownRosterId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${unknownRosterId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 204 for admin deleting roster', async () => {
      // Create a roster to delete
      const createResponse = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ name: 'To Delete', color: null, emoji: null }),
        }),
      );
      const created = await createResponse.json();
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${created.rosterId}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
    });
  });

  describe('POST /teams/:teamId/rosters/:rosterId/members', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/members`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/members`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 404 for unknown roster', async () => {
      const unknownRosterId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${unknownRosterId}/members`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 204 for admin adding member', async () => {
      // Ensure member is active
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/members`, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ memberId: TEST_MEMBER_ID }),
        }),
      );
      expect(response.status).toBe(204);
    });
  });

  describe('DELETE /teams/:teamId/rosters/:rosterId/members/:memberId', () => {
    it('returns 403 for non-admin', async () => {
      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/members/${TEST_MEMBER_ID}`,
          {
            method: 'DELETE',
            headers: { Authorization: 'Bearer user-token' },
          },
        ),
      );
      expect(response.status).toBe(403);
    });

    it('returns 404 for unknown roster', async () => {
      const unknownRosterId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/rosters/${unknownRosterId}/members/${TEST_MEMBER_ID}`,
          {
            method: 'DELETE',
            headers: { Authorization: 'Bearer admin-token' },
          },
        ),
      );
      expect(response.status).toBe(404);
    });

    it('returns 204 for admin removing member', async () => {
      // Ensure member is in roster
      const key = `${TEST_ROSTER_ID}:${TEST_MEMBER_ID}`;
      rosterMembersStore.set(key, {
        roster_id: TEST_ROSTER_ID,
        team_member_id: TEST_MEMBER_ID,
      });
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}/members/${TEST_MEMBER_ID}`,
          {
            method: 'DELETE',
            headers: { Authorization: 'Bearer admin-token' },
          },
        ),
      );
      expect(response.status).toBe(204);
    });
  });
});
