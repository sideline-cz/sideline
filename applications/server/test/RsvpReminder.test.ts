import type { Auth, Discord, Event, EventRsvp, Role, Team, TeamMember } from '@sideline/domain';
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
import { MockChannelManagementLayers } from './mocks/channelMocks.js';
import { MockDashboardLayoutsRepositoryLayer } from './mocks/dashboardLayoutMocks.js';
import { MockFinanceLayers } from './mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from './mocks/onboardingMocks.js';
import { MockTeamChallengeRepositoryLayer } from './mocks/teamChallengeMocks.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

// --- Test IDs ---
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_ADMIN_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_ADMIN_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const TEST_EVENT_ACTIVE = '00000000-0000-0000-0000-000000000060' as Event.EventId;

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
  discord_display_name: Option.Option<string>;
  discord_nickname: Option.Option<string>;
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
};

const testUser: UserLike = {
  id: TEST_USER_ID,
  discord_id: '12345',
  username: 'testuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Test User'),
  birth_date: Option.some(DateTime.makeUnsafe('2000-01-01')),
  gender: Option.some('male' as const),
  locale: 'en',
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testAdmin: UserLike = {
  id: TEST_ADMIN_ID,
  discord_id: '67890',
  username: 'adminuser',
  avatar: Option.none<string>(),
  is_profile_complete: true,
  name: Option.some('Admin User'),
  birth_date: Option.some(DateTime.makeUnsafe('1990-01-01')),
  gender: Option.some('male' as const),
  locale: 'en',
  discord_display_name: Option.none<string>(),
  discord_nickname: Option.none<string>(),
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const usersMap = new Map<Auth.UserId, UserLike>();
usersMap.set(TEST_USER_ID, testUser);
usersMap.set(TEST_ADMIN_ID, testAdmin);

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
// NOTE (TDD additions at bottom): new tests reference new fields on the store and
// mock repository that do not yet exist (rsvpReminderDaysBefore, rsvpReminderTime,
// remindersChannelId, timezone). They will FAIL until the developer implements the
// server task and updates this file's mock accordingly.
let teamSettingsStore: {
  min_players_threshold: number;
  event_horizon_days: number;
  rsvp_reminders_enabled: boolean;
  rsvp_reminder_days_before: number;
  claim_request_days_before: number;
  rsvp_reminder_time: string;
  reminders_channel_id: Option.Option<string>;
  timezone: string;
};

const resetStores = () => {
  rsvpsStore = new Map();
  teamSettingsStore = {
    min_players_threshold: 5,
    event_horizon_days: 30,
    rsvp_reminders_enabled: true,
    rsvp_reminder_days_before: 1,
    claim_request_days_before: 3,
    rsvp_reminder_time: '18:00',
    reminders_channel_id: Option.none(),
    timezone: 'Europe/Prague',
  };
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
    permissions,
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

// --- Mock layers (shared setup from EventRsvp.test.ts) ---
const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
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
  findById: (id: Team.TeamId) => {
    if (id === TEST_TEAM_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_TEAM_ID,
          name: 'Test Team',
          guild_id: '999' as Discord.Snowflake,
          created_by: TEST_ADMIN_ID,
          created_at: DateTime.nowUnsafe(),
          updated_at: DateTime.nowUnsafe(),
        }),
      );
    return Effect.succeed(Option.none());
  },
  insert: () => Effect.die(new Error('Not implemented')),
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
    if (!member || member.team_id !== teamId || !member.active)
      return Effect.succeed(Option.none());
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
  findByTeamId: () => Effect.succeed([]),
  findEventsByTeamId: () => Effect.succeed([]),
  findByIdWithDetails: (id: Event.EventId) => {
    if (id === TEST_EVENT_ACTIVE)
      return Effect.succeed(
        Option.some({
          id: TEST_EVENT_ACTIVE,
          team_id: TEST_TEAM_ID,
          training_type_id: Option.none(),
          event_type: 'training' as const,
          title: 'Future Training',
          description: Option.none(),
          start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
          end_at: Option.some(DateTime.makeUnsafe('2099-12-31T20:00:00Z')),
          location: Option.none(),
          status: 'active' as const,
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
        }),
      );
    return Effect.succeed(Option.none());
  },
  findEventByIdWithDetails: (id: Event.EventId) => {
    if (id === TEST_EVENT_ACTIVE)
      return Effect.succeed(
        Option.some({
          id: TEST_EVENT_ACTIVE,
          team_id: TEST_TEAM_ID,
          training_type_id: Option.none(),
          event_type: 'training' as const,
          title: 'Future Training',
          description: Option.none(),
          start_at: DateTime.makeUnsafe('2099-12-31T18:00:00Z'),
          end_at: Option.some(DateTime.makeUnsafe('2099-12-31T20:00:00Z')),
          location: Option.none(),
          status: 'active' as const,
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
        }),
      );
    return Effect.succeed(Option.none());
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
  markReminder: () => Effect.void,
  markReminderSent: () => Effect.void,
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
  findByEventAndMember: () => Effect.succeed(Option.none()),
  findRsvpByEventAndMember: (eventId: Event.EventId, memberId: TeamMember.TeamMemberId) => {
    const key = `${eventId}:${memberId}`;
    const rsvp = rsvpsStore.get(key);
    return Effect.succeed(rsvp ? Option.some(rsvp) : Option.none());
  },
  upsert: () => Effect.die(new Error('Not implemented')),
  upsertRsvp: (
    eventId: Event.EventId,
    memberId: TeamMember.TeamMemberId,
    response: EventRsvp.RsvpResponse,
    message: Option.Option<string>,
  ) => {
    const key = `${eventId}:${memberId}`;
    const existing = rsvpsStore.get(key);
    const id = existing?.id ?? (crypto.randomUUID() as EventRsvp.EventRsvpId);
    const record: RsvpRecord = {
      id,
      event_id: eventId,
      team_member_id: memberId,
      response,
      message,
      member_name: Option.none(),
      username: Option.none(),
      nickname: Option.none(),
      display_name: Option.none(),
    };
    rsvpsStore.set(key, record);
    return Effect.succeed(record);
  },
  countByEventId: (eventId: Event.EventId) => {
    const rsvps = Array.from(rsvpsStore.values()).filter((r) => r.event_id === eventId);
    const counts = new Map<string, number>();
    for (const r of rsvps) counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
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
    for (const r of rsvps) counts.set(r.response, (counts.get(r.response) ?? 0) + 1);
    return Effect.succeed(
      Array.from(counts.entries()).map(([response, count]) => ({
        response: response as EventRsvp.RsvpResponse,
        count,
      })),
    );
  },
  findNonResponders: (_input: { event_id: string; team_id: string }) => {
    const responded = new Set(
      Array.from(rsvpsStore.values())
        .filter((r) => r.event_id === _input.event_id)
        .map((r) => r.team_member_id),
    );
    const nonResponders = Array.from(membersStore.values())
      .filter((m) => m.team_id === _input.team_id && m.active && !responded.has(m.id))
      .map((m) => {
        const user = usersMap.get(m.user_id);
        return {
          team_member_id: m.id,
          member_name: user ? user.name : Option.none(),
          username: user ? Option.some(user.username) : Option.none(),
          discord_id: user ? Option.some(user.discord_id) : Option.none(),
        };
      });
    return Effect.succeed(nonResponders);
  },
  findNonRespondersByEventId: (eventId: Event.EventId, teamId: string) => {
    const responded = new Set(
      Array.from(rsvpsStore.values())
        .filter((r) => r.event_id === eventId)
        .map((r) => r.team_member_id),
    );
    const nonResponders = Array.from(membersStore.values())
      .filter((m) => m.team_id === teamId && m.active && !responded.has(m.id))
      .map((m) => {
        const user = usersMap.get(m.user_id);
        return {
          team_member_id: m.id,
          member_name: user ? user.name : Option.none(),
          username: user ? Option.some(user.username) : Option.none(),
          discord_id: user ? Option.some(user.discord_id) : Option.none(),
          nickname: user ? user.discord_nickname : Option.none(),
          display_name: user ? user.discord_display_name : Option.none(),
        };
      });
    return Effect.succeed(nonResponders);
  },
} as any);

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  _tag: 'api/TeamSettingsRepository',
  findByTeam: () =>
    Effect.succeed(
      Option.some({
        team_id: TEST_TEAM_ID,
        event_horizon_days: teamSettingsStore.event_horizon_days,
        min_players_threshold: teamSettingsStore.min_players_threshold,
        rsvp_reminders_enabled: teamSettingsStore.rsvp_reminders_enabled,
        rsvp_reminder_days_before: teamSettingsStore.rsvp_reminder_days_before,
        claim_request_days_before: teamSettingsStore.claim_request_days_before,
        rsvp_reminder_time: teamSettingsStore.rsvp_reminder_time,
        reminders_channel_id: teamSettingsStore.reminders_channel_id,
        timezone: teamSettingsStore.timezone,
        discord_channel_training: Option.none(),
        discord_channel_match: Option.none(),
        discord_channel_tournament: Option.none(),
        discord_channel_meeting: Option.none(),
        discord_channel_social: Option.none(),
        discord_channel_other: Option.none(),
        discord_channel_late_rsvp: Option.none(),
        create_discord_channel_on_group: true,
        create_discord_channel_on_roster: true,
        discord_archive_category_id: Option.none(),
        discord_channel_cleanup_on_group_delete: 'delete' as const,
        discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
        discord_role_format: '{emoji} {name}',
        discord_channel_format: '{emoji}│{name}',
      }),
    ),
  findByTeamId: () =>
    Effect.succeed(
      Option.some({
        team_id: TEST_TEAM_ID,
        event_horizon_days: teamSettingsStore.event_horizon_days,
        min_players_threshold: teamSettingsStore.min_players_threshold,
        rsvp_reminders_enabled: teamSettingsStore.rsvp_reminders_enabled,
        rsvp_reminder_days_before: teamSettingsStore.rsvp_reminder_days_before,
        claim_request_days_before: teamSettingsStore.claim_request_days_before,
        rsvp_reminder_time: teamSettingsStore.rsvp_reminder_time,
        reminders_channel_id: teamSettingsStore.reminders_channel_id,
        timezone: teamSettingsStore.timezone,
        discord_channel_training: Option.none(),
        discord_channel_match: Option.none(),
        discord_channel_tournament: Option.none(),
        discord_channel_meeting: Option.none(),
        discord_channel_social: Option.none(),
        discord_channel_other: Option.none(),
        discord_channel_late_rsvp: Option.none(),
        create_discord_channel_on_group: true,
        create_discord_channel_on_roster: true,
        discord_archive_category_id: Option.none(),
        discord_channel_cleanup_on_group_delete: 'delete' as const,
        discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
        discord_role_format: '{emoji} {name}',
        discord_channel_format: '{emoji}│{name}',
      }),
    ),
  upsertSettings: (input: {
    team_id: string;
    event_horizon_days: number;
    min_players_threshold: number;
    rsvp_reminder_days_before?: number;
    claim_request_days_before?: number;
    rsvp_reminder_time?: string;
    reminders_channel_id?: Option.Option<string>;
    timezone?: string;
    discord_channel_training: Option.Option<string>;
    discord_channel_match: Option.Option<string>;
    discord_channel_tournament: Option.Option<string>;
    discord_channel_meeting: Option.Option<string>;
    discord_channel_social: Option.Option<string>;
    discord_channel_other: Option.Option<string>;
  }) =>
    Effect.succeed({
      team_id: TEST_TEAM_ID,
      event_horizon_days: input.event_horizon_days,
      min_players_threshold: input.min_players_threshold,
      rsvp_reminders_enabled: teamSettingsStore.rsvp_reminders_enabled,
      rsvp_reminder_days_before:
        input.rsvp_reminder_days_before ?? teamSettingsStore.rsvp_reminder_days_before,
      claim_request_days_before:
        input.claim_request_days_before ?? teamSettingsStore.claim_request_days_before,
      rsvp_reminder_time: input.rsvp_reminder_time ?? teamSettingsStore.rsvp_reminder_time,
      reminders_channel_id: input.reminders_channel_id ?? teamSettingsStore.reminders_channel_id,
      timezone: input.timezone ?? teamSettingsStore.timezone,
      discord_channel_training: Option.none(),
      discord_channel_match: Option.none(),
      discord_channel_tournament: Option.none(),
      discord_channel_meeting: Option.none(),
      discord_channel_social: Option.none(),
      discord_channel_other: Option.none(),
      discord_channel_late_rsvp: Option.none(),
      create_discord_channel_on_group: false,
      create_discord_channel_on_roster: true,
      discord_archive_category_id: Option.none(),
      discord_channel_cleanup_on_group_delete: 'delete' as const,
      discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
      discord_role_format: '{emoji} {name}',
      discord_channel_format: '{emoji}│{name}',
    }),
  upsert: (input: {
    teamId: string;
    eventHorizonDays: number;
    minPlayersThreshold: number;
    rsvpReminderDaysBefore?: number;
    claimRequestDaysBefore?: number;
    rsvpReminderTime?: string;
    remindersChannelId?: Option.Option<string>;
    timezone?: string;
    discordChannelTraining?: Option.Option<string>;
    discordChannelMatch?: Option.Option<string>;
    discordChannelTournament?: Option.Option<string>;
    discordChannelMeeting?: Option.Option<string>;
    discordChannelSocial?: Option.Option<string>;
    discordChannelOther?: Option.Option<string>;
  }) => {
    teamSettingsStore.min_players_threshold = input.minPlayersThreshold;
    teamSettingsStore.event_horizon_days = input.eventHorizonDays;
    if (input.rsvpReminderDaysBefore !== undefined)
      teamSettingsStore.rsvp_reminder_days_before = input.rsvpReminderDaysBefore;
    if (input.claimRequestDaysBefore !== undefined)
      teamSettingsStore.claim_request_days_before = input.claimRequestDaysBefore;
    if (input.rsvpReminderTime !== undefined)
      teamSettingsStore.rsvp_reminder_time = input.rsvpReminderTime;
    if (input.remindersChannelId !== undefined)
      teamSettingsStore.reminders_channel_id = input.remindersChannelId;
    if (input.timezone !== undefined) teamSettingsStore.timezone = input.timezone;
    return Effect.succeed({
      team_id: TEST_TEAM_ID,
      event_horizon_days: input.eventHorizonDays,
      min_players_threshold: input.minPlayersThreshold,
      rsvp_reminders_enabled: teamSettingsStore.rsvp_reminders_enabled,
      rsvp_reminder_days_before: teamSettingsStore.rsvp_reminder_days_before,
      claim_request_days_before: teamSettingsStore.claim_request_days_before,
      rsvp_reminder_time: teamSettingsStore.rsvp_reminder_time,
      reminders_channel_id: teamSettingsStore.reminders_channel_id,
      timezone: teamSettingsStore.timezone,
      discord_channel_training: Option.none(),
      discord_channel_match: Option.none(),
      discord_channel_tournament: Option.none(),
      discord_channel_meeting: Option.none(),
      discord_channel_social: Option.none(),
      discord_channel_other: Option.none(),
      discord_channel_late_rsvp: Option.none(),
      create_discord_channel_on_group: false,
      create_discord_channel_on_roster: true,
      discord_archive_category_id: Option.none(),
      discord_channel_cleanup_on_group_delete: 'delete' as const,
      discord_channel_cleanup_on_roster_deactivate: 'delete' as const,
      discord_role_format: '{emoji} {name}',
      discord_channel_format: '{emoji}│{name}',
    });
  },
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
  findEventsForReminder: () => Effect.succeed([]),
  findEventsNeedingReminder: () => Effect.succeed([]),
} as any);

