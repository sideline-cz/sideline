// NOTE: TDD mode — tests will FAIL until the EventRoster HTTP API handler
// is implemented and wired into ApiLive.

import type {
  Auth,
  Discord,
  Event,
  EventRosterModel,
  GroupModel,
  Role,
  RosterModel,
  Team,
  TeamMember,
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
import { ChannelEventDividersRepository } from '~/repositories/ChannelEventDividersRepository.js';
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
import { EventRosterProvisioningService } from '~/services/EventRosterProvisioningService.js';
import { GlobalAdminAllowlist } from '~/services/GlobalAdminAllowlist.js';
import { MockChannelManagementLayers } from '../mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockEmailLayers } from '../mocks/emailMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockPlayerRatingsRepositoryLayer } from '../mocks/playerRatingMocks.js';
import { MockTeamChallengeRepositoryLayer } from '../mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// IDs
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_EVENT_ID = '00000000-0000-0000-0000-000000000060' as Event.EventId;
const TEST_ROSTER_ID = '00000000-0000-0000-0000-000000000030' as RosterModel.RosterId;
const TEST_EVENT_ROSTER_ID = 'event-roster-001' as EventRosterModel.EventRosterId;
const TEST_REQUEST_ID = 'request-001' as EventRosterModel.EventRosterRequestId;

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
  'event:create',
  'event:edit',
  'event:cancel',
];
const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const testUser = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Test User'),
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
  birth_date: Option.none(),
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

const usersMap = new Map<Auth.UserId, typeof testUser>([
  [TEST_USER_ID, testUser],
  [TEST_ADMIN_ID, testAdmin],
]);

const sessionsStore = new Map<string, Auth.UserId>([
  ['user-token', TEST_USER_ID],
  ['admin-token', TEST_ADMIN_ID],
]);

const membersStore = new Map<string, MembershipWithRole>([
  [
    TEST_MEMBER_ID,
    {
      id: TEST_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
    },
  ],
  [
    TEST_ADMIN_MEMBER_ID,
    {
      id: TEST_ADMIN_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_ADMIN_ID,
      active: true,
      role_names: ['Admin'],
      permissions: ADMIN_PERMISSIONS,
    },
  ],
]);

// Mutable state for event roster
let eventRosterStore: Map<
  Event.EventId,
  {
    id: EventRosterModel.EventRosterId;
    event_id: Event.EventId;
    roster_id: RosterModel.RosterId;
    auto_approve: boolean;
    owners_thread_id: Option.Option<Discord.Snowflake>;
    roster_name: string;
    owner_group_id: Option.Option<string>;
    member_count: number;
  }
>;

let pendingRequestsStore: Map<
  EventRosterModel.EventRosterRequestId,
  {
    id: EventRosterModel.EventRosterRequestId;
    event_id: Event.EventId;
    roster_id: RosterModel.RosterId;
    team_member_id: TeamMember.TeamMemberId;
    event_title: string;
    discord_id: Option.Option<Discord.Snowflake>;
    display_name: Option.Option<string>;
    requested_at: string;
  }
>;

let backfillCallCount: number;
let approveCallCount: number;
let declineCallCount: number;

const resetState = () => {
  eventRosterStore = new Map();
  pendingRequestsStore = new Map([
    [
      TEST_REQUEST_ID,
      {
        id: TEST_REQUEST_ID,
        event_id: TEST_EVENT_ID,
        roster_id: TEST_ROSTER_ID,
        team_member_id: TEST_MEMBER_ID,
        event_title: 'Test Tournament',
        discord_id: Option.none<Discord.Snowflake>(),
        display_name: Option.some('Test User'),
        requested_at: new Date().toISOString(),
      },
    ],
  ]);
  backfillCallCount = 0;
  approveCallCount = 0;
  declineCallCount = 0;
};

