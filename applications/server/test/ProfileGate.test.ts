// TDD mode — Task 3 of `.work-plans/discord-full-onboarding.md`.
//
// `requireCompleteProfile` (`applications/server/src/utils/requireCompleteProfile.ts`) does not
// exist yet, and none of the four gated writers (`submitRsvp`, `Event/SubmitRsvp`,
// `Event/ClaimTraining`, `Carpool/ReserveSeat`, `Carpool/AddCar`) call it — every case below that
// expects a `*ProfileIncomplete` rejection is expected to get a SUCCESS instead, and every "never
// called" assertion is expected to find the writer WAS called. That is the correct first red for
// this file.
//
// Mock-layer cascade copied from `EventRsvp.test.ts` (HTTP half: `ApiLive` + `AuthMiddlewareLive`
// + the full repository mock cascade — server AGENTS.md → "Testing" → "HttpApi Mock-Layer
// Cascade"; RPC half: `RpcTest.makeClient` against `EventsRpcLive` / `CarpoolsRpcLive`, same shape
// as `EventClaimTraining.test.ts`). No `ProfileGateConfig`-style layer is added — the plan is
// explicit that there is no service; the flag is a module-level constant and the per-team column
// is read off the membership/lookup rows every gated handler already fetches.

import { it as itEffect } from '@effect/vitest';
import type { Auth, Discord, Event, EventRsvp, Role, Team, TeamMember } from '@sideline/domain';
import {
  CarpoolRpcGroup,
  type CarpoolRpcModels,
  EventRpcGroup,
  type EventRpcModels,
} from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { RpcTest } from 'effect/unstable/rpc';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach, describe, expect } from 'vitest';
import { ApiLive } from '~/api/index.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { AgeThresholdRepository } from '~/repositories/AgeThresholdRepository.js';
import { BotGuildsRepository } from '~/repositories/BotGuildsRepository.js';
import { CarpoolsRepository } from '~/repositories/CarpoolsRepository.js';
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
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { CarpoolsRpcLive } from '~/rpc/carpool/index.js';
import { EventsRpcLive } from '~/rpc/event/index.js';
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
} from './mocks/aiChatMocks.js';
import { MockBankSyncLayers, MockGenericSqlClientLayer } from './mocks/bankSyncMocks.js';
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

// ============================================================
// Shared fixtures
// ============================================================

const TEST_TEAM_ID = '00000000-0000-0000-0000-0000000a0010' as Team.TeamId;
const TEST_USER_COMPLETE_ID = '00000000-0000-0000-0000-0000000a0001' as Auth.UserId;
const TEST_USER_INCOMPLETE_ID = '00000000-0000-0000-0000-0000000a0002' as Auth.UserId;
const TEST_MEMBER_COMPLETE_ID = '00000000-0000-0000-0000-0000000a0021' as TeamMember.TeamMemberId;
const TEST_MEMBER_INCOMPLETE_ID = '00000000-0000-0000-0000-0000000a0022' as TeamMember.TeamMemberId;

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

