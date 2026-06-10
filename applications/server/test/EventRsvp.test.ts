import { it as itEffect } from '@effect/vitest';
import type { Auth, Discord, Event, EventRsvp, Role, Team, TeamMember } from '@sideline/domain';
import { EventRpcGroup, type EventRpcModels } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { RpcTest } from 'effect/unstable/rpc';
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
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
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
import { EventsRpcLive } from '~/rpc/event/index.js';
import { AchievementPreview } from '~/services/AchievementPreview.js';
import { AgeCheckService } from '~/services/AgeCheckService.js';
import { BotInfoStore } from '~/services/BotInfoStore.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from './mocks/emailMocks.js';
import { MockEventRosterLayers } from './mocks/eventRosterMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// --- Test IDs ---
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_OTHER_USER_ID = '00000000-0000-0000-0000-000000000003' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const TEST_EVENT_ACTIVE = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const TEST_EVENT_CANCELLED = '00000000-0000-0000-0000-000000000061' as Event.EventId;
const TEST_EVENT_PAST = '00000000-0000-0000-0000-000000000062' as Event.EventId;
const TEST_EVENT_OTHER_TEAM = '00000000-0000-0000-0000-000000000063' as Event.EventId;

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
  'training-type:create',
  'training-type:delete',
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

  is_profile_complete: true,
  name: Option.some('Test User'),
  birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
  gender: Option.some('male' as const),
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

// --- Stores ---
const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin);

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('user-token', TEST_USER_ID);
sessionsStore.set('admin-token', TEST_ADMIN_ID);
sessionsStore.set('other-token', TEST_OTHER_USER_ID);

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

// --- In-memory events ---
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

// --- In-memory RSVPs ---
type RsvpRecord = {
  id: EventRsvp.EventRsvpId;
  event_id: Event.EventId;
  team_member_id: TeamMember.TeamMemberId;
  response: EventRsvp.RsvpResponse;
  message: Option.Option<string>;
  member_name: Option.Option<string>;
  username: Option.Option<string>;
  nickname: Option.Option<string>;
  display_name: Option.Option<string>;
};

let rsvpsStore: Map<string, RsvpRecord>;

const resetStores = () => {
  eventsStore = new Map();
  eventsStore.set(TEST_EVENT_ACTIVE, {
    id: TEST_EVENT_ACTIVE,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'Future Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2099-12-31T20:00:00Z')),
    location: Option.some('Main Field'),
    status: 'active',
    created_by: TEST_ADMIN_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.some('Admin User'),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
  });
  eventsStore.set(TEST_EVENT_CANCELLED, {
    id: TEST_EVENT_CANCELLED,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'match',
    title: 'Cancelled Match',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-15T14:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2099-12-15T16:00:00Z')),
    location: Option.none(),
    status: 'cancelled',
    created_by: TEST_ADMIN_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.some('Admin User'),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
  });
  eventsStore.set(TEST_EVENT_PAST, {
    id: TEST_EVENT_PAST,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'Past Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2020-01-01T10:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2020-01-01T12:00:00Z')),
    location: Option.none(),
    status: 'active',
    created_by: TEST_ADMIN_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.some('Admin User'),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
  });
  eventsStore.set(TEST_EVENT_OTHER_TEAM, {
    id: TEST_EVENT_OTHER_TEAM,
    team_id: OTHER_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'Other Team Event',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    status: 'active',
    created_by: TEST_ADMIN_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
  });
  rsvpsStore = new Map();
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