// ---------------------------------------------------------------------------
// Mock layers
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
  findById: (id: Team.TeamId) =>
    Effect.succeed(id === TEST_TEAM_ID ? Option.some(testTeam) : Option.none()),
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
        .map((m) => {
          const user = usersMap.get(m.user_id as Auth.UserId);
          if (!user) throw new Error('User not found');
          return new RosterEntry({
            member_id: m.id,
            user_id: m.user_id as Auth.UserId,
            discord_id: user.discord_id as Discord.Snowflake,
            role_names: m.role_names,
            permissions: m.permissions,
            name: user.name,
            birth_date: Option.none(),
            gender: Option.none(),
            jersey_number: Option.none(),
            username: user.username,
            avatar: user.avatar,
            discord_nickname: Option.none(),
            discord_display_name: Option.none(),
            joined_at: '2024-01-01T00:00:00.000Z',
            active: true,
          });
        }),
    ),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: (id: Event.EventId) =>
    Effect.succeed(
      id === TEST_EVENT_ID
        ? Option.some({
            id: TEST_EVENT_ID,
            team_id: TEST_TEAM_ID,
            event_type: 'tournament',
            title: 'Test Tournament',
            description: Option.none(),
            start_at: DateTime.makeUnsafe('2099-07-01T10:00:00Z'),
            end_at: Option.none(),
            location: Option.none(),
            status: 'active',
            created_by: TEST_ADMIN_MEMBER_ID,
            training_type_id: Option.none(),
            training_type_name: Option.none(),
            created_by_name: Option.none(),
            series_id: Option.none(),
            series_modified: false,
            discord_target_channel_id: Option.none(),
            owner_group_id: Option.none(),
            owner_group_name: Option.none(),
            member_group_id: Option.none(),
            member_group_name: Option.none(),
          })
        : Option.none(),
    ),
  findEventByIdWithDetails: (id: Event.EventId) =>
    Effect.succeed(
      id === TEST_EVENT_ID
        ? Option.some({
            id: TEST_EVENT_ID,
            team_id: TEST_TEAM_ID,
            event_type: 'tournament',
            title: 'Test Tournament',
            description: Option.none(),
            start_at: DateTime.makeUnsafe('2099-07-01T10:00:00Z'),
            end_at: Option.none(),
            location: Option.none(),
            status: 'active',
            created_by: TEST_ADMIN_MEMBER_ID,
            training_type_id: Option.none(),
            training_type_name: Option.none(),
            created_by_name: Option.none(),
            series_id: Option.none(),
            series_modified: false,
            discord_target_channel_id: Option.none(),
            owner_group_id: Option.none(),
            owner_group_name: Option.none(),
            member_group_id: Option.none(),
            member_group_name: Option.none(),
          })
        : Option.none(),
    ),
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
  findEventsByChannelId: () => Effect.succeed([]),
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findNonResponders: () => Effect.succeed([]),
} as any);

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: (id: RosterModel.RosterId) =>
    Effect.succeed(
      id === TEST_ROSTER_ID
        ? Option.some({
            id: TEST_ROSTER_ID,
            team_id: TEST_TEAM_ID,
            name: 'Tournament Squad',
            active: true,
            color: Option.none(),
            emoji: Option.none(),
            discord_channel_id: Option.none(),
            created_at: DateTime.nowUnsafe(),
            member_count: 0,
          })
        : Option.none(),
    ),
  insert: () => Effect.die(new Error('Not implemented')),
  update: () => Effect.die(new Error('Not implemented')),
  delete: () => Effect.void,
  findMemberEntriesById: () => Effect.succeed([]),
  addMemberById: () => Effect.void,
  removeMemberById: () => Effect.void,
} as any);

const MockEventRostersRepositoryLayer = Layer.succeed(EventRostersRepository, {
  findByEventId: (eventId: Event.EventId) => {
    const row = eventRosterStore.get(eventId);
    return Effect.succeed(row ? Option.some(row) : Option.none());
  },
  link: (input: {
    eventId: Event.EventId;
    rosterId: RosterModel.RosterId;
    autoApprove: boolean;
  }) => {
    const existing = eventRosterStore.get(input.eventId);
    if (existing) {
      return Effect.fail({ _tag: 'EventRosterAlreadyLinked' as const });
    }
    const row = {
      id: TEST_EVENT_ROSTER_ID,
      event_id: input.eventId,
      roster_id: input.rosterId,
      auto_approve: input.autoApprove,
      owners_thread_id: Option.none<Discord.Snowflake>(),
      roster_name: 'Test Roster',
      owner_group_id: Option.none<string>(),
      member_count: 0,
    };
    eventRosterStore.set(input.eventId, row);
    return Effect.succeed(row);
  },
  unlink: (eventId: Event.EventId) => {
    eventRosterStore.delete(eventId);
    return Effect.void;
  },
  setAutoApprove: (eventId: Event.EventId, autoApprove: boolean) => {
    const row = eventRosterStore.get(eventId);
    if (row) {
      eventRosterStore.set(eventId, { ...row, auto_approve: autoApprove });
    }
    return Effect.void;
  },
  saveThreadIfAbsent: () => Effect.succeed(Option.none()),
  clearThread: () => Effect.void,
} as any);