const testUserComplete = {
  id: TEST_USER_COMPLETE_ID,
  discord_id: '811100000000000001',
  username: 'complete-user',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Complete User'),
  birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
  gender: Option.some('male' as const),
  locale: 'en' as const,
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testUserIncomplete = {
  ...testUserComplete,
  id: TEST_USER_INCOMPLETE_ID,
  discord_id: '811100000000000002',
  username: 'incomplete-user',
  is_profile_complete: false,
  name: Option.none<string>(),
  birth_date: Option.none<DateTime.Utc>(),
  gender: Option.none<'male' | 'female' | 'other'>(),
};

// ============================================================
// HTTP — `submitRsvp` / `getRsvps` via `ApiLive`
//
// The plan folds the gate into the SELECT `requireMembership` already runs (no extra query): the
// membership row itself carries `require_complete_profile` (the per-team `LEFT JOIN
// team_settings`), and `is_profile_complete` is already free on `Auth.CurrentUserContext`. Since
// `MembershipWithRole` is not widened yet (Task 3), these mocks attach the field the widened type
// WILL carry directly on the plain mock object — the type-level widening is Task 3's job, not
// this test's.
// ============================================================

let httpTeamGateSetting: Option.Option<boolean> = Option.none();

const setHttpGateSetting = (value: Option.Option<boolean>) => {
  httpTeamGateSetting = value;
};

type TestMembership = MembershipWithRole & {
  readonly require_complete_profile: Option.Option<boolean>;
};

const httpMembersStore = new Map<string, TestMembership>();

const resetHttpMembers = () => {
  httpMembersStore.clear();
  httpMembersStore.set(TEST_MEMBER_COMPLETE_ID, {
    id: TEST_MEMBER_COMPLETE_ID,
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_COMPLETE_ID,
    active: true,
    role_names: ['Player'],
    permissions: PLAYER_PERMISSIONS,
    get require_complete_profile() {
      return httpTeamGateSetting;
    },
  } as unknown as TestMembership);
  httpMembersStore.set(TEST_MEMBER_INCOMPLETE_ID, {
    id: TEST_MEMBER_INCOMPLETE_ID,
    team_id: TEST_TEAM_ID,
    user_id: TEST_USER_INCOMPLETE_ID,
    active: true,
    role_names: ['Player'],
    permissions: PLAYER_PERMISSIONS,
    get require_complete_profile() {
      return httpTeamGateSetting;
    },
  } as unknown as TestMembership);
};

const HTTP_EVENT_OPEN = '00000000-0000-0000-0000-0000000a0060' as Event.EventId;
const HTTP_EVENT_CLOSED = '00000000-0000-0000-0000-0000000a0061' as Event.EventId;

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

let httpEventsStore: Map<Event.EventId, EventRecord>;

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

let httpRsvpsStore: Map<string, RsvpRecord>;
let httpUpsertRsvpCalls: number;

const resetHttpStores = () => {
  httpEventsStore = new Map();
  httpEventsStore.set(HTTP_EVENT_OPEN, {
    id: HTTP_EVENT_OPEN,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'Open Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2099-12-31T20:00:00Z')),
    location: Option.none(),
    status: 'active',
    created_by: TEST_MEMBER_COMPLETE_ID,
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
  httpEventsStore.set(HTTP_EVENT_CLOSED, {
    id: HTTP_EVENT_CLOSED,
    team_id: TEST_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'Closed Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2020-01-01T18:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    status: 'active',
    created_by: TEST_MEMBER_COMPLETE_ID,
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
  httpRsvpsStore = new Map();
  httpUpsertRsvpCalls = 0;
  resetHttpMembers();
  httpTeamGateSetting = Option.none();
};

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  createAuthorizationURL: (_state: string) =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(
      new OAuth2Tokens({ access_token: 'mock-access-token', refresh_token: 'mock-refresh-token' }),
    ),
});

const httpSessionsStore = new Map<string, Auth.UserId>([
  ['complete-token', TEST_USER_COMPLETE_ID],
  ['incomplete-token', TEST_USER_INCOMPLETE_ID],
]);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) => {
    const user =
      id === TEST_USER_COMPLETE_ID
        ? testUserComplete
        : id === TEST_USER_INCOMPLETE_ID
          ? testUserIncomplete
          : undefined;
    return Effect.succeed(user ? Option.some(user) : Option.none());
  },
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.succeed(testUserComplete),
  completeProfile: () => Effect.succeed(testUserComplete),
  updateLocale: () => Effect.succeed(testUserComplete),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) => {
    const userId = httpSessionsStore.get(token);
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

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Profile Gate Test Team',
  guild_id: '811100000000009999' as Discord.Snowflake,
  created_by: TEST_USER_COMPLETE_ID,
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

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
    const member = Array.from(httpMembersStore.values()).find(
      (m) => m.team_id === teamId && m.user_id === userId,
    );
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getDefaultRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  resetMissedRsvps: () => Effect.void,
} as any);

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: (id: Event.EventId) => {
    const event = httpEventsStore.get(id);
    return Effect.succeed(event ? Option.some(event) : Option.none());
  },
  findEventByIdWithDetails: (id: Event.EventId) => {
    const event = httpEventsStore.get(id);
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
  cancelFuture: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodified: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  markEventPersonalMessagesDirty: () => Effect.void,
} as any);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: (eventId: Event.EventId) =>
    Effect.succeed(Array.from(httpRsvpsStore.values()).filter((r) => r.event_id === eventId)),
  findRsvpsByEventId: (eventId: Event.EventId) =>
    Effect.succeed(Array.from(httpRsvpsStore.values()).filter((r) => r.event_id === eventId)),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    const key = `${eventId}:${memberId}`;
    const rsvp = httpRsvpsStore.get(key);
    return Effect.succeed(rsvp ? Option.some(rsvp) : Option.none());
  },
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
  ) => {
    httpUpsertRsvpCalls += 1;
    const key = `${eventId}:${memberId}`;
    const record: RsvpRecord = {
      id: crypto.randomUUID() as EventRsvp.EventRsvpId,
      event_id: eventId,
      team_member_id: memberId,
      response,
      message,
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    };
    httpRsvpsStore.set(key, record);
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
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: () => Effect.succeed([]),
  incrementMissedForEventNonRespondersByEventId: () => Effect.void,
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

// `Option.none()` reproduces the "no team_settings row at all" case (the LEFT JOIN NULL branch).
const httpTeamSettingsLayer = () =>
  Layer.succeed(TeamSettingsRepository, {
    _tag: 'api/TeamSettingsRepository',
    findByTeam: () => Effect.succeed(Option.none()),
    findByTeamId: () => Effect.succeed(Option.none()),
    upsertSettings: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
    getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
    getHorizonDays: () => Effect.succeed(30),
  } as any);

const HttpTestLayer = ApiLive.pipe(
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
        httpTeamSettingsLayer(),
      ),
      MockOAuthConnectionsRepositoryLayer,
    ),
  ),
  Layer.provide(MockAchievementAdminLayers),
)
  .pipe(Layer.provide(MockBankSyncLayers))
  .pipe(Layer.provide(MockGenericSqlClientLayer))
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
  const app = HttpRouter.toWebHandler(HttpTestLayer);
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetHttpStores();
});