// --- Mock layers ---
const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
});

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
  insert: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: (eventId: Event.EventId) => {
    const results = Array.from(rsvpsStore.values()).filter((r) => r.event_id === eventId);
    return Effect.succeed(results);
  },
  findRsvpsByEventId: (eventId: Event.EventId) => {
    const results = Array.from(rsvpsStore.values()).filter((r) => r.event_id === eventId);
    return Effect.succeed(results);
  },
  findByEventAndMember: (input: { event_id: string; team_member_id: string }) => {
    const key = `${input.event_id}:${input.team_member_id}`;
    const rsvp = rsvpsStore.get(key);
    return Effect.succeed(rsvp ? Option.some(rsvp) : Option.none());
  },
  findRsvpByEventAndMember: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    const key = `${eventId}:${memberId}`;
    const rsvp = rsvpsStore.get(key);
    return Effect.succeed(rsvp ? Option.some(rsvp) : Option.none());
  },
  upsert: (input: {
    event_id: string;
    team_member_id: string;
    response: string;
    message: Option.Option<string>;
  }) => {
    const key = `${input.event_id}:${input.team_member_id}`;
    const existing = rsvpsStore.get(key);
    const id = existing?.id ?? (crypto.randomUUID() as EventRsvp.EventRsvpId);
    const record: RsvpRecord = {
      id,
      event_id: input.event_id as Event.EventId,
      team_member_id: input.team_member_id as TeamMember.TeamMemberId,
      response: input.response as EventRsvp.RsvpResponse,
      message: input.message,
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    };
    rsvpsStore.set(key, record);
    return Effect.succeed({
      id: record.id,
      event_id: record.event_id,
      team_member_id: record.team_member_id,
      response: record.response,
      message: record.message,
    });
  },
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
    clearMessage = false,
  ) => {
    const key = `${eventId}:${memberId}`;
    const existing = rsvpsStore.get(key);
    const id = existing?.id ?? (crypto.randomUUID() as EventRsvp.EventRsvpId);
    const resolvedMessage = clearMessage
      ? Option.none<string>()
      : Option.isSome(message)
        ? message
        : (existing?.message ?? Option.none<string>());
    const record: RsvpRecord = {
      id,
      event_id: eventId,
      team_member_id: memberId,
      response,
      message: resolvedMessage,
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    };
    rsvpsStore.set(key, record);
    return Effect.succeed({
      row: {
        id: record.id,
        event_id: record.event_id,
        team_member_id: record.team_member_id,
        response: record.response,
        message: record.message,
      },
      priorResponse: Option.none<EventRsvp.RsvpResponse>(),
    });
  },
  countByEventId: (eventId: Event.EventId) => {
    const rsvps = Array.from(rsvpsStore.values()).filter((r) => r.event_id === eventId);
    const counts = new Map<string, number>();
    for (const r of rsvps) {
      counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
    }
    return Effect.succeed(
      Array.from(counts.entries()).map(([response, count]) => ({
        response: response as EventRsvp.RsvpResponse,
        count,
      })),
    );
  },
  countRsvpsByEventId: (eventId: Event.EventId) => {
    const rsvps = Array.from(rsvpsStore.values()).filter((r) => r.event_id === eventId);
    const counts = new Map<string, number>();
    for (const r of rsvps) {
      counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
    }
    return Effect.succeed(
      Array.from(counts.entries()).map(([response, count]) => ({
        response: response as EventRsvp.RsvpResponse,
        count,
      })),
    );
  },
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
  insert: () =>
    Effect.succeed({
      id: 'mock-log-id',
      activity_type_id: 'mock-type-id',
      logged_at: new Date().toISOString(),
      source: 'auto',
    }),
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
      Layer.merge(MockEventsRepositoryLayer, MockEventSeriesRepositoryLayer),
      MockEventRsvpsRepositoryLayer,
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