const MockEventRosterRequestsRepositoryLayer = Layer.succeed(EventRosterRequestsRepository, {
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findById: (id: EventRosterModel.EventRosterRequestId) =>
    Effect.succeed(
      id === TEST_REQUEST_ID
        ? Option.some({
            id: TEST_REQUEST_ID,
            event_id: TEST_EVENT_ID,
            roster_id: TEST_ROSTER_ID,
            team_member_id: TEST_MEMBER_ID,
            status: 'pending' as const,
            source: 'approval' as const,
            was_member_before: false,
            discord_message_id: Option.none<import('@sideline/domain').Discord.Snowflake>(),
          })
        : Option.none(),
    ),
  upsertApproved: () =>
    Effect.succeed({ id: TEST_REQUEST_ID, status: 'approved', was_member_before: false }),
  upsertPending: () =>
    Effect.succeed({ id: TEST_REQUEST_ID, status: 'pending', was_member_before: false }),
  claimDecision: () => Effect.succeed(Option.some({ was_member_before: false })),
  cancel: () => Effect.succeed(Option.none()),
  saveMessageId: () => Effect.void,
  findPendingByEvent: () => Effect.succeed([]),
  wasMemberBefore: () => Effect.succeed(false),
  findPendingByRoster: (_rosterId: RosterModel.RosterId) => {
    const requests = Array.from(pendingRequestsStore.values());
    return Effect.succeed(requests);
  },
} as any);

const MockEventRosterProvisioningServiceLayer = Layer.succeed(EventRosterProvisioningService, {
  onRsvp: () => Effect.void,
  approve: (_input: any) => {
    approveCallCount++;
    return Effect.succeed({
      outcome: 'approved',
      member_display_name: Option.some('Test User'),
    });
  },
  decline: (_input: any) => {
    declineCallCount++;
    return Effect.succeed({
      outcome: 'declined',
      member_display_name: Option.some('Test User'),
    });
  },
  backfill: (_input: any) => {
    backfillCallCount++;
    return Effect.succeed({ added: 2, cancelled: 1 });
  },
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: () => Effect.succeed([]),
  findRsvpsByEventId: () => Effect.succeed([]),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: () => Effect.succeed(Option.none()),
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: () =>
    Effect.succeed({
      id: 'rsvp-1',
      event_id: TEST_EVENT_ID,
      team_member_id: TEST_MEMBER_ID,
      response: 'yes',
      message: Option.none(),
    }),
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
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

const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
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

const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  emitEventRosterApprovalCancel: () => Effect.void,
  emitEventRosterThreadDelete: () => Effect.void,
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

const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  emitRoleCreated: () => Effect.void,
  emitRoleDeleted: () => Effect.void,
  emitRoleAssigned: () => Effect.void,
  emitRoleUnassigned: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {
  evaluateTeam: () => Effect.succeed([]),
  evaluate: () => Effect.succeed([]),
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

const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
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
      id: 'log-id',
      activity_type_id: 'type-id',
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
      Option.some({ id: 'mock-type-id', name: 'Training', slug: Option.some('training') }),
    ),
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
} as any);

const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
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

const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
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

const MockChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

// Build the full test layer (mirroring Roster.test.ts / EventRsvp.test.ts pattern)
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
          enqueue: () => Effect.void,
          listPending: () => Effect.succeed([]),
          markDone: () => Effect.void,
          markFailed: () => Effect.void,
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {} as never),
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
  .pipe(Layer.provide(MockEventRostersRepositoryLayer))
  .pipe(Layer.provide(MockEventRosterRequestsRepositoryLayer))
  .pipe(Layer.provide(MockEventRosterProvisioningServiceLayer))
  .pipe(Layer.provide(MockChannelEventDividersRepositoryLayer))
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTranslationsLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
  .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(MockChannelManagementLayers))
  .pipe(Layer.provide(MockEmailLayers))
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
  resetState();
});

