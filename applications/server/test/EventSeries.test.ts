import type {
  Auth,
  Discord,
  Event,
  EventSeries,
  Role,
  Team,
  TeamMember,
  TrainingType,
} from '@sideline/domain';
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
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from './mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// --- Test IDs ---
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_CAPTAIN_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_CAPTAIN_MEMBER_ID = '00000000-0000-0000-0000-000000000022' as TeamMember.TeamMemberId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const TEST_SERIES_1 = '00000000-0000-0000-0000-000000000070' as EventSeries.EventSeriesId;
const TEST_TRAINING_TYPE_A = '00000000-0000-0000-0000-000000000050' as TrainingType.TrainingTypeId;
const TEST_TRAINING_TYPE_B = '00000000-0000-0000-0000-000000000051' as TrainingType.TrainingTypeId;

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
  'event:create',
  'event:edit',
  'event:cancel',
];
const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
  'role:view',
  'event:create',
  'event:edit',
  'event:cancel',
];
const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// --- Users ---
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
usersMap.set(TEST_CAPTAIN_ID, testCaptain);

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

// --- In-memory series store ---
type SeriesRecord = {
  id: EventSeries.EventSeriesId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  title: string;
  description: Option.Option<string>;
  start_time: string;
  end_time: Option.Option<string>;
  location: Option.Option<string>;
  location_url: Option.Option<string>;
  frequency: 'weekly' | 'biweekly';
  days_of_week: number[];
  start_date: DateTime.Utc;
  end_date: Option.Option<DateTime.Utc>;
  status: 'active' | 'cancelled';
  training_type_name: Option.Option<string>;
  last_generated_date: Option.Option<DateTime.Utc>;
  discord_target_channel_id: Option.Option<string>;
  owner_group_id: Option.Option<string>;
  owner_group_name: Option.Option<string>;
  member_group_id: Option.Option<string>;
  member_group_name: Option.Option<string>;
};

let seriesStore: Map<EventSeries.EventSeriesId, SeriesRecord>;

// --- In-memory events store ---
type EventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  event_type: Event.EventType;
  title: string;
  description: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
  location_url: Option.Option<string>;
  status: Event.EventStatus;
  created_by: TeamMember.TeamMemberId;
  training_type_name: Option.Option<string>;
  created_by_name: Option.Option<string>;
  series_id: Option.Option<string>;
  series_modified: boolean;
  discord_target_channel_id: Option.Option<string>;
  owner_group_id: Option.Option<string>;
  owner_group_name: Option.Option<string>;
  member_group_id: Option.Option<string>;
  member_group_name: Option.Option<string>;
};

let eventsStore: Map<Event.EventId, EventRecord>;

const resetStores = () => {
  seriesStore = new Map();
  seriesStore.set(TEST_SERIES_1, {
    id: TEST_SERIES_1,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    title: 'Weekly Training',
    description: Option.some('Regular training'),
    start_time: '18:00:00',
    end_time: Option.some('20:00:00'),
    location: Option.some('Main Field'),
    location_url: Option.none(),
    frequency: 'weekly',
    days_of_week: [2],
    start_date: DateTime.makeUnsafe('2026-03-03T00:00:00Z'),
    end_date: Option.some(DateTime.makeUnsafe('2026-06-30T00:00:00Z')),
    status: 'active',
    training_type_name: Option.none(),
    last_generated_date: Option.some(DateTime.makeUnsafe('2026-06-30T00:00:00Z')),
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
  });

  eventsStore = new Map();
};