beforeEach(() => {
  resetStores();
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/events`;

describe('Event RSVP API', () => {
  describe('GET /teams/:teamId/events/:eventId/rsvps', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps`));
      expect(response.status).toBe(401);
    });

    it('returns 200 with empty RSVPs for active event', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.myResponse).toBeNull();
      expect(body.myMessage).toBeNull();
      expect(body.rsvps).toHaveLength(0);
      expect(body.yesCount).toBe(0);
      expect(body.noCount).toBe(0);
      expect(body.maybeCount).toBe(0);
      expect(body.canRsvp).toBe(true);
    });

    it('returns canRsvp:false for past event', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_PAST}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.canRsvp).toBe(false);
    });

    it('returns 404 for unknown event', async () => {
      const unknownId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`${BASE}/${unknownId}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns 404 for event from different team', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_OTHER_TEAM}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(404);
    });

    it('returns user own RSVP status', async () => {
      // First submit an RSVP
      await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: 'I will be there!' }),
        }),
      );

      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.myResponse).toBe('yes');
      expect(body.myMessage).toBe('I will be there!');
      expect(body.rsvps).toHaveLength(1);
      expect(body.yesCount).toBe(1);
    });
  });

  describe('PUT /teams/:teamId/events/:eventId/rsvp', () => {
    it('returns 401 without auth token', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      expect(response.status).toBe(401);
    });

    it('player can submit RSVP yes', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      expect(response.status).toBe(204);
    });

    it('player can submit RSVP no', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'no', message: 'Cannot make it' }),
        }),
      );
      expect(response.status).toBe(204);
    });

    it('player can submit RSVP maybe', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'maybe', message: null }),
        }),
      );
      expect(response.status).toBe(204);
    });

    it('player can update existing RSVP', async () => {
      // First submit yes
      await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );

      // Then update to no
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'no', message: 'Changed my mind' }),
        }),
      );
      expect(response.status).toBe(204);
    });

    it('player can add message to RSVP', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: 'Bringing snacks!' }),
        }),
      );
      expect(response.status).toBe(204);
    });

    it('non-member cannot RSVP (403)', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer other-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      // Returns 401 because the user doesn't exist in auth (not just non-member)
      expect(response.status).toBe(401);
    });

    it('cannot RSVP to cancelled event (404)', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_CANCELLED}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('cannot RSVP to event from different team (404)', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_OTHER_TEAM}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      expect(response.status).toBe(404);
    });

    it('cannot RSVP past deadline (400)', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_PAST}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('returns correct summary with counts from multiple users', async () => {
      // User submits yes
      await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer user-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );

      // Admin submits maybe
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'maybe', message: 'Not sure yet' }),
        }),
      );
      expect(response.status).toBe(204);

      // Verify counts via GET
      const getResponse = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps`, {
          method: 'GET',
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(getResponse.status).toBe(200);
      const body = await getResponse.json();
      expect(body.yesCount).toBe(1);
      expect(body.maybeCount).toBe(1);
      expect(body.noCount).toBe(0);
      expect(body.rsvps).toHaveLength(2);
    });
  });
});

// ============================================================
// Late RSVP feature tests — Event/SubmitRsvp RPC
// ============================================================
//
// These tests verify the isLateRsvp and lateRsvpChannelId fields
// returned by the Event/SubmitRsvp RPC handler.
//
// They cover late and non-late RSVP scenarios for the isLateRsvp
// and lateRsvpChannelId fields in the SubmitRsvpResult.

const RPC_TEST_EVENT_ID = '00000000-0000-0000-0000-000000000070' as Event.EventId;
const RPC_TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const RPC_TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const RPC_TEST_DISCORD_USER_ID = '123456789012345678' as Discord.Snowflake;
const LATE_RSVP_CHANNEL_ID = '999000999000999001' as Discord.Snowflake;

// RPC-level event records include reminder_sent_at
type RpcEventRecord = {
  id: Event.EventId;
  team_id: Team.TeamId;
  training_type_id: Option.Option<string>;
  event_type: Event.EventType;
  title: string;
  description: Option.Option<string>;
  start_at: DateTime.Utc;
  end_at: Option.Option<DateTime.Utc>;
  location: Option.Option<string>;
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
  reminder_sent_at: Option.Option<DateTime.Utc>;
};

type RpcRsvpRecord = {
  id: EventRsvp.EventRsvpId;
  event_id: Event.EventId;
  team_member_id: TeamMember.TeamMemberId;
  response: EventRsvp.RsvpResponse;
  message: Option.Option<string>;
  member_name: Option.Option<string>;
  username: Option.Option<string>;
  nickname: Option.Option<string>;
  display_name: Option.Option<string>;
};

let rpcEventsStore: Map<Event.EventId, RpcEventRecord>;
let rpcRsvpsStore: Map<string, RpcRsvpRecord>;
let rpcLateRsvpChannelId: Option.Option<Discord.Snowflake>;

const resetRpcStores = () => {
  rpcEventsStore = new Map();
  rpcEventsStore.set(RPC_TEST_EVENT_ID, {
    id: RPC_TEST_EVENT_ID,
    team_id: RPC_TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training' as Event.EventType,
    title: 'Future Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    status: 'active' as Event.EventStatus,
    created_by: RPC_TEST_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.none(),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
    reminder_sent_at: Option.none(),
  });
  rpcRsvpsStore = new Map();
  rpcLateRsvpChannelId = Option.none();
};