const BASE = `http://localhost/teams/${TEST_TEAM_ID}/events`;

const submitHttpRsvp = (eventId: Event.EventId, token: string, response = 'yes') =>
  handler(
    new Request(`${BASE}/${eventId}/rsvp`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ response, message: null }),
    }),
  );

describe('HTTP submitRsvp — profile gate (Task 3)', () => {
  itEffect.effect('1. setting off, profile incomplete → 204, RSVP is written', () =>
    Effect.promise(async () => {
      setHttpGateSetting(Option.some(false));
      const response = await submitHttpRsvp(HTTP_EVENT_OPEN, 'incomplete-token');
      expect(response.status).toBe(204);
      expect(httpUpsertRsvpCalls).toBe(1);
    }),
  );

  itEffect.effect(
    '2. setting on, profile incomplete → 403 EventRsvpProfileIncomplete, upsertRsvp never called',
    () =>
      Effect.promise(async () => {
        setHttpGateSetting(Option.some(true));
        const response = await submitHttpRsvp(HTTP_EVENT_OPEN, 'incomplete-token');
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body._tag).toBe('EventRsvpProfileIncomplete');
        expect(httpUpsertRsvpCalls).toBe(0);
      }),
  );

  itEffect.effect('3. setting on, profile complete → 204', () =>
    Effect.promise(async () => {
      setHttpGateSetting(Option.some(true));
      const response = await submitHttpRsvp(HTTP_EVENT_OPEN, 'complete-token');
      expect(response.status).toBe(204);
    }),
  );

  itEffect.effect('4. setting on, no team_settings row at all → 204 (LEFT JOIN NULL branch)', () =>
    Effect.promise(async () => {
      setHttpGateSetting(Option.none());
      const response = await submitHttpRsvp(HTTP_EVENT_OPEN, 'incomplete-token');
      expect(response.status).toBe(204);
    }),
  );

  itEffect.effect(
    '5. setting on, profile incomplete, deadline ALSO passed → 403 EventRsvpProfileIncomplete, not RsvpDeadlinePassed (guard ordering)',
    () =>
      Effect.promise(async () => {
        setHttpGateSetting(Option.some(true));
        const response = await submitHttpRsvp(HTTP_EVENT_CLOSED, 'incomplete-token');
        expect(response.status).toBe(403);
        const body = await response.json();
        expect(body._tag).toBe('EventRsvpProfileIncomplete');
      }),
  );

  itEffect.effect('6. getRsvps is never gated — setting on, profile incomplete → 200', () =>
    Effect.promise(async () => {
      setHttpGateSetting(Option.some(true));
      const response = await handler(
        new Request(`${BASE}/${HTTP_EVENT_OPEN}/rsvps`, {
          headers: { Authorization: 'Bearer incomplete-token' },
        }),
      );
      expect(response.status).toBe(200);
    }),
  );
});

// ============================================================
// RPC — `Event/SubmitRsvp` / `Event/ClaimTraining` / `Event/UnclaimTraining` via `EventsRpcLive`.
//
// The member lookup in `rpc/event/index.ts` is raw SQL (`TeamMemberLookup`), not a repository —
// the mock `SqlClient` below inspects the `discord_user_id` argument to pick which fixture member
// to return, following `EventClaimTraining.test.ts`'s `makeMockSqlClientLayer` pattern.
// ============================================================

const RPC_TEAM_ID = TEST_TEAM_ID;
const RPC_DISCORD_COMPLETE = '822200000000000001' as Discord.Snowflake;
const RPC_DISCORD_INCOMPLETE = '822200000000000002' as Discord.Snowflake;

let rpcEventGateSetting: Option.Option<boolean> = Option.none();
let rpcClaimTrainingCalls: number;
let rpcUnclaimTrainingCalls: number;
let rpcUpsertRsvpCalls: number;

const RPC_EVENT_ID = '00000000-0000-0000-0000-0000000a0070' as Event.EventId;

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
  claimed_by?: Option.Option<TeamMember.TeamMemberId>;
  claimer_name?: Option.Option<string>;
  claim_discord_channel_id?: Option.Option<Discord.Snowflake>;
  claim_discord_message_id?: Option.Option<Discord.Snowflake>;
};

