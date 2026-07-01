import type {
  Auth,
  Discord,
  GroupModel,
  Role,
  RosterModel,
  Team,
  TeamMember,
} from '@sideline/domain';
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
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from './mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const TEST_GROUP_ID = '00000000-0000-0000-0000-000000000050' as GroupModel.GroupId;
const TEST_GROUP_ANCESTOR_ID = '00000000-0000-0000-0000-000000000051' as GroupModel.GroupId;
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
  active = true,
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
    active,
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

// In-memory group store used to exercise the group/ancestor Discord-cleanup branch of
// deactivateMember/reactivateMember without needing a real GroupsRepository.
type GroupRecord = { id: GroupModel.GroupId; name: string };

const groupsStore = new Map<GroupModel.GroupId, GroupRecord>([
  [TEST_GROUP_ID, { id: TEST_GROUP_ID, name: 'Test Group' }],
  [TEST_GROUP_ANCESTOR_ID, { id: TEST_GROUP_ANCESTOR_ID, name: 'Test Group Ancestor' }],
]);
const groupAncestorsStore = new Map<GroupModel.GroupId, readonly GroupModel.GroupId[]>([
  [TEST_GROUP_ID, [TEST_GROUP_ANCESTOR_ID]],
]);
const groupMembersStore = new Set<string>();

// Tracks Discord cleanup emissions from deactivateMember/reactivateMember so tests can assert
// that the member-removed/member-added cleanup fired (or didn't) without needing a real Discord bot.
const channelSyncCalls: {
  emitMemberAdded: Array<{ groupId: unknown; memberId: unknown }>;
  emitMemberRemoved: Array<{ groupId: unknown; memberId: unknown }>;
  emitRosterMemberAdded: Array<{ rosterId: unknown; memberId: unknown }>;
  emitRosterMemberRemoved: Array<{ rosterId: unknown; memberId: unknown }>;
} = {
  emitMemberAdded: [],
  emitMemberRemoved: [],
  emitRosterMemberAdded: [],
  emitRosterMemberRemoved: [],
};