const EVENT_BASE = `http://localhost/teams/${TEST_TEAM_ID}/events/${TEST_EVENT_ID}`;
const ROSTER_BASE = `http://localhost/teams/${TEST_TEAM_ID}/rosters/${TEST_ROSTER_ID}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Event Roster API — link', () => {
  it('link with roster:manage → 201 with roster link', async () => {
    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rosterId: TEST_ROSTER_ID, autoApprove: false }),
      }),
    );
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.eventId ?? body.event_id).toBe(TEST_EVENT_ID);
    expect(body.rosterId ?? body.roster_id).toBe(TEST_ROSTER_ID);
  });

  it('link without roster:manage → 403', async () => {
    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rosterId: TEST_ROSTER_ID, autoApprove: false }),
      }),
    );
    expect(response.status).toBe(403);
  });

  it('second link → 409 AlreadyLinked', async () => {
    // First link succeeds
    await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rosterId: TEST_ROSTER_ID, autoApprove: false }),
      }),
    );
    // Second link should fail
    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rosterId: TEST_ROSTER_ID, autoApprove: false }),
      }),
    );
    expect(response.status).toBe(409);
  });

  it('unknown event → 404', async () => {
    const BOGUS_EVENT = '99999999-9999-9999-9999-999999999999';
    const response = await handler(
      new Request(`http://localhost/teams/${TEST_TEAM_ID}/events/${BOGUS_EVENT}/roster`, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ rosterId: TEST_ROSTER_ID, autoApprove: false }),
      }),
    );
    expect(response.status).toBe(404);
  });
});