let rpcEventsStore: Map<Event.EventId, RpcEventRecord>;
let rpcRsvpsStore: Map<string, RsvpRecord>;

const RPC_TRAINING_MEMBER_ID = '00000000-0000-0000-0000-0000000a0031' as TeamMember.TeamMemberId;
const RPC_INCOMPLETE_MEMBER_ID = '00000000-0000-0000-0000-0000000a0032' as TeamMember.TeamMemberId;
// `Event/ClaimTraining` fails `ClaimNotOwnerGroupMember` before ever reaching the profile gate
// unless the caller is in the event's owner-group descendants — both fixture members are put in
// this group (see `RpcMockGroupsRepositoryLayer.getDescendantMemberIds` below) purely so the
// profile-incomplete case's rejection is attributable to the GATE, not to a missing precondition.
const RPC_OWNER_GROUP_ID = '00000000-0000-0000-0000-0000000a0080';

const resetRpcStores = () => {
  rpcEventsStore = new Map();
  rpcEventsStore.set(RPC_EVENT_ID, {
    id: RPC_EVENT_ID,
    team_id: RPC_TEAM_ID,
    training_type_id: Option.none(),
    event_type: 'training',
    title: 'RPC Profile Gate Training',
    description: Option.none(),
    start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
    end_at: Option.none(),
    location: Option.none(),
    status: 'active',
    created_by: RPC_TRAINING_MEMBER_ID,
    training_type_name: Option.none(),
    created_by_name: Option.none(),
    series_id: Option.none(),
    series_modified: false,
    discord_target_channel_id: Option.none(),
    owner_group_id: Option.some(RPC_OWNER_GROUP_ID),
    owner_group_name: Option.none(),
    member_group_id: Option.none(),
    member_group_name: Option.none(),
    reminder_sent_at: Option.none(),
    claimed_by: Option.none(),
    claimer_name: Option.none(),
    claim_discord_channel_id: Option.none(),
    claim_discord_message_id: Option.none(),
  });
  rpcRsvpsStore = new Map();
  rpcEventGateSetting = Option.none();
  rpcClaimTrainingCalls = 0;
  rpcUnclaimTrainingCalls = 0;
  rpcUpsertRsvpCalls = 0;
};

// Row returned for the member lookup, keyed by discord id. `is_profile_complete` /
// `require_complete_profile` are the two columns Task 3 adds to `TeamMemberLookup`'s SELECT —
// harmless to return today (an un-widened schema just ignores unknown keys on decode).
const rpcMemberRow = (discordId: Discord.Snowflake) => {
  if (discordId === RPC_DISCORD_COMPLETE) {
    return {
      id: RPC_TRAINING_MEMBER_ID,
      name: null,
      nickname: null,
      display_name: 'Complete Member',
      username: null,
      is_profile_complete: true,
      require_complete_profile: Option.isSome(rpcEventGateSetting)
        ? rpcEventGateSetting.value
        : null,
    };
  }
  if (discordId === RPC_DISCORD_INCOMPLETE) {
    return {
      id: RPC_INCOMPLETE_MEMBER_ID,
      name: null,
      nickname: null,
      display_name: 'Incomplete Member',
      username: null,
      is_profile_complete: false,
      require_complete_profile: Option.isSome(rpcEventGateSetting)
        ? rpcEventGateSetting.value
        : null,
    };
  }
  return undefined;
};

const RpcMockSqlClientLayer = Layer.succeed(
  SqlClient.SqlClient,
  Object.assign(
    function mockSql(_strings: TemplateStringsArray, ..._args: unknown[]) {
      const discordId = _args.find((a) => typeof a === 'string' && /^\d{17,20}$/.test(a));
      const row = rpcMemberRow(discordId as Discord.Snowflake);
      return Effect.succeed(row ? [row] : []);
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
      unsafe: (_sql: string, _params?: ReadonlyArray<unknown>) => Effect.succeed([] as never[]),
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

const RpcMockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: (id: Event.EventId) => {
    const e = rpcEventsStore.get(id);
    return Effect.succeed(e ? Option.some(e) : Option.none());
  },
  findEventByIdWithDetails: (id: Event.EventId) => {
    const e = rpcEventsStore.get(id);
    return Effect.succeed(e ? Option.some(e) : Option.none());
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
  markEventPersonalMessagesDirty: () => Effect.void,
  claimTraining: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    rpcClaimTrainingCalls += 1;
    const ev = rpcEventsStore.get(eventId);
    if (!ev) return Effect.succeed(Option.none());
    rpcEventsStore.set(eventId, { ...ev, claimed_by: Option.some(memberId) });
    return Effect.succeed(Option.some({ id: eventId }));
  },
  unclaimTraining: (eventId: Event.EventId, _memberId: TeamMember.TeamMemberId) => {
    rpcUnclaimTrainingCalls += 1;
    const ev = rpcEventsStore.get(eventId);
    if (!ev) return Effect.succeed(Option.none());
    rpcEventsStore.set(eventId, { ...ev, claimed_by: Option.none() });
    return Effect.succeed(Option.some({ id: eventId }));
  },
  findClaimInfo: (eventId: Event.EventId) => {
    const ev = rpcEventsStore.get(eventId);
    if (!ev) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({
        event_id: ev.id,
        event_type: ev.event_type,
        status: ev.status,
        claimed_by_member_id: ev.claimed_by ?? Option.none(),
        claimed_by_display_name: Option.none(),
        claim_discord_channel_id: Option.none(),
        claim_discord_message_id: Option.none(),
        claim_thread_id: Option.none(),
      }),
    );
  },
  saveClaimDiscordMessage: () => Effect.void,
} as any);

const RpcMockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
  findByEventId: (eventId: Event.EventId) =>
    Effect.succeed(Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId)),
  findRsvpsByEventId: (eventId: Event.EventId) =>
    Effect.succeed(Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId)),
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    const key = `${eventId}:${memberId}`;
    const r = rpcRsvpsStore.get(key);
    return Effect.succeed(r ? Option.some(r) : Option.none());
  },
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
  ) => {
    rpcUpsertRsvpCalls += 1;
    const key = `${eventId}:${memberId}`;
    const record: RsvpRecord = {
      id: crypto.randomUUID() as EventRsvp.EventRsvpId,
      event_id: eventId,
      team_member_id: memberId,
      response,
      message,
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
      priorResponse: Option.none<EventRsvp.RsvpResponse>(),
    });
  },
  countByEventId: () => Effect.succeed([]),
  countRsvpsByEventId: (eventId: Event.EventId) => {
    const rsvps = Array.from(rpcRsvpsStore.values()).filter((r) => r.event_id === eventId);
    const counts = new Map<string, number>();
    for (const r of rsvps) counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
    return Effect.succeed(
      Array.from(counts.entries()).map(([response, count]) => ({ response, count })),
    );
  },
  findNonResponders: () => Effect.succeed([]),
  findNonRespondersByEventId: () => Effect.succeed([]),
  findRsvpAttendeesPage: () => Effect.succeed([]),
  countRsvpTotal: () => Effect.succeed(0),
  findYesAttendeesForEmbed: () => Effect.succeed([]),
  incrementMissedForEventNonRespondersByEventId: () => Effect.void,
} as any);

const RpcMockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: () => Effect.succeed(Option.none()),
  upsertSettings: () => Effect.die(new Error('Not implemented')),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
  findEventsForReminder: () => Effect.succeed([]),
  findEventsNeedingReminder: () => Effect.succeed([]),
  findLateRsvpChannelId: () => Effect.succeed(Option.none()),
} as any);

const RpcMockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  emitEventCreated: () => Effect.void,
  emitEventUpdated: () => Effect.void,
  emitEventCancelled: () => Effect.void,
  emitRsvpReminder: () => Effect.void,
  emitTrainingClaimUpdate: () => Effect.void,
  emitTrainingClaimRequest: () => Effect.void,
  emitUnclaimedTrainingReminder: () => Effect.void,
  findUnprocessed: () => Effect.succeed([]),
  markProcessed: () => Effect.void,
  markFailed: () => Effect.void,
} as any);

const RpcMockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  addMember: () => Effect.die(new Error('Not implemented')),
  findMembershipByIds: () => Effect.succeed(Option.none()),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getDefaultRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  resetMissedRsvps: () => Effect.void,
} as any);

const RpcMockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
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
  // Both fixture members belong to the training's owner group, so `ClaimNotOwnerGroupMember`
  // never fires here — see the comment on `RPC_OWNER_GROUP_ID`.
  getDescendantMemberIds: () => Effect.succeed([RPC_TRAINING_MEMBER_ID, RPC_INCOMPLETE_MEMBER_ID]),
} as any);

const RpcMockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: () => Effect.succeed(Option.none()),
  findByGuildId: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const RpcMockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
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

const RpcMockChannelEventDividersRepositoryLayer = Layer.succeed(ChannelEventDividersRepository, {
  findByChannelId: () => Effect.succeed(Option.none()),
  upsert: () => Effect.void,
  deleteByChannelId: () => Effect.void,
} as any);

const RpcMockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  findByGroupId: () => Effect.succeed(Option.none()),
  insert: () => Effect.void,
  insertWithoutRole: () => Effect.void,
  deleteByGroupId: () => Effect.void,
  findAllByTeamId: () => Effect.succeed([]),
  findAllByTeam: () => Effect.succeed([]),
} as any);