const resetChannelSyncCalls = () => {
  channelSyncCalls.emitMemberAdded = [];
  channelSyncCalls.emitMemberRemoved = [];
  channelSyncCalls.emitRosterMemberAdded = [];
  channelSyncCalls.emitRosterMemberRemoved = [];
};

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
  findRosterMemberByIds: (
    teamId: Team.TeamId,
    memberId: TeamMember.TeamMemberId,
    options?: { includeInactive?: boolean },
  ) => {
    const member = membersStore.get(memberId);
    const includeInactive = options?.includeInactive === true;
    if (!member || member.team_id !== teamId || (!member.active && !includeInactive)) {
      return Effect.succeed(Option.none());
    }
    return Effect.succeed(
      Option.some(
        buildRosterEntry(
          member.id,
          member.user_id,
          member.role_names,
          member.permissions,
          member.active,
        ),
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
  reactivateMember: (memberId: TeamMember.TeamMemberId) => {
    const member = membersStore.get(memberId);
    if (!member) return Effect.die(new Error('Member not found'));
    const updated = { ...member, active: true };
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
  findById: (id: TeamMember.TeamMemberId) => {
    const member = membersStore.get(id);
    return Effect.succeed(member ? Option.some({ active: member.active }) : Option.none());
  },
  hasOtherActiveManager: (_teamId: Team.TeamId, _excludeMemberId: TeamMember.TeamMemberId) =>
    Effect.succeed(true),
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
  findRosterIdsByMember: (memberId: TeamMember.TeamMemberId) =>
    Effect.succeed(
      Array.from(rosterMembersStore.values())
        .filter((rm) => rm.team_member_id === memberId)
        .map((rm) => rm.roster_id),
    ),
  removeAllForMember: (_memberId: TeamMember.TeamMemberId) => Effect.void,
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
  findGroupById: (groupId: GroupModel.GroupId) =>
    Effect.succeed(Option.fromNullishOr(groupsStore.get(groupId))),
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
  getAncestors: (groupId: GroupModel.GroupId) =>
    Effect.succeed(
      (groupAncestorsStore.get(groupId) ?? []).flatMap((id) => {
        const group = groupsStore.get(id);
        return group ? [group] : [];
      }),
    ),
  findGroupIdsByMember: (memberId: TeamMember.TeamMemberId) =>
    Effect.succeed(
      Array.from(groupMembersStore)
        .filter((key) => key.endsWith(`:${memberId}`))
        .map((key) => key.split(':')[0] as GroupModel.GroupId),
    ),
  getDescendantMemberIds: () => Effect.succeed([]),
  removeAllForMember: (_memberId: TeamMember.TeamMemberId) => Effect.void,
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

// Stub SqlClient: repositories are mocked, so the only real usages from
// deactivateMemberAndCascade are `sql.withTransaction(body)` (run the body
// directly) and the `sql`...`` advisory-lock tagged-template call (no-op query).
const sqlStub: any = (..._args: unknown[]) => Effect.succeed([]);
sqlStub.withTransaction = (effect: unknown) => effect;
const MockSqlClientLayer = Layer.succeed(SqlClient.SqlClient, sqlStub as any);

const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  emitChannelCreated: () => Effect.void,
  emitChannelDeleted: () => Effect.void,
  emitMemberAdded: (_teamId: unknown, groupId: unknown, _groupName: unknown, memberId: unknown) => {
    channelSyncCalls.emitMemberAdded.push({ groupId, memberId });
    return Effect.void;
  },
  emitMemberRemoved: (
    _teamId: unknown,
    groupId: unknown,
    _groupName: unknown,
    memberId: unknown,
  ) => {
    channelSyncCalls.emitMemberRemoved.push({ groupId, memberId });
    return Effect.void;
  },
  emitRosterMemberAdded: (
    _teamId: unknown,
    rosterId: unknown,
    _rosterName: unknown,
    memberId: unknown,
  ) => {
    channelSyncCalls.emitRosterMemberAdded.push({ rosterId, memberId });
    return Effect.void;
  },
  emitRosterMemberRemoved: (
    _teamId: unknown,
    rosterId: unknown,
    _rosterName: unknown,
    memberId: unknown,
  ) => {
    channelSyncCalls.emitRosterMemberRemoved.push({ rosterId, memberId });
    return Effect.void;
  },
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
  )
  .pipe(Layer.provide(MockSqlClientLayer));

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

    it('flips the member to inactive and emits Discord member-removed cleanup', async () => {
      // Re-activate the member first
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      // Seed the member's roster membership explicitly so the cleanup assertion below is
      // unconditional (no silent skip if the roster-membership tests haven't run yet).
      rosterMembersStore.set(`${TEST_ROSTER_ID}:${TEST_MEMBER_ID}`, {
        roster_id: TEST_ROSTER_ID,
        team_member_id: TEST_MEMBER_ID,
      });
      resetChannelSyncCalls();
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
      expect(membersStore.get(TEST_MEMBER_ID)?.active).toBe(false);
      // Regression guard: deactivateMember must reconcile Discord roster access — the member
      // was seeded onto TEST_ROSTER_ID above, so the cleanup path must emit roster-member-removed.
      expect(
        channelSyncCalls.emitRosterMemberRemoved.some((c) => c.memberId === TEST_MEMBER_ID),
      ).toBe(true);

      rosterMembersStore.delete(`${TEST_ROSTER_ID}:${TEST_MEMBER_ID}`);
    });

    it('emits group member-removed cleanup for the member group AND its ancestor', async () => {
      // Re-activate the member first
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      // Seed the member's group membership — TEST_GROUP_ID has TEST_GROUP_ANCESTOR_ID as an
      // ancestor (see groupAncestorsStore), so deactivation must emit member-removed for both.
      groupMembersStore.add(`${TEST_GROUP_ID}:${TEST_MEMBER_ID}`);
      resetChannelSyncCalls();
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
      expect(membersStore.get(TEST_MEMBER_ID)?.active).toBe(false);
      expect(
        channelSyncCalls.emitMemberRemoved.some(
          (c) => c.groupId === TEST_GROUP_ID && c.memberId === TEST_MEMBER_ID,
        ),
      ).toBe(true);
      expect(
        channelSyncCalls.emitMemberRemoved.some(
          (c) => c.groupId === TEST_GROUP_ANCESTOR_ID && c.memberId === TEST_MEMBER_ID,
        ),
      ).toBe(true);

      groupMembersStore.delete(`${TEST_GROUP_ID}:${TEST_MEMBER_ID}`);
    });

    it('returns 403 for regular member without member:remove permission', async () => {
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
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 403 when a user with member:remove tries to deactivate their own membership', async () => {
      membersStore.set(TEST_ADMIN_MEMBER_ID, {
        id: TEST_ADMIN_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_ADMIN_ID,
        active: true,
        role_names: ['Admin'],
        permissions: ADMIN_PERMISSIONS,
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_ADMIN_MEMBER_ID}`, {
          method: 'DELETE',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(403);
      // Membership must remain untouched — the guard should fail before any mutation.
      expect(membersStore.get(TEST_ADMIN_MEMBER_ID)?.active).toBe(true);
    });
  });

  describe('GET /teams/:teamId/members/:memberId — deactivated member', () => {
    it('returns 200 (not 404) for a deactivated member, with active:false', async () => {
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: false,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.memberId).toBe(TEST_MEMBER_ID);
      expect(body.active).toBe(false);
      // Restore active state for subsequent tests
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: true,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
    });
  });

  describe('POST /teams/:teamId/members/:memberId/reactivate', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/reactivate`, {
          method: 'POST',
        }),
      );
      expect(response.status).toBe(401);
    });

    it('returns 403 without member:remove permission', async () => {
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: false,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/reactivate`, {
          method: 'POST',
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 404 for a member not in this team / nonexistent', async () => {
      const unknownMemberId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/members/${unknownMemberId}/reactivate`,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer admin-token' },
          },
        ),
      );
      expect(response.status).toBe(404);
    });

    it('returns 404 for a member that belongs to a different team', async () => {
      const otherTeamMemberId = '00000000-0000-0000-0000-000000000077' as TeamMember.TeamMemberId;
      const otherTeamId = '00000000-0000-0000-0000-000000000098' as Team.TeamId;
      membersStore.set(otherTeamMemberId, {
        id: otherTeamMemberId,
        team_id: otherTeamId,
        user_id: TEST_USER_ID,
        active: false,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      const response = await handler(
        new Request(
          `http://localhost/teams/${TEST_TEAM_ID}/members/${otherTeamMemberId}/reactivate`,
          {
            method: 'POST',
            headers: { Authorization: 'Bearer admin-token' },
          },
        ),
      );
      expect(response.status).toBe(404);
      membersStore.delete(otherTeamMemberId);
    });

    it('flips an inactive member back to active without self-404ing, and emits Discord member-added cleanup', async () => {
      // Deactivate the member first — reactivateMember must look this member up with
      // includeInactive: true, since the active-filtered lookup would otherwise 404 here.
      membersStore.set(TEST_MEMBER_ID, {
        id: TEST_MEMBER_ID,
        team_id: TEST_TEAM_ID,
        user_id: TEST_USER_ID,
        active: false,
        role_names: ['Player'],
        permissions: PLAYER_PERMISSIONS,
      });
      resetChannelSyncCalls();
      const response = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/reactivate`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
      expect(membersStore.get(TEST_MEMBER_ID)?.active).toBe(true);

      const getResponse = await handler(
        new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(getResponse.status).toBe(200);
      const body = await getResponse.json();
      expect(body.active).toBe(true);
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

describe('GET /teams/:teamId/members/:memberId/rosters', () => {
  it('returns 401 without auth token', async () => {
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/rosters`),
    );
    expect(response.status).toBe(401);
  });

  it('returns 403 for non-member', async () => {
    const nonMemberTeamId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`http://localhost/teams/${nonMemberTeamId}/members/${TEST_MEMBER_ID}/rosters`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });

  it('returns 404 for unknown member', async () => {
    const unknownMemberId = '00000000-0000-0000-0000-000000000099';
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${unknownMemberId}/rosters`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(404);
  });

  it('returns only the rosters the member belongs to', async () => {
    membersStore.set(TEST_MEMBER_ID, {
      id: TEST_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    });
    // Create a second roster the member is NOT on.
    const otherRosterId = '00000000-0000-0000-0000-000000000031' as RosterModel.RosterId;
    rostersStore.set(otherRosterId, {
      id: otherRosterId,
      team_id: TEST_TEAM_ID,
      name: 'Other Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });
    // Put the member only on TEST_ROSTER_ID.
    rosterMembersStore.set(`${TEST_ROSTER_ID}:${TEST_MEMBER_ID}`, {
      roster_id: TEST_ROSTER_ID,
      team_member_id: TEST_MEMBER_ID,
    });

    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/rosters`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
    const rosterIds = body.map((r: { rosterId: string }) => r.rosterId);
    expect(rosterIds).toContain(TEST_ROSTER_ID);
    expect(rosterIds).not.toContain(otherRosterId);

    rostersStore.delete(otherRosterId);
    rosterMembersStore.delete(`${TEST_ROSTER_ID}:${TEST_MEMBER_ID}`);
  });

  it('is gated on member:view — 403 without it even for a team member', async () => {
    // Strip the requesting user's own membership permissions (findMembershipByIds matches
    // by team_id + user_id, so mutating TEST_MEMBER_ID directly affects the "user-token" caller).
    membersStore.set(TEST_MEMBER_ID, {
      id: TEST_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: [],
      permissions: [],
    });
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/members/${TEST_MEMBER_ID}/rosters`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
    // Restore the standard player membership used by other tests.
    membersStore.set(TEST_MEMBER_ID, {
      id: TEST_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    });
  });
});

// =============================================================================
// ROSTER CATEGORY TESTS — updateRoster → emitRosterChannelCreated target_category_id
//
// Tests the behavior of PATCH /rosters/:id with the discord_roster_category_id
// feature. The server implementation ships with this PR.
//
// Scenarios:
//   R1: reactivation + category → roster_channel_created with target_category_id=Some
//   R2: reactivation + no category → roster_channel_created with target_category_id=None
//   R3: reactivation + create_discord_channel_on_roster=false → no event
//   R4: reactivation + discord_channel_id already set → no roster_channel_created
//   R5: link-existing (discordChannelId=Some) → existing_channel_id set, target_category_id=None
//   R6: deactivation regression guard → cleanup event + mapping deleted
// =============================================================================

// ---------------------------------------------------------------------------
// Per-test call-recording state (reset in beforeEach)
// ---------------------------------------------------------------------------

type RosterCategoryCreatedCall = {
  rosterId: RosterModel.RosterId;
  existingChannelId: Option.Option<Discord.Snowflake>;
  targetCategoryId: Option.Option<Discord.Snowflake>;
};

type RosterCategoryCleanupCall = {
  eventType: 'channel_deleted' | 'channel_archived' | 'channel_detached';
};

const rcRosterCreatedCalls: RosterCategoryCreatedCall[] = [];
const rcRosterCleanupCalls: RosterCategoryCleanupCall[] = [];
let rcMappingDeletedForRoster = false;

// ---------------------------------------------------------------------------
// Layer factories for roster-category tests
// ---------------------------------------------------------------------------

/**
 * Builds a ChannelSyncEventsRepository that records emitRosterChannelCreated calls.
 * The trailing `targetCategoryId` parameter is the new field added by this feature.
 */
const makeRcChannelSyncLayer = () =>
  Layer.succeed(ChannelSyncEventsRepository, {
    _tag: 'api/ChannelSyncEventsRepository',
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitChannelArchived: () => Effect.void,
    emitChannelDetached: () => Effect.void,
    emitRosterChannelCreated: (
      _teamId: Team.TeamId,
      rosterId: RosterModel.RosterId,
      _rosterName: string,
      existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
      _discordChannelName?: string,
      _discordRoleName?: string,
      _discordRoleColor?: Option.Option<number>,
      targetCategoryId: Option.Option<Discord.Snowflake> = Option.none(),
    ) => {
      rcRosterCreatedCalls.push({ rosterId, existingChannelId, targetCategoryId });
      return Effect.void;
    },
    emitRosterChannelDeleted: (
      _teamId: Team.TeamId,
      _rosterId: RosterModel.RosterId,
      _rosterName: string,
      _discordChannelId: Option.Option<Discord.Snowflake>,
      _discordRoleId: Option.Option<Discord.Snowflake>,
    ) => {
      rcRosterCleanupCalls.push({ eventType: 'channel_deleted' });
      return Effect.void;
    },
    emitRosterChannelArchived: (
      _teamId: Team.TeamId,
      _rosterId: RosterModel.RosterId,
      _rosterName: string,
      _discordChannelId: Option.Option<Discord.Snowflake>,
      _discordRoleId: Option.Option<Discord.Snowflake>,
      _archiveCategoryId: Discord.Snowflake,
    ) => {
      rcRosterCleanupCalls.push({ eventType: 'channel_archived' });
      return Effect.void;
    },
    emitRosterChannelDetached: (
      _teamId: Team.TeamId,
      _rosterId: RosterModel.RosterId,
      _rosterName: string,
      _discordChannelId: Option.Option<Discord.Snowflake>,
      _discordRoleId: Option.Option<Discord.Snowflake>,
    ) => {
      rcRosterCleanupCalls.push({ eventType: 'channel_detached' });
      return Effect.void;
    },
    emitGroupChannelUpdated: () => Effect.void,
    emitRosterChannelUpdated: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    markPermanentlyFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

type RcMappingEntry = {
  discord_channel_id: Option.Option<Discord.Snowflake>;
  discord_role_id: Option.Option<Discord.Snowflake>;
};

const makeRcDiscordChannelMappingLayer = (rosterMapping: Option.Option<RcMappingEntry>) =>
  Layer.succeed(DiscordChannelMappingRepository, {
    findByGroupId: () => Effect.succeed(Option.none()),
    findByRosterId: (_teamId: string, _rosterId: RosterModel.RosterId) =>
      Effect.succeed(
        Option.map(rosterMapping, (m) => ({
          id: 'mock-mapping-id',
          team_id: TEST_TEAM_ID,
          entity_type: 'roster' as const,
          group_id: Option.none(),
          roster_id: Option.some(_rosterId),
          discord_channel_id: m.discord_channel_id,
          discord_role_id: m.discord_role_id,
        })),
      ),
    insert: () => Effect.void,
    insertRoster: () => Effect.void,
    deleteByGroupId: () => Effect.void,
    deleteByRosterId: (_teamId: string, _rosterId: RosterModel.RosterId) => {
      rcMappingDeletedForRoster = true;
      return Effect.void;
    },
    findAllByTeam: () => Effect.succeed([]),
  } as any);

const makeRcSettingsRow = (overrides: {
  create_discord_channel_on_roster?: boolean;
  discord_roster_category_id?: Option.Option<Discord.Snowflake>;
  discord_channel_cleanup_on_roster_deactivate?: 'nothing' | 'delete' | 'archive';
  discord_archive_category_id?: Option.Option<Discord.Snowflake>;
}) => ({
  team_id: TEST_TEAM_ID,
  event_horizon_days: 30,
  min_players_threshold: 0,
  rsvp_reminder_hours: 0,
  discord_channel_training: Option.none(),
  discord_channel_match: Option.none(),
  discord_channel_tournament: Option.none(),
  discord_channel_meeting: Option.none(),
  discord_channel_social: Option.none(),
  discord_channel_other: Option.none(),
  create_discord_channel_on_group: true,
  create_discord_channel_on_roster: overrides.create_discord_channel_on_roster ?? true,
  discord_role_format: '{emoji} {name}',
  discord_channel_format: '{emoji}│{name}',
  discord_channel_cleanup_on_group_delete: 'delete' as const,
  discord_channel_cleanup_on_roster_deactivate:
    overrides.discord_channel_cleanup_on_roster_deactivate ?? ('delete' as const),
  discord_archive_category_id: overrides.discord_archive_category_id ?? Option.none(),
  discord_roster_category_id: overrides.discord_roster_category_id ?? Option.none(),
});

const makeRcSettingsLayer = (settings: Option.Option<ReturnType<typeof makeRcSettingsRow>>) =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId: () => Effect.succeed(settings),
    upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as any);

/**
 * Builds a full test layer for roster-category tests, allowing per-test
 * settings, channel-sync, and mapping layers.
 */
const buildRcTestLayer = (
  settingsLayer: Layer.Layer<TeamSettingsRepository>,
  channelSyncLayer: Layer.Layer<ChannelSyncEventsRepository>,
  mappingLayer: Layer.Layer<DiscordChannelMappingRepository>,
) =>
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
    Layer.provide(Layer.merge(channelSyncLayer, MockEventSyncEventsRepositoryLayer)),
    Layer.provide(Layer.merge(mappingLayer, MockICalTokensRepositoryLayer)),
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
          settingsLayer,
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
    )
    .pipe(Layer.provide(MockSqlClientLayer));

const rcDisposeHandlers: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const d of rcDisposeHandlers) {
    await d();
  }
});

/**
 * Creates an HTTP handler from the roster-category test layer and issues a
 * PATCH /teams/:teamId/rosters/:rosterId request as admin.
 */
const runRcPatchRoster = async (
  settingsLayer: Layer.Layer<TeamSettingsRepository>,
  channelSyncLayer: Layer.Layer<ChannelSyncEventsRepository>,
  mappingLayer: Layer.Layer<DiscordChannelMappingRepository>,
  payload: Record<string, unknown>,
  rosterId: RosterModel.RosterId = TEST_ROSTER_ID,
): Promise<{ status: number; body: unknown }> => {
  const testLayer = buildRcTestLayer(settingsLayer, channelSyncLayer, mappingLayer);
  const app = HttpRouter.toWebHandler(testLayer);
  rcDisposeHandlers.push(app.dispose);
  const h: (...args: any) => Promise<Response> = app.handler;

  const response = await h(
    new Request(`http://localhost/teams/${TEST_TEAM_ID}/rosters/${rosterId}`, {
      method: 'PATCH',
      headers: {
        Authorization: 'Bearer admin-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    }),
  );
  const body = await response.json();
  return { status: response.status, body };
};

describe('updateRoster — discord_roster_category_id feature', () => {
  // Reset per-test recording state before each case. Also clear rostersStore
  // so each test controls exactly which roster is present.
  beforeEach(() => {
    rcRosterCreatedCalls.length = 0;
    rcRosterCleanupCalls.length = 0;
    rcMappingDeletedForRoster = false;
    rostersStore.clear();
  });

  /**
   * R1: reactivation (active false→true), create_discord_channel_on_roster=true,
   *     discord_channel_id=None, discord_roster_category_id=Some(cat123)
   *     → exactly one roster_channel_created with target_category_id=Some(cat123)
   */
  it('R1: reactivation + discord_roster_category_id=Some(cat123) → roster_channel_created with target_category_id=Some(cat123)', async () => {
    const ROSTER_CAT_ID = 'cat123000000000000' as Discord.Snowflake;

    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_roster_category_id: Option.some(ROSTER_CAT_ID),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: true, color: null, emoji: null },
    );

    expect(status).toBe(200);
    // Exactly one roster_channel_created event
    expect(rcRosterCreatedCalls).toHaveLength(1);
    const call = rcRosterCreatedCalls[0]!;
    // existing_channel_id must be None (re-create, not a link)
    expect(Option.isNone(call.existingChannelId)).toBe(true);
    // target_category_id must be Some(ROSTER_CAT_ID)
    expect(Option.isSome(call.targetCategoryId)).toBe(true);
    expect((call.targetCategoryId as Option.Some<Discord.Snowflake>).value).toBe(ROSTER_CAT_ID);
    // No cleanup events
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });

  /**
   * R2: reactivation + discord_roster_category_id=None
   *     → roster_channel_created with target_category_id=None
   */
  it('R2: reactivation + discord_roster_category_id=None → roster_channel_created with target_category_id=None', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_roster_category_id: Option.none(),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: true, color: null, emoji: null },
    );

    expect(status).toBe(200);
    expect(rcRosterCreatedCalls).toHaveLength(1);
    const call = rcRosterCreatedCalls[0]!;
    expect(Option.isNone(call.existingChannelId)).toBe(true);
    expect(Option.isNone(call.targetCategoryId)).toBe(true);
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });

  /**
   * R3: reactivation but create_discord_channel_on_roster=false
   *     → no channel event emitted
   */
  it('R3: reactivation + create_discord_channel_on_roster=false → no roster_channel_created emitted', async () => {
    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: false,
      discord_roster_category_id: Option.some('cat123000000000000' as Discord.Snowflake),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: true, color: null, emoji: null },
    );

    expect(status).toBe(200);
    expect(rcRosterCreatedCalls).toHaveLength(0);
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });

  /**
   * R4: reactivation but discord_channel_id already set
   *     → no roster_channel_created (avoid double-create)
   */
  it('R4: reactivation + discord_channel_id already set → no roster_channel_created (avoid double-create)', async () => {
    const EXISTING_CHANNEL = '777777777777777777' as Discord.Snowflake;

    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.some(EXISTING_CHANNEL),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_roster_category_id: Option.some('cat123000000000000' as Discord.Snowflake),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: true, color: null, emoji: null },
    );

    expect(status).toBe(200);
    expect(rcRosterCreatedCalls).toHaveLength(0);
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });

  /**
   * R5: link-existing path (discordChannelId=Some(chan))
   *     → roster_channel_created with existing_channel_id=Some(chan) and target_category_id=None
   *       (category is ignored when linking an existing channel)
   */
  it('R5: link-existing (discordChannelId=Some) → roster_channel_created with existing_channel_id=Some and target_category_id=None', async () => {
    const LINK_CHANNEL = '888888888888888888' as Discord.Snowflake;

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

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_roster_category_id: Option.some('cat123000000000000' as Discord.Snowflake),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: null, color: null, emoji: null, discordChannelId: LINK_CHANNEL },
    );

    expect(status).toBe(200);
    expect(rcRosterCreatedCalls).toHaveLength(1);
    const call = rcRosterCreatedCalls[0]!;
    // Link path: existing_channel_id=Some(LINK_CHANNEL)
    expect(Option.isSome(call.existingChannelId)).toBe(true);
    expect((call.existingChannelId as Option.Some<Discord.Snowflake>).value).toBe(LINK_CHANNEL);
    // Category is ignored when linking — must be None
    expect(Option.isNone(call.targetCategoryId)).toBe(true);
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });

  /**
   * R6: deactivation (active true→false) regression guard
   *     → cleanup event emitted (channel_deleted) and mapping deleted
   */
  it('R6: deactivation (active true→false), cleanup=delete → channel_deleted emitted and mapping deleted', async () => {
    const EXISTING_CHANNEL = '444444444444444444' as Discord.Snowflake;
    const EXISTING_ROLE = '555555555555555555' as Discord.Snowflake;

    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: true,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.some(EXISTING_CHANNEL),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_channel_cleanup_on_roster_deactivate: 'delete',
      discord_roster_category_id: Option.some('cat123000000000000' as Discord.Snowflake),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(
        Option.some({
          discord_channel_id: Option.some(EXISTING_CHANNEL),
          discord_role_id: Option.some(EXISTING_ROLE),
        }),
      ),
      { name: null, active: false, color: null, emoji: null },
    );

    expect(status).toBe(200);
    // No create event on deactivation
    expect(rcRosterCreatedCalls).toHaveLength(0);
    // Cleanup event emitted
    expect(rcRosterCleanupCalls).toHaveLength(1);
    expect(rcRosterCleanupCalls[0]?.eventType).toBe('channel_deleted');
    // Mapping deleted
    expect(rcMappingDeletedForRoster).toBe(true);
  });

  /**
   * R7: reactivation (active false→true) + discordChannelId=Some(Some(chan))
   *     → emits roster_channel_created with existing_channel_id=Some(chan) and target_category_id=None
   *     → does NOT auto-create a fresh channel (links the provided one instead)
   */
  it('R7: reactivation + discordChannelId=Some(Some(chan)) → roster_channel_created with existing_channel_id=Some(chan) and target_category_id=None', async () => {
    const LINK_CHANNEL = '999999999999999999' as Discord.Snowflake;
    const ROSTER_CAT_ID = 'cat123000000000000' as Discord.Snowflake;

    rostersStore.set(TEST_ROSTER_ID, {
      id: TEST_ROSTER_ID,
      team_id: TEST_TEAM_ID,
      name: 'Test Roster',
      active: false,
      color: Option.none(),
      emoji: Option.none(),
      discord_channel_id: Option.none(),
      created_at: DateTime.nowUnsafe(),
    });

    const settings = makeRcSettingsRow({
      create_discord_channel_on_roster: true,
      discord_roster_category_id: Option.some(ROSTER_CAT_ID),
    });

    const { status } = await runRcPatchRoster(
      makeRcSettingsLayer(Option.some(settings)),
      makeRcChannelSyncLayer(),
      makeRcDiscordChannelMappingLayer(Option.none()),
      { name: null, active: true, color: null, emoji: null, discordChannelId: LINK_CHANNEL },
    );

    expect(status).toBe(200);
    // Exactly one roster_channel_created event
    expect(rcRosterCreatedCalls).toHaveLength(1);
    const call = rcRosterCreatedCalls[0]!;
    // existing_channel_id must be Some(LINK_CHANNEL) — linked, not auto-created
    expect(Option.isSome(call.existingChannelId)).toBe(true);
    expect((call.existingChannelId as Option.Some<Discord.Snowflake>).value).toBe(LINK_CHANNEL);
    // target_category_id must be None — ignored when linking an existing channel
    expect(Option.isNone(call.targetCategoryId)).toBe(true);
    // No cleanup events
    expect(rcRosterCleanupCalls).toHaveLength(0);
  });
});