describe('Event Roster API — PATCH autoApprove', () => {
  it('PATCH autoApprove OFF→ON triggers backfill; returns {added, cancelled}', async () => {
    // Pre-link
    eventRosterStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ROSTER_ID,
      event_id: TEST_EVENT_ID,
      roster_id: TEST_ROSTER_ID,
      auto_approve: false,
      owners_thread_id: Option.none(),
      roster_name: 'Test Roster',
      owner_group_id: Option.none(),
      member_count: 0,
    });

    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer admin-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ autoApprove: true }),
      }),
    );
    expect(response.status).toBe(200);
    // Backfill was triggered
    expect(backfillCallCount).toBeGreaterThanOrEqual(1);
    const body = await response.json();
    // Response may include added/cancelled counts
    expect(body).toBeDefined();
  });

  it('PATCH without roster:manage → 403', async () => {
    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer user-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ autoApprove: true }),
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('Event Roster API — unlink', () => {
  it('unlink → 204', async () => {
    // Pre-link
    eventRosterStore.set(TEST_EVENT_ID, {
      id: TEST_EVENT_ROSTER_ID,
      event_id: TEST_EVENT_ID,
      roster_id: TEST_ROSTER_ID,
      auto_approve: false,
      owners_thread_id: Option.none(),
      roster_name: 'Test Roster',
      owner_group_id: Option.none(),
      member_count: 0,
    });

    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(204);
  });

  it('unlink without roster:manage → 403', async () => {
    const response = await handler(
      new Request(`${EVENT_BASE}/roster`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('Event Roster API — pending requests', () => {
  it('GET roster requests → pending list for the roster', async () => {
    const response = await handler(
      new Request(`${ROSTER_BASE}/requests`, {
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET roster requests without roster:manage → 403', async () => {
    const response = await handler(
      new Request(`${ROSTER_BASE}/requests`, {
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});

describe('Event Roster API — web approve/decline', () => {
  it('POST approve calls provisioning service; returns outcome', async () => {
    const response = await handler(
      new Request(`${ROSTER_BASE}/requests/${TEST_REQUEST_ID}/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    expect(approveCallCount).toBe(1);
  });

  it('POST decline calls provisioning service; returns outcome', async () => {
    const response = await handler(
      new Request(`${ROSTER_BASE}/requests/${TEST_REQUEST_ID}/decline`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    expect(declineCallCount).toBe(1);
  });

  it('approve without roster:manage → 403', async () => {
    const response = await handler(
      new Request(`${ROSTER_BASE}/requests/${TEST_REQUEST_ID}/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );
    expect(response.status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// B1 regression test: web approve/decline uses membership.id (not '0' sentinel)
// Uses the REAL EventRosterProvisioningService with mock repos to verify roster add
// happens and decided_by is set to the authenticated member's id.
// ---------------------------------------------------------------------------

describe('Event Roster API — web approve/decline (real service, B1 regression)', () => {
  // Track roster add calls and the decided_by passed to claimDecision
  let rosterAddCount: number;
  let claimDecisionDecidedBy: TeamMember.TeamMemberId | undefined;
  let approvalCancelEmitted: boolean;

  const resetRealServiceState = () => {
    rosterAddCount = 0;
    claimDecisionDecidedBy = undefined;
    approvalCancelEmitted = false;
  };

  const MockRostersForRealServiceLayer = Layer.succeed(RostersRepository, {
    _tag: 'api/RostersRepository',
    findByTeamId: () => Effect.succeed([]),
    findRosterById: (id: RosterModel.RosterId) =>
      Effect.succeed(
        id === TEST_ROSTER_ID
          ? Option.some({
              id: TEST_ROSTER_ID,
              team_id: TEST_TEAM_ID,
              name: 'Tournament Squad',
              active: true,
              color: Option.none(),
              emoji: Option.none(),
              discord_channel_id: Option.none(),
              created_at: DateTime.nowUnsafe(),
              member_count: 0,
            })
          : Option.none(),
      ),
    insert: () => Effect.die(new Error('Not implemented')),
    update: () => Effect.die(new Error('Not implemented')),
    delete: () => Effect.void,
    findMemberEntriesById: () => Effect.succeed([]),
    addMemberById: (_rosterId: RosterModel.RosterId, _memberId: TeamMember.TeamMemberId) => {
      rosterAddCount++;
      return Effect.void;
    },
    removeMemberById: () => Effect.void,
  } as any);

  const MockRequestsForRealServiceLayer = Layer.succeed(EventRosterRequestsRepository, {
    findByEventAndMember: () =>
      Effect.succeed(
        Option.some({
          id: TEST_REQUEST_ID,
          event_id: TEST_EVENT_ID,
          roster_id: TEST_ROSTER_ID,
          team_member_id: TEST_MEMBER_ID,
          status: 'pending' as const,
          source: 'approval' as const,
          was_member_before: false,
          discord_message_id: Option.none<Discord.Snowflake>(),
        }),
      ),
    findById: (id: EventRosterModel.EventRosterRequestId) =>
      Effect.succeed(
        id === TEST_REQUEST_ID
          ? Option.some({
              id: TEST_REQUEST_ID,
              event_id: TEST_EVENT_ID,
              roster_id: TEST_ROSTER_ID,
              team_member_id: TEST_MEMBER_ID,
              status: 'pending' as const,
              source: 'approval' as const,
              was_member_before: false,
              discord_message_id: Option.none<Discord.Snowflake>(),
            })
          : Option.none(),
      ),
    upsertApproved: () =>
      Effect.succeed({ id: TEST_REQUEST_ID, status: 'approved', was_member_before: false }),
    upsertPending: () =>
      Effect.succeed({ id: TEST_REQUEST_ID, status: 'pending', was_member_before: false }),
    claimDecision: (
      _eventId: Event.EventId,
      _memberId: TeamMember.TeamMemberId,
      _status: 'approved' | 'declined',
      decidedBy: TeamMember.TeamMemberId,
    ) => {
      claimDecisionDecidedBy = decidedBy;
      return Effect.succeed(Option.some({ was_member_before: false }));
    },
    cancel: () => Effect.succeed(Option.none()),
    saveMessageId: () => Effect.void,
    findPendingByEvent: () => Effect.succeed([]),
    wasMemberBefore: () => Effect.succeed(false),
    findPendingByRoster: () => Effect.succeed([]),
  } as any);

  const MockEventRostersForRealServiceLayer = Layer.succeed(EventRostersRepository, {
    findByEventId: (eventId: Event.EventId) => {
      if (eventId !== TEST_EVENT_ID) return Effect.succeed(Option.none());
      return Effect.succeed(
        Option.some({
          id: TEST_EVENT_ROSTER_ID,
          event_id: TEST_EVENT_ID,
          roster_id: TEST_ROSTER_ID,
          auto_approve: false,
          owners_thread_id: Option.none<Discord.Snowflake>(),
          roster_name: 'Tournament Squad',
          owner_group_id: Option.none<GroupModel.GroupId>(),
          member_group_id: Option.none<GroupModel.GroupId>(),
          member_count: 0,
          owner_channel_id: Option.none<Discord.Snowflake>(),
          created_at: DateTime.nowUnsafe(),
          updated_at: DateTime.nowUnsafe(),
        }),
      );
    },
    link: () => Effect.die(new Error('Not implemented')),
    unlink: () => Effect.void,
    setAutoApprove: () => Effect.void,
    saveThreadIfAbsent: () => Effect.succeed(Option.none()),
    clearThread: () => Effect.void,
  } as any);

  const MockChannelSyncForRealServiceLayer = Layer.succeed(ChannelSyncEventsRepository, {
    emitChannelCreated: () => Effect.void,
    emitChannelDeleted: () => Effect.void,
    emitMemberAdded: () => Effect.void,
    emitMemberRemoved: () => Effect.void,
    emitRosterMemberAdded: () => Effect.void,
    emitRosterMemberRemoved: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
    hasUnprocessedForGroups: () => Effect.succeed([]),
    hasUnprocessedForRosters: () => Effect.succeed([]),
  } as any);

  const MockGroupsForRealServiceLayer = Layer.succeed(GroupsRepository, {
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

  const MockEventSyncForRealServiceLayer = Layer.succeed(EventSyncEventsRepository, {
    emitEventCreated: () => Effect.void,
    emitEventUpdated: () => Effect.void,
    emitEventCancelled: () => Effect.void,
    emitRsvpReminder: () => Effect.void,
    emitEventRosterApprovalCancel: () => {
      approvalCancelEmitted = true;
      return Effect.void;
    },
    emitEventRosterThreadDelete: () => Effect.void,
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

  // Build a self-contained provisioning layer backed by the real implementation +
  // the test-specific mock repos above (closures capture the let-variables).
  const RealProvisioningServiceLayer = EventRosterProvisioningService.Default.pipe(
    Layer.provide(MockEventRostersForRealServiceLayer),
    Layer.provide(MockRequestsForRealServiceLayer),
    Layer.provide(MockRostersForRealServiceLayer),
    Layer.provide(MockChannelSyncForRealServiceLayer),
    Layer.provide(MockEventSyncForRealServiceLayer),
    Layer.provide(MockGroupsForRealServiceLayer),
    Layer.provide(MockTeamMembersRepositoryLayer),
  );

  // Build the full HTTP layer from scratch, substituting the real provisioning
  // service in place of the mock used by the main TestLayer.
  const RealServiceTestLayer = ApiLive.pipe(
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
            enqueue: () => Effect.void,
            listPending: () => Effect.succeed([]),
            markDone: () => Effect.void,
            markFailed: () => Effect.void,
          } as never),
          Layer.succeed(InviteAcceptancesRepository, {} as never),
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
    .pipe(Layer.provide(MockEventRostersRepositoryLayer))
    .pipe(Layer.provide(MockEventRosterRequestsRepositoryLayer))
    .pipe(Layer.provide(RealProvisioningServiceLayer))
    .pipe(Layer.provide(MockChannelEventDividersRepositoryLayer))
    .pipe(Layer.provide(MockFinanceLayers))
    .pipe(Layer.provide(MockTranslationsLayers))
    .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
    .pipe(Layer.provide(MockTeamChallengeRepositoryLayer))
    .pipe(Layer.provide(MockPlayerRatingsRepositoryLayer))
    .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
    .pipe(Layer.provide(MockChannelManagementLayers))
    .pipe(Layer.provide(MockEmailLayers))
    .pipe(Layer.provide(BotInfoStore.Default))
    .pipe(
      Layer.provide(
        Layer.succeed(GlobalAdminAllowlist, { asEffect: Effect.succeed(new Set<string>()) } as any),
      ),
    );

  let realHandler: (...args: any) => Promise<Response>;
  let realDispose: () => Promise<void>;

  beforeAll(() => {
    const app = HttpRouter.toWebHandler(RealServiceTestLayer);
    realHandler = app.handler;
    realDispose = app.dispose;
  });

  afterAll(async () => {
    await realDispose();
  });

  beforeEach(() => {
    resetRealServiceState();
  });

  it('web approve → uses membership.id as deciderMemberId (not sentinel 0), adds member to roster, emits cancel', async () => {
    const response = await realHandler(
      new Request(`${ROSTER_BASE}/requests/${TEST_REQUEST_ID}/approve`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    // Roster add must have happened (member was not already on roster)
    expect(rosterAddCount).toBe(1);
    // decided_by must be the authenticated admin's membership id, NOT '0'
    expect(claimDecisionDecidedBy).toBe(TEST_ADMIN_MEMBER_ID);
    // Discord approval cancel must have been emitted (B2)
    expect(approvalCancelEmitted).toBe(true);
  });

  it('web decline → uses membership.id as deciderMemberId (not sentinel 0)', async () => {
    const response = await realHandler(
      new Request(`${ROSTER_BASE}/requests/${TEST_REQUEST_ID}/decline`, {
        method: 'POST',
        headers: { Authorization: 'Bearer admin-token' },
      }),
    );
    expect(response.status).toBe(200);
    // decided_by must be the authenticated admin's membership id, NOT '0'
    expect(claimDecisionDecidedBy).toBe(TEST_ADMIN_MEMBER_ID);
    // Discord approval cancel must have been emitted (B2)
    expect(approvalCancelEmitted).toBe(true);
  });
});