const EventRpcTestLayer = EventsRpcLive.pipe(
  Layer.provide(RpcMockEventsRepositoryLayer),
  Layer.provide(RpcMockEventRsvpsRepositoryLayer),
  Layer.provide(RpcMockTeamSettingsRepositoryLayer),
  Layer.provide(RpcMockEventSyncEventsRepositoryLayer),
  Layer.provide(RpcMockTeamMembersRepositoryLayer),
  Layer.provide(RpcMockGroupsRepositoryLayer),
  Layer.provide(RpcMockTeamsRepositoryLayer),
  Layer.provide(RpcMockTrainingTypesRepositoryLayer),
  Layer.provide(RpcMockChannelEventDividersRepositoryLayer),
  Layer.provide(RpcMockDiscordChannelMappingRepositoryLayer),
  Layer.provide(RpcMockSqlClientLayer),
  Layer.provide(MockEventRosterLayers),
);

// The trailing `as Effect.Effect<any, any, never>` mirrors `EventClaimTraining.test.ts`'s
// `callClaimTraining`/`callUnclaimTraining` helpers — without it `Effect.provide` leaves the `R`
// parameter as `any` (from the `RpcTest.makeClient` cast above), which trips
// `exactOptionalPropertyTypes` at every call site's `Effect.runPromise`.
const callEventRpc = <T>(name: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(EventRpcGroup.EventRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[name](payload) as Effect.Effect<T, unknown, never>),
      Effect.result,
    ),
  ).pipe(Effect.provide(EventRpcTestLayer)) as unknown as Effect.Effect<any, any, never>;

const submitRpcRsvp = (discordId: Discord.Snowflake) =>
  callEventRpc<EventRpcModels.SubmitRsvpResult>('Event/SubmitRsvp', {
    event_id: RPC_EVENT_ID,
    team_id: RPC_TEAM_ID,
    discord_user_id: discordId,
    response: 'yes',
    message: Option.none(),
    clearMessage: false,
  });

const claimRpcTraining = (discordId: Discord.Snowflake) =>
  callEventRpc('Event/ClaimTraining', {
    event_id: RPC_EVENT_ID,
    team_id: RPC_TEAM_ID,
    discord_user_id: discordId,
  });

const unclaimRpcTraining = (discordId: Discord.Snowflake) =>
  callEventRpc('Event/UnclaimTraining', {
    event_id: RPC_EVENT_ID,
    team_id: RPC_TEAM_ID,
    discord_user_id: discordId,
  });

describe('RPC — Event/SubmitRsvp / Event/ClaimTraining profile gate (Task 3)', () => {
  beforeEach(() => {
    resetRpcStores();
  });

  itEffect.effect(
    '7. Event/SubmitRsvp → RsvpProfileIncomplete when gate on + profile incomplete',
    () =>
      Effect.promise(async () => {
        rpcEventGateSetting = Option.some(true);
        const result = await Effect.runPromise(submitRpcRsvp(RPC_DISCORD_INCOMPLETE));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as { _tag: string })._tag).toBe('RsvpProfileIncomplete');
        }
        expect(rpcUpsertRsvpCalls).toBe(0);
      }),
  );

  itEffect.effect('Event/SubmitRsvp → succeeds when gate on + profile complete', () =>
    Effect.promise(async () => {
      rpcEventGateSetting = Option.some(true);
      const result = await Effect.runPromise(submitRpcRsvp(RPC_DISCORD_COMPLETE));
      expect(result._tag).toBe('Success');
    }),
  );

  itEffect.effect('Event/SubmitRsvp → succeeds when gate off, even incomplete', () =>
    Effect.promise(async () => {
      rpcEventGateSetting = Option.some(false);
      const result = await Effect.runPromise(submitRpcRsvp(RPC_DISCORD_INCOMPLETE));
      expect(result._tag).toBe('Success');
    }),
  );

  itEffect.effect(
    '8. Event/ClaimTraining → ClaimProfileIncomplete, claimTraining never called',
    () =>
      Effect.promise(async () => {
        rpcEventGateSetting = Option.some(true);
        const result = await Effect.runPromise(claimRpcTraining(RPC_DISCORD_INCOMPLETE));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as { _tag: string })._tag).toBe('ClaimProfileIncomplete');
        }
        expect(rpcClaimTrainingCalls).toBe(0);
      }),
  );

  itEffect.effect(
    '11. Event/UnclaimTraining is NOT gated — setting on, profile incomplete → success',
    () =>
      Effect.promise(async () => {
        rpcEventGateSetting = Option.some(true);
        const ev = rpcEventsStore.get(RPC_EVENT_ID);
        if (ev)
          rpcEventsStore.set(RPC_EVENT_ID, {
            ...ev,
            claimed_by: Option.some(RPC_INCOMPLETE_MEMBER_ID),
          });
        const result = await Effect.runPromise(unclaimRpcTraining(RPC_DISCORD_INCOMPLETE));
        expect(result._tag).toBe('Success');
        expect(rpcUnclaimTrainingCalls).toBe(1);
      }),
  );
});