const buildRosterEntry = (
  memberId: TeamMember.TeamMemberId,
  userId: Auth.UserId,
  roleNames: readonly string[],
  permissions: readonly Role.Permission[],
): RosterEntry => {
  const user = usersMap.get(userId);
  if (!user) throw new Error(`User ${userId} not found`);
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

// --- Mock layers ---
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

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: (teamId: string) => {
    const results = Array.from(eventsStore.values()).filter((e) => e.team_id === teamId);
    return Effect.succeed(results);
  },
  findEventsByTeamId: (teamId: string) => {
    const results = Array.from(eventsStore.values()).filter((e) => e.team_id === teamId);
    return Effect.succeed(results);
  },
  findByIdWithDetails: (id: Event.EventId) => {
    const event = eventsStore.get(id);
    if (!event) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(event));
  },
  findEventByIdWithDetails: (id: Event.EventId) => {
    const event = eventsStore.get(id);
    if (!event) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(event));
  },
  insert: (input: {
    team_id: string;
    training_type_id: Option.Option<string>;
    event_type: string;
    title: string;
    description: Option.Option<string>;
    start_at: DateTime.Utc;
    end_at: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    created_by: string;
    series_id: Option.Option<string>;
    owner_group_id: Option.Option<string>;
    member_group_id: Option.Option<string>;
  }) => {
    const id = crypto.randomUUID() as Event.EventId;
    const record: EventRecord = {
      id,
      team_id: input.team_id as Team.TeamId,
      training_type_id: input.training_type_id,
      event_type: input.event_type as Event.EventType,
      title: input.title,
      description: input.description,
      start_at: input.start_at,
      end_at: input.end_at,
      location: input.location,
      location_url: Option.none(),
      status: 'active',
      created_by: input.created_by as TeamMember.TeamMemberId,
      training_type_name: Option.none(),
      created_by_name: Option.none(),
      series_id: input.series_id,
      series_modified: false,
      discord_target_channel_id: Option.none(),
      owner_group_id: input.owner_group_id ?? Option.none(),
      owner_group_name: Option.none(),
      member_group_id: input.member_group_id ?? Option.none(),
      member_group_name: Option.none(),
    };
    eventsStore.set(id, record);
    return Effect.succeed({
      id,
      team_id: record.team_id,
      training_type_id: record.training_type_id,
      event_type: record.event_type,
      title: record.title,
      description: record.description,
      start_at: record.start_at,
      end_at: record.end_at,
      location: record.location,
      location_url: record.location_url,
      status: record.status,
      created_by: record.created_by,
      series_id: record.series_id,
      series_modified: record.series_modified,
      discord_target_channel_id: record.discord_target_channel_id,
      owner_group_id: record.owner_group_id,
      member_group_id: record.member_group_id,
    });
  },
  insertEvent: (input: {
    teamId: string;
    trainingTypeId: Option.Option<string>;
    eventType: string;
    title: string;
    description: Option.Option<string>;
    startAt: DateTime.Utc;
    endAt: Option.Option<DateTime.Utc>;
    location: Option.Option<string>;
    createdBy: string;
    seriesId?: Option.Option<string>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
  }) => {
    const id = crypto.randomUUID() as Event.EventId;
    const record: EventRecord = {
      id,
      team_id: input.teamId as Team.TeamId,
      training_type_id: input.trainingTypeId,
      event_type: input.eventType as Event.EventType,
      title: input.title,
      description: input.description,
      start_at: input.startAt,
      end_at: input.endAt,
      location: input.location,
      location_url: Option.none(),
      status: 'active',
      created_by: input.createdBy as TeamMember.TeamMemberId,
      training_type_name: Option.none(),
      created_by_name: Option.none(),
      series_id: input.seriesId ?? Option.none(),
      series_modified: false,
      discord_target_channel_id: Option.none(),
      owner_group_id: input.ownerGroupId ?? Option.none(),
      owner_group_name: Option.none(),
      member_group_id: input.memberGroupId ?? Option.none(),
      member_group_name: Option.none(),
    };
    eventsStore.set(id, record);
    return Effect.succeed({
      id,
      team_id: record.team_id,
      training_type_id: record.training_type_id,
      event_type: record.event_type,
      title: record.title,
      description: record.description,
      start_at: record.start_at,
      end_at: record.end_at,
      location: record.location,
      location_url: record.location_url,
      status: record.status,
      created_by: record.created_by,
      series_id: record.series_id,
      series_modified: record.series_modified,
      discord_target_channel_id: record.discord_target_channel_id,
      owner_group_id: record.owner_group_id,
      member_group_id: record.member_group_id,
    });
  },
  update: () => Effect.die(new Error('Not needed in series tests')),
  updateEvent: () => Effect.die(new Error('Not needed in series tests')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: (memberId: TeamMember.TeamMemberId) => {
    if (memberId === TEST_CAPTAIN_MEMBER_ID) {
      return Effect.succeed([{ training_type_id: TEST_TRAINING_TYPE_A }]);
    }
    return Effect.succeed([]);
  },
  getScopedTrainingTypeIds: (memberId: TeamMember.TeamMemberId) => {
    if (memberId === TEST_CAPTAIN_MEMBER_ID) {
      return Effect.succeed([{ training_type_id: TEST_TRAINING_TYPE_A }]);
    }
    return Effect.succeed([]);
  },
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
} as any);

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
  insertSeries: (input: {
    team_id: string;
    training_type_id: Option.Option<string>;
    title: string;
    description: Option.Option<string>;
    start_time: string;
    end_time: Option.Option<string>;
    location: Option.Option<string>;
    frequency: string;
    days_of_week: number[];
    start_date: DateTime.Utc;
    end_date: Option.Option<DateTime.Utc>;
    created_by: string;
    owner_group_id: Option.Option<string>;
    member_group_id: Option.Option<string>;
  }) => {
    const id = crypto.randomUUID() as EventSeries.EventSeriesId;
    const record: SeriesRecord = {
      id,
      team_id: input.team_id as Team.TeamId,
      training_type_id: input.training_type_id,
      title: input.title,
      description: input.description,
      start_time: input.start_time,
      end_time: input.end_time,
      location: input.location,
      location_url: Option.none(),
      frequency: input.frequency as 'weekly' | 'biweekly',
      days_of_week: input.days_of_week,
      start_date: input.start_date,
      end_date: input.end_date,
      status: 'active',
      training_type_name: Option.none(),
      last_generated_date: Option.none(),
      discord_target_channel_id: Option.none(),
      owner_group_id: input.owner_group_id ?? Option.none(),
      owner_group_name: Option.none(),
      member_group_id: input.member_group_id ?? Option.none(),
      member_group_name: Option.none(),
    };
    seriesStore.set(id, record);
    return Effect.succeed({
      id,
      team_id: record.team_id,
      training_type_id: record.training_type_id,
      title: record.title,
      description: record.description,
      start_time: record.start_time,
      end_time: record.end_time,
      location: record.location,
      location_url: record.location_url,
      frequency: record.frequency,
      days_of_week: record.days_of_week,
      start_date: record.start_date,
      end_date: record.end_date,
      status: record.status,
      discord_target_channel_id: record.discord_target_channel_id,
      owner_group_id: record.owner_group_id,
      member_group_id: record.member_group_id,
    });
  },
  insertEventSeries: (input: {
    teamId: string;
    trainingTypeId: Option.Option<string>;
    title: string;
    description: Option.Option<string>;
    startTime: string;
    endTime: Option.Option<string>;
    location: Option.Option<string>;
    frequency: string;
    daysOfWeek: number[];
    startDate: DateTime.Utc;
    endDate: Option.Option<DateTime.Utc>;
    createdBy: string;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
  }) => {
    const id = crypto.randomUUID() as EventSeries.EventSeriesId;
    const record: SeriesRecord = {
      id,
      team_id: input.teamId as Team.TeamId,
      training_type_id: input.trainingTypeId,
      title: input.title,
      description: input.description,
      start_time: input.startTime,
      end_time: input.endTime,
      location: input.location,
      location_url: Option.none(),
      frequency: input.frequency as 'weekly' | 'biweekly',
      days_of_week: input.daysOfWeek,
      start_date: input.startDate,
      end_date: input.endDate,
      status: 'active',
      training_type_name: Option.none(),
      last_generated_date: Option.none(),
      discord_target_channel_id: Option.none(),
      owner_group_id: input.ownerGroupId ?? Option.none(),
      owner_group_name: Option.none(),
      member_group_id: input.memberGroupId ?? Option.none(),
      member_group_name: Option.none(),
    };
    seriesStore.set(id, record);
    return Effect.succeed({
      id,
      team_id: record.team_id,
      training_type_id: record.training_type_id,
      title: record.title,
      description: record.description,
      start_time: record.start_time,
      end_time: record.end_time,
      location: record.location,
      location_url: record.location_url,
      frequency: record.frequency,
      days_of_week: record.days_of_week,
      start_date: record.start_date,
      end_date: record.end_date,
      status: record.status,
      discord_target_channel_id: record.discord_target_channel_id,
      owner_group_id: record.owner_group_id,
      member_group_id: record.member_group_id,
    });
  },
  findByTeamId: (teamId: string) => {
    const results = Array.from(seriesStore.values()).filter((s) => s.team_id === teamId);
    return Effect.succeed(results);
  },
  findSeriesByTeamId: (teamId: string) => {
    const results = Array.from(seriesStore.values()).filter((s) => s.team_id === teamId);
    return Effect.succeed(results);
  },
  findById: (id: EventSeries.EventSeriesId) => {
    const s = seriesStore.get(id);
    if (!s) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(s));
  },
  findSeriesById: (id: EventSeries.EventSeriesId) => {
    const s = seriesStore.get(id);
    if (!s) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(s));
  },
  updateSeries: (input: {
    id: EventSeries.EventSeriesId;
    title: string;
    training_type_id: Option.Option<string>;
    description: Option.Option<string>;
    start_time: string;
    end_time: Option.Option<string>;
    location: Option.Option<string>;
    end_date: Option.Option<DateTime.Utc>;
    owner_group_id: Option.Option<string>;
    member_group_id: Option.Option<string>;
  }) => {
    const s = seriesStore.get(input.id);
    if (!s) return Effect.die(new Error('Not found'));
    const updated = {
      ...s,
      title: input.title,
      training_type_id: input.training_type_id,
      description: input.description,
      start_time: input.start_time,
      end_time: input.end_time,
      location: input.location,
      end_date: input.end_date,
      owner_group_id: input.owner_group_id ?? s.owner_group_id,
      member_group_id: input.member_group_id ?? s.member_group_id,
    };
    seriesStore.set(input.id, updated);
    return Effect.succeed({
      id: updated.id,
      team_id: updated.team_id,
      training_type_id: updated.training_type_id,
      title: updated.title,
      description: updated.description,
      start_time: updated.start_time,
      end_time: updated.end_time,
      location: updated.location,
      location_url: updated.location_url,
      frequency: updated.frequency,
      days_of_week: updated.days_of_week,
      start_date: updated.start_date,
      end_date: updated.end_date,
      status: updated.status,
      discord_target_channel_id: updated.discord_target_channel_id,
      owner_group_id: updated.owner_group_id,
      member_group_id: updated.member_group_id,
    });
  },
  updateEventSeries: (input: {
    id: EventSeries.EventSeriesId;
    title: string;
    trainingTypeId: Option.Option<string>;
    description: Option.Option<string>;
    startTime: string;
    endTime: Option.Option<string>;
    location: Option.Option<string>;
    endDate: Option.Option<DateTime.Utc>;
    ownerGroupId?: Option.Option<string>;
    memberGroupId?: Option.Option<string>;
  }) => {
    const s = seriesStore.get(input.id);
    if (!s) return Effect.die(new Error('Not found'));
    const updated = {
      ...s,
      title: input.title,
      training_type_id: input.trainingTypeId,
      description: input.description,
      start_time: input.startTime,
      end_time: input.endTime,
      location: input.location,
      end_date: input.endDate,
      owner_group_id: input.ownerGroupId ?? s.owner_group_id,
      member_group_id: input.memberGroupId ?? s.member_group_id,
    };
    seriesStore.set(input.id, updated);
    return Effect.succeed({
      id: updated.id,
      team_id: updated.team_id,
      training_type_id: updated.training_type_id,
      title: updated.title,
      description: updated.description,
      start_time: updated.start_time,
      end_time: updated.end_time,
      location: updated.location,
      location_url: updated.location_url,
      frequency: updated.frequency,
      days_of_week: updated.days_of_week,
      start_date: updated.start_date,
      end_date: updated.end_date,
      status: updated.status,
      discord_target_channel_id: updated.discord_target_channel_id,
      owner_group_id: updated.owner_group_id,
      member_group_id: updated.member_group_id,
    });
  },
  cancelSeries: (id: EventSeries.EventSeriesId) => {
    const s = seriesStore.get(id);
    if (s) {
      seriesStore.set(id, { ...s, status: 'cancelled' });
    }
    return Effect.void;
  },
  cancelEventSeries: (id: EventSeries.EventSeriesId) => {
    const s = seriesStore.get(id);
    if (s) {
      seriesStore.set(id, { ...s, status: 'cancelled' });
    }
    return Effect.void;
  },
  findActiveForGeneration: () => Effect.succeed([]),
  getActiveForGeneration: () => Effect.succeed([]),
  setLastGeneratedDate: () => Effect.void,
  updateLastGeneratedDate: () => Effect.void,
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

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.succeed({ team_id: TEST_TEAM_ID, event_horizon_days: 30 }),
  upsert: () => Effect.succeed({ team_id: TEST_TEAM_ID, event_horizon_days: 30 }),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
  delete: () => Effect.void,
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

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
  findByCode: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  create: () => Effect.die(new Error('Not implemented')),
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
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(MockEventsRepositoryLayer, MockEventSeriesRepositoryLayer),
        MockEventRsvpsRepositoryLayer,
      ),
      MockTeamSettingsRepositoryLayer,
    ),
  ),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockAgeCheckServiceLayer),
  Layer.provide(MockAgeThresholdRepositoryLayer),
  Layer.provide(Layer.merge(MockNotificationsRepositoryLayer, MockRoleSyncEventsRepositoryLayer)),
  Layer.provide(
    Layer.merge(
      Layer.merge(MockChannelSyncEventsRepositoryLayer, MockEventSyncEventsRepositoryLayer),
      MockICalTokensRepositoryLayer,
    ),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          MockDiscordChannelMappingRepositoryLayer,
          Layer.succeed(BotGuildsRepository, {
            upsert: () => Effect.void,
            remove: () => Effect.void,
            exists: () => Effect.succeed(false),
            findAll: () => Effect.succeed([]),
          } as any),
        ),
        Layer.merge(MockDiscordChannelsRepositoryLayer, MockDiscordRolesRepositoryLayer),
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

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/event-series`;

describe('Event Series API', () => {
  const createPayload = {
    title: 'Weekly Training',
    trainingTypeId: null,
    description: 'Regular session',
    frequency: 'weekly',
    daysOfWeek: [2],
    startDate: '2026-03-03',
    endDate: '2026-03-31',
    startTime: '18:00',
    endTime: '20:00',
    location: 'Main Field',
    discordChannelId: null,
    ownerGroupId: null,
    memberGroupId: null,
  };

  describe('POST /teams/:teamId/event-series (create)', () => {
    it('returns 201 for admin creating series', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPayload),
        }),
      );
      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body.title).toBe('Weekly Training');
      expect(body.frequency).toBe('weekly');
      expect(body.daysOfWeek).toEqual([2]);
      // Should also have created materialized events
      expect(eventsStore.size).toBeGreaterThan(0);
    });

    it('returns 201 for captain creating series', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPayload),
        }),
      );
      expect(response.status).toBe(201);
    });

    it('returns 403 for player creating series', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(createPayload),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('captain cannot create series with disallowed training type', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...createPayload,
            trainingTypeId: TEST_TRAINING_TYPE_B,
          }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('captain can create series with allowed training type', async () => {
      const response = await handler(
        new Request(BASE, {
          method: 'POST',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            ...createPayload,
            trainingTypeId: TEST_TRAINING_TYPE_A,
          }),
        }),
      );
      expect(response.status).toBe(201);
    });
  });

  describe('GET /teams/:teamId/event-series (list)', () => {
    it('returns series for team', async () => {
      const response = await handler(
        new Request(BASE, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body).toHaveLength(1);
      expect(body[0].title).toBe('Weekly Training');
    });
  });

  describe('GET /teams/:teamId/event-series/:seriesId (get)', () => {
    it('returns 200 for valid series', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe('Weekly Training');
      expect(body.canEdit).toBe(true);
      expect(body.canCancel).toBe(true);
    });

    it('returns 404 for unknown series', async () => {
      const unknownId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`${BASE}/${unknownId}`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /teams/:teamId/event-series/:seriesId (update)', () => {
    it('returns 200 for admin updating series', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Updated Training' }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe('Updated Training');
    });

    it('returns 403 for player updating series', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Should Fail' }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 400 when updating cancelled series', async () => {
      const s = seriesStore.get(TEST_SERIES_1);
      if (s) seriesStore.set(TEST_SERIES_1, { ...s, status: 'cancelled' });
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Try Update' }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('captain can update series with allowed training type', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Captain Update', trainingTypeId: TEST_TRAINING_TYPE_A }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe('Captain Update');
    });

    it('captain cannot update series with disallowed training type', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Captain Update', trainingTypeId: TEST_TRAINING_TYPE_B }),
        }),
      );
      expect(response.status).toBe(403);
    });

    it('captain can update series with no training type', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}`, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer captain-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ title: 'Captain Update No Type', trainingTypeId: null }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.title).toBe('Captain Update No Type');
    });
  });

  describe('POST /teams/:teamId/event-series/:seriesId/cancel', () => {
    it('returns 204 for admin cancelling series', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}/cancel`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(204);
      const s = seriesStore.get(TEST_SERIES_1);
      expect(s?.status).toBe('cancelled');
    });

    it('returns 403 for player cancelling series', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}/cancel`, {
          method: 'POST',
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('returns 400 when cancelling already cancelled series', async () => {
      const s = seriesStore.get(TEST_SERIES_1);
      if (s) seriesStore.set(TEST_SERIES_1, { ...s, status: 'cancelled' });
      const response = await handler(
        new Request(`${BASE}/${TEST_SERIES_1}/cancel`, {
          method: 'POST',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(400);
    });
  });
});