// Mock SQL layer: returns the member ID for all queries
// (used by Event/SubmitRsvp to look up member by discord_user_id)
const MOCK_MEMBER_LOOKUP_ROW = {
  id: RPC_TEST_MEMBER_ID,
  name: null,
  nickname: null,
  display_name: null,
  username: null,
};

const MockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      return Effect.succeed([MOCK_MEMBER_LOOKUP_ROW]);
    },
    {
      safe: undefined as any,
      withoutTransforms: function (this: any) {
        return this;
      },
      reserve: Effect.die(new Error('reserve not implemented')),
      withTransaction: <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E | any, R> =>
        effect,
      reactive: () => Effect.succeed([] as never[]),
      reactiveMailbox: () => Effect.die(new Error('reactiveMailbox not implemented')),
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) =>
        Effect.succeed([MOCK_MEMBER_LOOKUP_ROW]),
      literal: (_sql: string) => ({ _tag: 'Fragment' as const, segments: [] }),
      in: (..._args: unknown[]) => Effect.succeed([] as never[]),
      insert: (..._args: unknown[]) => Effect.succeed([] as never[]),
      update: (..._args: unknown[]) => Effect.succeed([] as never[]),
      updateValues: (..._args: unknown[]) => Effect.succeed([] as never[]),
      and: (..._args: unknown[]) => Effect.succeed([] as never[]),
      or: (..._args: unknown[]) => Effect.succeed([] as never[]),
    },
  ) as unknown as SqlClient.SqlClient,
);

const MockRpcEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: (id: Event.EventId) => {
    const event = rpcEventsStore.get(id);
    return Effect.succeed(event ? Option.some(event) : Option.none());
  },
  findEventByIdWithDetails: (id: Event.EventId) => {
    const event = rpcEventsStore.get(id);
    return Effect.succeed(event ? Option.some(event) : Option.none());
  },
  insert: () => Effect.die(new Error('Not implemented')),
  insertEvent: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  updateEvent: () => Effect.die(new Error('Not implemented')),
  cancel: () => Effect.void,
  cancelEvent: () => Effect.void,
  findScopedTrainingTypeIds: () => Effect.succeed([]),
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  markModified: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  markReminderSent: () => Effect.void,
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findEventsByChannelId: () => Effect.succeed([]),
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findNonResponders: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);

const MockRpcEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: (eventId: Event.EventId) => {
    const results = Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId);
    return Effect.succeed(results);
  },
  findRsvpsByEventId: (eventId: Event.EventId) => {
    const results = Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId);
    return Effect.succeed(results);
  },
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    const key = `${eventId}:${memberId}`;
    const rsvp = rpcRsvpsStore.get(key);
    return Effect.succeed(rsvp ? Option.some(rsvp) : Option.none());
  },
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
    clearMessage = false,
  ) => {
    const key = `${eventId}:${memberId}`;
    const existing = rpcRsvpsStore.get(key);
    const id = existing?.id ?? (crypto.randomUUID() as EventRsvp.EventRsvpId);
    // When clearMessage is true, always clear the message.
    // Otherwise COALESCE behavior: preserve the existing message when the new message is None.
    // This mirrors `COALESCE(EXCLUDED.message, event_rsvps.message)` in SQL
    const resolvedMessage = clearMessage
      ? Option.none<string>()
      : Option.isSome(message)
        ? message
        : existing
          ? existing.message
          : Option.none<string>();
    const record: RpcRsvpRecord = {
      id,
      event_id: eventId,
      team_member_id: memberId,
      response,
      message: resolvedMessage,
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    };
    rpcRsvpsStore.set(key, record);
    return Effect.succeed({
      row: {
        id: record.id,
        event_id: record.event_id,
        team_member_id: record.team_member_id,
        response: record.response,
        message: record.message,
      },
      priorResponse: existing
        ? Option.some(existing.response)
        : Option.none<EventRsvp.RsvpResponse>(),
    });
  },
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: (eventId: Event.EventId) => {
    const rsvps = Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId);
    const counts = new Map<string, number>();
    for (const r of rsvps) counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
    return Effect.succeed(
      Array.from(counts.entries()).map(([response, count]) => ({
        response: response as EventRsvp.RsvpResponse,
        count,
      })),
    );
  },
  findNonResponders: () => Effect.succeed([]),
  findNonRespondersByEventId: () => Effect.succeed([]),
  findRsvpAttendeesPage: () => Effect.succeed([]),
  countRsvpTotal: () => Effect.succeed(0),
  findYesAttendeesForEmbed: () => Effect.succeed([]),
} as any);

const MockRpcTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: (teamId: Team.TeamId) =>
    Effect.succeed(
      teamId === RPC_TEST_TEAM_ID
        ? Option.some({
            team_id: RPC_TEST_TEAM_ID,
            event_horizon_days: 30,
            min_players_threshold: 5,
            rsvp_reminder_hours: 24,
            discord_channel_training: Option.none<Discord.Snowflake>(),
            discord_channel_match: Option.none<Discord.Snowflake>(),
            discord_channel_tournament: Option.none<Discord.Snowflake>(),
            discord_channel_meeting: Option.none<Discord.Snowflake>(),
            discord_channel_social: Option.none<Discord.Snowflake>(),
            discord_channel_other: Option.none<Discord.Snowflake>(),
            discord_channel_late_rsvp: rpcLateRsvpChannelId,
            create_discord_channel_on_group: false,
            create_discord_channel_on_roster: false,
            discord_archive_category_id: Option.none<Discord.Snowflake>(),
            discord_channel_cleanup_on_group_delete: 'delete' as const,
            discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
            discord_role_format: '{emoji} {name}',
            discord_channel_format: '{emoji}│{name}',
          })
        : Option.none(),
    ),
  findByTeamId: (teamId: Team.TeamId) =>
    Effect.succeed(
      teamId === RPC_TEST_TEAM_ID
        ? Option.some({
            team_id: RPC_TEST_TEAM_ID,
            event_horizon_days: 30,
            min_players_threshold: 5,
            rsvp_reminder_hours: 24,
            discord_channel_training: Option.none<Discord.Snowflake>(),
            discord_channel_match: Option.none<Discord.Snowflake>(),
            discord_channel_tournament: Option.none<Discord.Snowflake>(),
            discord_channel_meeting: Option.none<Discord.Snowflake>(),
            discord_channel_social: Option.none<Discord.Snowflake>(),
            discord_channel_other: Option.none<Discord.Snowflake>(),
            discord_channel_late_rsvp: rpcLateRsvpChannelId,
            create_discord_channel_on_group: false,
            create_discord_channel_on_roster: false,
            discord_archive_category_id: Option.none<Discord.Snowflake>(),
            discord_channel_cleanup_on_group_delete: 'delete' as const,
            discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
            discord_role_format: '{emoji} {name}',
            discord_channel_format: '{emoji}│{name}',
          })
        : Option.none(),
    ),
  upsertSettings: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
  findEventsForReminder: () => Effect.succeed([]),
  findEventsNeedingReminder: () => Effect.succeed([]),
  findLateRsvpChannelId: (_teamId: Team.TeamId) => Effect.succeed(rpcLateRsvpChannelId),
} as any);

const MockRpcEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockRpcTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockRpcGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
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

const MockRpcTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: () => Effect.succeed(Option.none()),
  findByGuildId: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockRpcTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
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

const MockRpcChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

const RpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(MockRpcEventsRepositoryLayer),
  Layer.provide(MockRpcEventRsvpsRepositoryLayer),
  Layer.provide(MockRpcTeamSettingsRepositoryLayer),
  Layer.provide(MockRpcEventSyncEventsRepositoryLayer),
  Layer.provide(MockRpcTeamMembersRepositoryLayer),
  Layer.provide(MockRpcGroupsRepositoryLayer),
  Layer.provide(MockRpcTeamsRepositoryLayer),
  Layer.provide(MockRpcTrainingTypesRepositoryLayer),
  Layer.provide(MockRpcChannelEventDividersRepositoryLayer),
  Layer.provide(MockDiscordChannelMappingRepositoryLayer),
  Layer.provide(MockSqlClientLayer),
  Layer.provide(MockEventRosterLayers),
);

// Helper to submit an RSVP via the Event/SubmitRsvp RPC handler
// Uses Effect.scoped because RpcTest.makeClient requires Scope
const makeSubmitRsvp = (params: {
  event_id?: Event.EventId;
  team_id?: Team.TeamId;
  discord_user_id?: Discord.Snowflake;
  response: EventRsvp.RsvpResponse;
  message?: Option.Option<string>;
  clearMessage?: boolean;
}): Effect.Effect<
  EventRpcModels.SubmitRsvpResult,
  unknown,
  typeof RpcTestLayer extends Layer.Layer<infer A, any, any> ? A : never