// Stubs for other repos
const die = () => Effect.die(new Error('Not implemented'));

const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
  findByTeamId: () => Effect.succeed([]),
  findRosterById: () => Effect.succeed(Option.none()),
  insert: die,
  update: die,
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
  insert: die,
  insertTrainingType: die,
  update: die,
  updateTrainingType: die,
  deleteTrainingType: () => Effect.void,
  deleteTrainingTypeById: () => Effect.void,
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
      Layer.succeed(TeamInvitesRepository, {
        _tag: 'api/TeamInvitesRepository',
        findByCode: () => Effect.succeed(Option.none()),
        findByTeam: () => Effect.succeed([]),
        create: die,
        deactivateByTeam: () => Effect.void,
        deactivateByTeamExcept: () => Effect.void,
      } as any),
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
  Layer.provide(
    Layer.succeed(RolesRepository, {
      _tag: 'api/RolesRepository',
      findRolesByTeamId: () => Effect.succeed([]),
      findRoleById: () => Effect.succeed(Option.none()),
      getPermissionsForRoleId: () => Effect.succeed([]),
      insertRole: die,
      updateRole: die,
      archiveRoleById: () => Effect.void,
      setRolePermissions: () => Effect.void,
      initializeTeamRoles: () => Effect.void,
      findRoleByTeamAndName: () => Effect.succeed(Option.none()),
      seedTeamRolesWithPermissions: () => Effect.succeed([]),
      getMemberCountForRole: () => Effect.succeed(0),
      findGroupsForRole: () => Effect.succeed([]),
      assignRoleToGroup: () => Effect.void,
      unassignRoleFromGroup: () => Effect.void,
    } as any),
  ),
  Layer.provide(
    Layer.succeed(GroupsRepository, {
      _tag: 'api/GroupsRepository',
      findGroupsByTeamId: () => Effect.succeed([]),
      findGroupById: () => Effect.succeed(Option.none()),
      insertGroup: die,
      updateGroupById: die,
      archiveGroupById: () => Effect.void,
      moveGroup: die,
      findMembersByGroupId: () => Effect.succeed([]),
      addMemberById: () => Effect.void,
      removeMemberById: () => Effect.void,
      getRolesForGroup: () => Effect.succeed([]),
      getMemberCount: () => Effect.succeed(0),
      getChildren: () => Effect.succeed([]),
      getAncestorIds: () => Effect.succeed([]),
      getDescendantMemberIds: () => Effect.succeed([]),
    } as any),
  ),
  Layer.provide(MockTrainingTypesRepositoryLayer),
  Layer.provide(Layer.merge(MockEventsRepositoryLayer, MockEventRsvpsRepositoryLayer)),
  Layer.provide(
    Layer.succeed(
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
    ),
  ),
  Layer.provide(
    Layer.succeed(AgeCheckService, {
      evaluateTeam: () => Effect.succeed([]),
      evaluate: () => Effect.succeed([]),
    } as any),
  ),
  Layer.provide(
    Layer.succeed(AgeThresholdRepository, {
      findByTeamId: () => Effect.succeed([]),
      findRulesByTeamId: () => Effect.succeed([]),
      findById: () => Effect.succeed(Option.none()),
      findRuleById: () => Effect.succeed(Option.none()),
      insert: die,
      insertRule: die,
      updateRule: die,
      updateRuleById: die,
      deleteRule: () => Effect.void,
      deleteRuleById: () => Effect.void,
      findAllTeamsWithRules: () => Effect.succeed([]),
      getAllTeamsWithRules: () => Effect.succeed([]),
      findMembersWithBirthYears: () => Effect.succeed([]),
      getMembersForAutoAssignment: () => Effect.succeed([]),
    } as any),
  ),
  Layer.provide(
    Layer.merge(
      Layer.succeed(NotificationsRepository, {
        findByUserId: () => Effect.succeed([]),
        findByUser: () => Effect.succeed([]),
        insertOne: die,
        insert: die,
        insertBulk: () => Effect.void,
        markOneAsRead: () => Effect.void,
        markAsRead: () => Effect.void,
        markAllRead: () => Effect.void,
        markAllAsRead: () => Effect.void,
        findOneById: () => Effect.succeed(Option.none()),
        findById: () => Effect.succeed(Option.none()),
      } as any),
      Layer.succeed(RoleSyncEventsRepository, {
        emitRoleCreated: () => Effect.void,
        emitRoleDeleted: () => Effect.void,
        emitRoleAssigned: () => Effect.void,
        emitRoleUnassigned: () => Effect.void,
        findUnprocessed: () => Effect.succeed([]),
        markProcessed: () => Effect.void,
        markFailed: () => Effect.void,
      } as any),
    ),
  ),
  Layer.provide(
    Layer.merge(
      Layer.succeed(ChannelSyncEventsRepository, {
        emitChannelCreated: () => Effect.void,
        emitChannelDeleted: () => Effect.void,
        emitMemberAdded: () => Effect.void,
        emitMemberRemoved: () => Effect.void,
        findUnprocessed: () => Effect.succeed([]),
        markProcessed: () => Effect.void,
        markFailed: () => Effect.void,
        hasUnprocessedForGroups: () => Effect.succeed([]),
        hasUnprocessedForRosters: () => Effect.succeed([]),
      } as any),
      Layer.succeed(EventSyncEventsRepository, {
        emitEventCreated: () => Effect.void,
        emitEventUpdated: () => Effect.void,
        emitEventCancelled: () => Effect.void,
        emitRsvpReminder: () => Effect.void,
        findUnprocessed: () => Effect.succeed([]),
        markProcessed: () => Effect.void,
        markFailed: () => Effect.void,
      } as any),
    ),
  ),
  Layer.provide(
    Layer.merge(
      Layer.merge(
        Layer.merge(
          Layer.merge(
            Layer.merge(
              Layer.succeed(DiscordChannelMappingRepository, {
                findByGroupId: () => Effect.succeed(Option.none()),
                insert: () => Effect.void,
                insertWithoutRole: () => Effect.void,
                deleteByGroupId: () => Effect.void,
                findAllByTeamId: () => Effect.succeed([]),
                findAllByTeam: () => Effect.succeed([]),
              } as any),
              MockICalTokensRepositoryLayer,
            ),
            Layer.succeed(BotGuildsRepository, {
              upsert: () => Effect.void,
              remove: () => Effect.void,
              exists: () => Effect.succeed(false),
              findAll: () => Effect.succeed([]),
            } as any),
          ),
          Layer.merge(
            Layer.succeed(DiscordChannelsRepository, {
              syncChannels: () => Effect.void,
              findByGuildId: () => Effect.succeed([]),
            } as any),
            Layer.succeed(
              DiscordRolesRepository,
              new Proxy({} as any, { get: () => () => Effect.void }),
            ),
          ),
        ),
        MockTeamSettingsRepositoryLayer,
      ),
      Layer.merge(
        Layer.succeed(OAuthConnectionsRepository, {
          _tag: 'api/OAuthConnectionsRepository',
          upsertConnection: die,
          upsert: die,
          findByUserAndProvider: () => Effect.succeed(Option.none()),
          findByUser: () => Effect.succeed(Option.none()),
          findAccessToken: () => Effect.succeed(Option.some({ access_token: 'mock-access-token' })),
          getAccessToken: () => Effect.succeed('mock-access-token'),
        } as any),
        Layer.succeed(EventSeriesRepository, {
          _tag: 'api/EventSeriesRepository',
          insertSeries: die,
          insertEventSeries: die,
          findByTeamId: () => Effect.succeed([]),
          findSeriesByTeamId: () => Effect.succeed([]),
          findById: () => Effect.succeed(Option.none()),
          findSeriesById: () => Effect.succeed(Option.none()),
          updateSeries: die,
          updateEventSeries: die,
          cancelSeries: () => Effect.void,
          cancelEventSeries: () => Effect.void,
        } as any),
      ),
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

const SETTINGS_URL = `http://localhost/teams/${TEST_TEAM_ID}/settings`;
const BASE = `http://localhost/teams/${TEST_TEAM_ID}/events`;

describe('RSVP Reminder Features', () => {
  describe('Team Settings - new fields', () => {
    it('GET returns min_players_threshold and new reminder fields', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, { headers: { Authorization: 'Bearer admin-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.minPlayersThreshold).toBe(5);
      expect(body.rsvpReminderDaysBefore).toBe(1);
      expect(body.rsvpReminderTime).toBe('18:00');
      expect(body.remindersChannelId).toBeNull();
      expect(body.timezone).toBe('Europe/Prague');
    });

    it('PATCH updates min_players_threshold', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            minPlayersThreshold: 10,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.minPlayersThreshold).toBe(10);
    });
  });

  describe('GET /teams/:teamId/events/:eventId/rsvps', () => {
    it('returns minPlayersThreshold in RSVP detail', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.minPlayersThreshold).toBe(5);
    });
  });

  describe('GET /teams/:teamId/events/:eventId/rsvps/non-responders', () => {
    it('captain (admin) can see non-responders', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps/non-responders`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.nonResponders).toHaveLength(2); // both members haven't responded
    });

    it('player without event:edit gets 403', async () => {
      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps/non-responders`, {
          headers: { Authorization: 'Bearer user-token' },
        }),
      );
      expect(response.status).toBe(403);
    });

    it('non-responders list shrinks after RSVP', async () => {
      // Admin submits RSVP
      await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvp`, {
          method: 'PUT',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ response: 'yes', message: null }),
        }),
      );

      const response = await handler(
        new Request(`${BASE}/${TEST_EVENT_ACTIVE}/rsvps/non-responders`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.nonResponders).toHaveLength(1); // only player hasn't responded
    });

    it('returns 404 for unknown event', async () => {
      const unknownId = '00000000-0000-0000-0000-000000000099';
      const response = await handler(
        new Request(`${BASE}/${unknownId}/rsvps/non-responders`, {
          headers: { Authorization: 'Bearer admin-token' },
        }),
      );
      expect(response.status).toBe(404);
    });
  });

  // NOTE: The tests below reference NEW fields not yet implemented.
  // They will FAIL until the developer updates TeamSettingsApi, the HTTP handler,
  // and the mock repository in this file to carry the new fields.

  describe('Team Settings - new reminder fields (TDD)', () => {
    it('GET returns new reminder fields with correct defaults', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, { headers: { Authorization: 'Bearer admin-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rsvpReminderDaysBefore).toBe(1);
      expect(body.rsvpReminderTime).toBe('18:00');
      expect(body.remindersChannelId).toBeNull();
      expect(body.timezone).toBe('Europe/Prague');
    });

    it('PATCH updates rsvpReminderDaysBefore', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderDaysBefore: 3,
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rsvpReminderDaysBefore).toBe(3);
    });

    it('PATCH updates rsvpReminderTime', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: '09:00',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rsvpReminderTime).toBe('09:00');
    });

    it('PATCH updates remindersChannelId to a snowflake', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            remindersChannelId: '123456789012345678',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.remindersChannelId).toBe('123456789012345678');
    });

    it('PATCH updates timezone', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            timezone: 'America/New_York',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.timezone).toBe('America/New_York');
    });

    it('PATCH rejects invalid rsvpReminderTime format', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: '25:00',
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('PATCH rejects rsvpReminderDaysBefore out of range (15)', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderDaysBefore: 15,
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('PATCH rejects invalid timezone string', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            timezone: 'Not/ATimezone',
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('GET returns rsvpReminderTime without seconds (HH:MM not HH:MM:SS)', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, { headers: { Authorization: 'Bearer admin-token' } }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      // Must be exactly HH:MM format, not HH:MM:SS
      expect(body.rsvpReminderTime).toMatch(/^\d{2}:\d{2}$/);
      expect(body.rsvpReminderTime).toBe('18:00');
    });

    it('PATCH round-trips rsvpReminderTime value (GET → PATCH same value → 200)', async () => {
      const getResponse = await handler(
        new Request(SETTINGS_URL, { headers: { Authorization: 'Bearer admin-token' } }),
      );
      const getBody = await getResponse.json();
      const currentTime: string = getBody.rsvpReminderTime;

      const patchResponse = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: currentTime,
          }),
        }),
      );
      expect(patchResponse.status).toBe(200);
      const patchBody = await patchResponse.json();
      expect(patchBody.rsvpReminderTime).toBe(currentTime);
    });

    it('PATCH rejects rsvpReminderTime at 23:55 (midnight wrap)', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: '23:55',
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('PATCH rejects rsvpReminderTime at 23:59 (midnight wrap)', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: '23:59',
          }),
        }),
      );
      expect(response.status).toBe(400);
    });

    it('PATCH accepts rsvpReminderTime at 23:54 (last valid time)', async () => {
      const response = await handler(
        new Request(SETTINGS_URL, {
          method: 'PATCH',
          headers: {
            Authorization: 'Bearer admin-token',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            eventHorizonDays: 30,
            rsvpReminderTime: '23:54',
          }),
        }),
      );
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.rsvpReminderTime).toBe('23:54');
    });
  });
});