// ============================================================
// RPC — `Carpool/ReserveSeat` / `Carpool/AddCar` / `Carpool/LeaveCarpool` profile gate (Task 3).
//
// `resolveMember` (`rpc/carpool/index.ts`) uses `TeamMembersRepository.findMembershipByDiscordAndTeam`
// (a real repository call, unlike the event side's raw SQL) — the gate must NOT live inside
// `resolveMember` (it is shared by all six carpool handlers, including the un-blocking
// `Carpool/LeaveCarpool` and `Carpool/RemoveCar`), so this mock returns the SAME
// membership-with-gate-fields shape for every carpool handler and the per-handler tests below are
// what actually prove the guard landed (or didn't land) in the right place.
// ============================================================

let carpoolGateSetting: Option.Option<boolean> = Option.none();
let carpoolReserveSeatCalls: number;
let carpoolAddCarCalls: number;
let carpoolLeaveCarpoolCalls: number;

const CARPOOL_TEAM_GUILD_ID = '833300000000000001' as Discord.Snowflake;
const CARPOOL_DISCORD_COMPLETE = '833300000000000010' as Discord.Snowflake;
const CARPOOL_DISCORD_INCOMPLETE = '833300000000000011' as Discord.Snowflake;
const CARPOOL_MEMBER_COMPLETE_ID =
  '00000000-0000-0000-0000-0000000a0041' as TeamMember.TeamMemberId;
const CARPOOL_MEMBER_INCOMPLETE_ID =
  '00000000-0000-0000-0000-0000000a0042' as TeamMember.TeamMemberId;
const CARPOOL_ID =
  '00000000-0000-0000-0000-0000000a0050' as CarpoolRpcModels.CarpoolView['carpool_id'];
const CARPOOL_CAR_ID =
  '00000000-0000-0000-0000-0000000a0051' as CarpoolRpcModels.CarpoolCarView['car_id'];
const CARPOOL_OTHER_OWNER_MEMBER_ID =
  '00000000-0000-0000-0000-0000000a0043' as TeamMember.TeamMemberId;

const carpoolMembershipFor = (discordId: Discord.Snowflake) => {
  if (discordId === CARPOOL_DISCORD_COMPLETE) {
    return {
      id: CARPOOL_MEMBER_COMPLETE_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_COMPLETE_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
      is_profile_complete: true,
      require_complete_profile: carpoolGateSetting,
    };
  }
  if (discordId === CARPOOL_DISCORD_INCOMPLETE) {
    return {
      id: CARPOOL_MEMBER_INCOMPLETE_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_USER_INCOMPLETE_ID,
      active: true,
      role_names: ['Player'],
      permissions: PLAYER_PERMISSIONS,
      is_profile_complete: false,
      require_complete_profile: carpoolGateSetting,
    };
  }
  return undefined;
};

const CarpoolMockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  findMembershipByDiscordAndTeam: (discordId: Discord.Snowflake) => {
    const m = carpoolMembershipFor(discordId);
    return Effect.succeed(m ? Option.some(m) : Option.none());
  },
  findMembershipByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getDefaultRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  resetMissedRsvps: () => Effect.void,
} as any);

const CarpoolMockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findByGuildId: (guildId: Discord.Snowflake) =>
    Effect.succeed(
      guildId === CARPOOL_TEAM_GUILD_ID ? Option.some({ id: TEST_TEAM_ID }) : Option.none(),
    ),
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const emptyCarpoolView = {
  carpool_id: CARPOOL_ID,
  language: 'en',
  discord_channel_id: '900000000000000001' as Discord.Snowflake,
  discord_message_id: Option.none(),
  event_id: Option.none(),
  cars: [],
};

const CarpoolMockCarpoolsRepositoryLayer = Layer.succeed(CarpoolsRepository, {
  createCarpool: () => Effect.die(new Error('Not implemented')),
  saveMessageId: () => Effect.void,
  saveCarThreadId: () => Effect.void,
  findCarpoolView: () => Effect.succeed(Option.some(emptyCarpoolView)),
  addCar: (_input: { readonly carpoolId: unknown }) => {
    carpoolAddCarCalls += 1;
    return Effect.succeed({ car_id: CARPOOL_CAR_ID, view: emptyCarpoolView });
  },
  reserveSeat: () => {
    carpoolReserveSeatCalls += 1;
    return Effect.void;
  },
  findCarById: () =>
    Effect.succeed(
      Option.some({
        id: CARPOOL_CAR_ID,
        carpool_id: CARPOOL_ID,
        owner_team_member_id: CARPOOL_OTHER_OWNER_MEMBER_ID,
        capacity: 4,
        thread_id: Option.none(),
        note: Option.none(),
      }),
    ),
  leaveSeat: () => Effect.void,
  leaveSeatByCarpool: () => {
    carpoolLeaveCarpoolCalls += 1;
    return Effect.succeed(CARPOOL_CAR_ID);
  },
  removeCar: () => Effect.die(new Error('Not implemented')),
  updateCarCapacity: () => Effect.die(new Error('Not implemented')),
  updateCarNote: () => Effect.die(new Error('Not implemented')),
  kickPassenger: () => Effect.die(new Error('Not implemented')),
} as any);