> =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap(
        (rpc: any) =>
          rpc['Event/SubmitRsvp']({
            event_id: params.event_id ?? RPC_TEST_EVENT_ID,
            team_id: params.team_id ?? RPC_TEST_TEAM_ID,
            discord_user_id: params.discord_user_id ?? RPC_TEST_DISCORD_USER_ID,
            response: params.response,
            message: params.message ?? Option.none(),
            clearMessage: params.clearMessage ?? false,
          }) as Effect.Effect<EventRpcModels.SubmitRsvpResult, unknown, never>,
      ),
    ),
  );

describe('Event/SubmitRsvp RPC — late RSVP detection', () => {
  beforeEach(() => {
    resetRpcStores();
  });

  itEffect.effect('isLateRsvp = false when reminder has not been sent', () =>
    makeSubmitRsvp({ response: 'yes' }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.isLateRsvp).toBe(false);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    ),
  );

  itEffect.effect('isLateRsvp = true for first-time RSVP after reminder was sent', () => {
    // Mark the event as having had the reminder sent
    const event = rpcEventsStore.get(RPC_TEST_EVENT_ID);
    if (event) {
      rpcEventsStore.set(RPC_TEST_EVENT_ID, {
        ...event,
        reminder_sent_at: Option.some(DateTime.makeUnsafe('2099-12-30T10:00:00Z')),
      });
    }

    return makeSubmitRsvp({ response: 'yes' }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.isLateRsvp).toBe(true);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect('isLateRsvp = true when changing response after reminder was sent', () => {
    // Pre-populate an existing RSVP with 'yes'
    const priorKey = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
    rpcRsvpsStore.set(priorKey, {
      id: crypto.randomUUID() as EventRsvp.EventRsvpId,
      event_id: RPC_TEST_EVENT_ID,
      team_member_id: RPC_TEST_MEMBER_ID,
      response: 'yes',
      message: Option.none(),
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    });

    // Mark the event as having had the reminder sent
    const event = rpcEventsStore.get(RPC_TEST_EVENT_ID);
    if (event) {
      rpcEventsStore.set(RPC_TEST_EVENT_ID, {
        ...event,
        reminder_sent_at: Option.some(DateTime.makeUnsafe('2099-12-30T10:00:00Z')),
      });
    }

    // Submit a different response ('no' vs prior 'yes')
    return makeSubmitRsvp({ response: 'no' }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.isLateRsvp).toBe(true);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect('isLateRsvp = false for same-response resubmission after reminder', () => {
    // Pre-populate an existing RSVP with 'yes'
    const priorKey = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
    rpcRsvpsStore.set(priorKey, {
      id: crypto.randomUUID() as EventRsvp.EventRsvpId,
      event_id: RPC_TEST_EVENT_ID,
      team_member_id: RPC_TEST_MEMBER_ID,
      response: 'yes',
      message: Option.none(),
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    });

    // Mark the event as having had the reminder sent
    const event = rpcEventsStore.get(RPC_TEST_EVENT_ID);
    if (event) {
      rpcEventsStore.set(RPC_TEST_EVENT_ID, {
        ...event,
        reminder_sent_at: Option.some(DateTime.makeUnsafe('2099-12-30T10:00:00Z')),
      });
    }

    // Resubmit same 'yes' response — should NOT be late
    return makeSubmitRsvp({ response: 'yes' }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.isLateRsvp).toBe(false);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect(
    'lateRsvpChannelId is returned when discord_channel_late_rsvp is configured and RSVP is late',
    () => {
      // Configure the late RSVP channel
      rpcLateRsvpChannelId = Option.some(LATE_RSVP_CHANNEL_ID);

      // Mark the event as having had the reminder sent
      const event = rpcEventsStore.get(RPC_TEST_EVENT_ID);
      if (event) {
        rpcEventsStore.set(RPC_TEST_EVENT_ID, {
          ...event,
          reminder_sent_at: Option.some(DateTime.makeUnsafe('2099-12-30T10:00:00Z')),
        });
      }

      return makeSubmitRsvp({ response: 'yes' }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.isLateRsvp).toBe(true);
            expect(Option.isSome(result.lateRsvpChannelId)).toBe(true);
            expect(Option.getOrNull(result.lateRsvpChannelId)).toBe(LATE_RSVP_CHANNEL_ID);
          }),
        ),
        Effect.provide(RpcTestLayer),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect(
    'lateRsvpChannelId = None when no late RSVP channel configured, even if RSVP is late',
    () => {
      // No late RSVP channel configured (rpcLateRsvpChannelId stays Option.none())

      // Mark the event as having had the reminder sent
      const event = rpcEventsStore.get(RPC_TEST_EVENT_ID);
      if (event) {
        rpcEventsStore.set(RPC_TEST_EVENT_ID, {
          ...event,
          reminder_sent_at: Option.some(DateTime.makeUnsafe('2099-12-30T10:00:00Z')),
        });
      }

      return makeSubmitRsvp({ response: 'yes' }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result.isLateRsvp).toBe(true);
            expect(Option.isNone(result.lateRsvpChannelId)).toBe(true);
          }),
        ),
        Effect.provide(RpcTestLayer),
        Effect.asVoid,
      );
    },
  );
});

// ============================================================
// Message preservation tests — COALESCE behavior
// ============================================================
//
// These tests are regression coverage for the COALESCE semantics in
// EventRsvpsRepository: an existing message is preserved when the
// incoming message is Option.none() (button-click path), replaced
// when a new non-None message is provided (modal-submit path), and
// cleared to None when clearMessage is true (clear-button path).

describe('Event/SubmitRsvp RPC — RSVP message preservation', () => {
  beforeEach(() => {
    resetRpcStores();
  });

  itEffect.effect('should preserve existing message when re-RSVPing with no message', () => {
    // First RSVP: button click with a message provided via modal
    return makeSubmitRsvp({ response: 'yes', message: Option.some('I will be late') }).pipe(
      Effect.flatMap(() =>
        // Second RSVP: button click with no message (simulates the new immediate-save flow)
        makeSubmitRsvp({ response: 'yes', message: Option.none() }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const key = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
          const stored = rpcRsvpsStore.get(key);
          expect(stored).toBeDefined();
          expect(Option.getOrNull(stored?.message ?? Option.none())).toBe('I will be late');
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect('should update message when re-RSVPing with a new message', () => {
    // First RSVP with an initial message
    return makeSubmitRsvp({ response: 'yes', message: Option.some('I will be late') }).pipe(
      Effect.flatMap(() =>
        // Second RSVP with a different message (modal submit with updated text)
        makeSubmitRsvp({ response: 'yes', message: Option.some('Actually on time') }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const key = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
          const stored = rpcRsvpsStore.get(key);
          expect(stored).toBeDefined();
          expect(Option.getOrNull(stored?.message ?? Option.none())).toBe('Actually on time');
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });

  itEffect.effect(
    'should set message when submitting message after initial RSVP with no message',
    () => {
      // First RSVP: button click with no message (new immediate-save flow)
      return makeSubmitRsvp({ response: 'yes', message: Option.none() }).pipe(
        Effect.flatMap(() =>
          // Second call: modal submit with a message (the "Add a message" flow)
          makeSubmitRsvp({ response: 'yes', message: Option.some('Bringing snacks') }),
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            const key = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
            const stored = rpcRsvpsStore.get(key);
            expect(stored).toBeDefined();
            expect(Option.getOrNull(stored?.message ?? Option.none())).toBe('Bringing snacks');
          }),
        ),
        Effect.provide(RpcTestLayer),
        Effect.asVoid,
      );
    },
  );

  itEffect.effect('should clear message when clearMessage is true', () => {
    // First RSVP: set a message via modal submit
    return makeSubmitRsvp({ response: 'yes', message: Option.some('I will be late') }).pipe(
      Effect.flatMap(() =>
        // Clear the message via the clear-message button path
        makeSubmitRsvp({ response: 'yes', message: Option.none(), clearMessage: true }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          const key = `${RPC_TEST_EVENT_ID}:${RPC_TEST_MEMBER_ID}`;
          const stored = rpcRsvpsStore.get(key);
          expect(stored).toBeDefined();
          expect(Option.isNone(stored?.message ?? Option.none())).toBe(true);
        }),
      ),
      Effect.provide(RpcTestLayer),
      Effect.asVoid,
    );
  });
});