const CarpoolRpcTestLayer = CarpoolsRpcLive.pipe(
  Layer.provide(CarpoolMockCarpoolsRepositoryLayer),
  Layer.provide(CarpoolMockTeamMembersRepositoryLayer),
  Layer.provide(CarpoolMockTeamsRepositoryLayer),
);

// See `callEventRpc`'s comment above for why the trailing cast is required.
const callCarpoolRpc = <T>(name: string, payload: Record<string, unknown>) =>
  Effect.scoped(
    (RpcTest.makeClient(CarpoolRpcGroup.CarpoolRpcGroup) as Effect.Effect<any, never, any>).pipe(
      Effect.flatMap((rpc: any) => rpc[name](payload) as Effect.Effect<T, unknown, never>),
      Effect.result,
    ),
  ).pipe(Effect.provide(CarpoolRpcTestLayer)) as unknown as Effect.Effect<any, any, never>;

const reserveCarpoolSeat = (discordId: Discord.Snowflake) =>
  callCarpoolRpc('Carpool/ReserveSeat', {
    guild_id: CARPOOL_TEAM_GUILD_ID,
    discord_user_id: discordId,
    car_id: CARPOOL_CAR_ID,
  });

const addCarpoolCar = (discordId: Discord.Snowflake) =>
  callCarpoolRpc('Carpool/AddCar', {
    guild_id: CARPOOL_TEAM_GUILD_ID,
    discord_user_id: discordId,
    carpool_id: CARPOOL_ID,
    capacity: 4,
    note: Option.none(),
  });

const leaveCarpool = (discordId: Discord.Snowflake) =>
  callCarpoolRpc('Carpool/LeaveCarpool', {
    guild_id: CARPOOL_TEAM_GUILD_ID,
    discord_user_id: discordId,
    carpool_id: CARPOOL_ID,
  });

describe('RPC — Carpool/ReserveSeat / Carpool/AddCar profile gate (Task 3)', () => {
  beforeEach(() => {
    carpoolGateSetting = Option.none();
    carpoolReserveSeatCalls = 0;
    carpoolAddCarCalls = 0;
    carpoolLeaveCarpoolCalls = 0;
  });

  itEffect.effect(
    '9. Carpool/ReserveSeat → CarpoolProfileIncomplete, reserveSeat never called',
    () =>
      Effect.promise(async () => {
        carpoolGateSetting = Option.some(true);
        const result = await Effect.runPromise(reserveCarpoolSeat(CARPOOL_DISCORD_INCOMPLETE));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as { _tag: string })._tag).toBe('CarpoolProfileIncomplete');
        }
        expect(carpoolReserveSeatCalls).toBe(0);
      }),
  );

  itEffect.effect('Carpool/ReserveSeat → succeeds when profile complete', () =>
    Effect.promise(async () => {
      carpoolGateSetting = Option.some(true);
      const result = await Effect.runPromise(reserveCarpoolSeat(CARPOOL_DISCORD_COMPLETE));
      expect(result._tag).toBe('Success');
    }),
  );

  itEffect.effect('Carpool/ReserveSeat → succeeds when gate off', () =>
    Effect.promise(async () => {
      carpoolGateSetting = Option.some(false);
      const result = await Effect.runPromise(reserveCarpoolSeat(CARPOOL_DISCORD_INCOMPLETE));
      expect(result._tag).toBe('Success');
    }),
  );

  itEffect.effect('10. Carpool/AddCar → CarpoolProfileIncomplete, addCar never called', () =>
    Effect.promise(async () => {
      carpoolGateSetting = Option.some(true);
      const result = await Effect.runPromise(addCarpoolCar(CARPOOL_DISCORD_INCOMPLETE));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as { _tag: string })._tag).toBe('CarpoolProfileIncomplete');
      }
      expect(carpoolAddCarCalls).toBe(0);
    }),
  );

  itEffect.effect(
    '11. Carpool/LeaveCarpool is NOT gated — setting on, profile incomplete → success (guard did not land in resolveMember)',
    () =>
      Effect.promise(async () => {
        carpoolGateSetting = Option.some(true);
        const result = await Effect.runPromise(leaveCarpool(CARPOOL_DISCORD_INCOMPLETE));
        expect(result._tag).toBe('Success');
        expect(carpoolLeaveCarpoolCalls).toBe(1);
      }),
  );
});
