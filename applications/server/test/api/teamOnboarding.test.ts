// TDD mode — tests for the server HTTP onboarding endpoints:
//   PATCH /teams/:id (with onboarding field changes → flips status to pending)
//   POST  /teams/:id/onboarding/retry
//
// These tests will FAIL until Phase 5 implements:
//   - The new onboarding columns on teams (migration)
//   - The updateTeamInfo no-op detection helper
//   - The retryOnboardingSync HTTP endpoint
//
// Style mirrors applications/server/test/Team.test.ts using mock repository layers.

import type { Auth, Discord, Role, Team, TeamMember } from '@sideline/domain';
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
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
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
import { TeamChallengeRepository } from '~/repositories/TeamChallengeRepository.js';
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
import { MockDashboardLayoutsRepositoryLayer } from '../mocks/dashboardLayoutMocks.js';
import { MockFinanceLayers } from '../mocks/financeMocks.js';
import { MockTeamOnboardingTokensRepositoryLayer } from '../mocks/onboardingMocks.js';
import { MockTranslationsLayers } from '../mocks/translationMocks.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_ROLE_ID = '00000000-0000-0000-0000-000000000040' as Role.RoleId;
const TEST_TEAM_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const GUILD_ID = '999999999999999999' as Discord.Snowflake;
const RULES_CHANNEL_ID = '111111111111111111' as Discord.Snowflake;
const RULES_ROLE_ID = '222222222222222222' as Discord.Snowflake;
const WELCOME_CHANNEL_ID = '333333333333333333' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Mutable team state (simulates DB row)
// ---------------------------------------------------------------------------

let teamState: {
  id: Team.TeamId;
  name: string;
  guild_id: Discord.Snowflake;
  description: Option.Option<string>;
  sport: Option.Option<string>;
  logo_url: Option.Option<string>;
  created_by: Auth.UserId;
  created_at: DateTime.Utc;
  updated_at: DateTime.Utc;
  welcome_channel_id: Option.Option<Discord.Snowflake>;
  system_log_channel_id: Option.Option<Discord.Snowflake>;
  welcome_message_template: Option.Option<string>;
  rules_channel_id: Option.Option<Discord.Snowflake>;
  achievement_channel_id: Option.Option<Discord.Snowflake>;
  onboarding_rules_role_id: Option.Option<Discord.Snowflake>;
  onboarding_rules_prompt_id: Option.Option<Discord.Snowflake>;
  onboarding_locale: 'en' | 'cs';
  onboarding_synced_at: Option.Option<DateTime.Utc>;
  onboarding_sync_status: 'pending' | 'syncing' | 'done' | 'failed';
  onboarding_sync_error: Option.Option<string>;
};

const resetTeamState = () => {
  teamState = {
    id: TEST_TEAM_ID,
    name: 'Test Team',
    guild_id: GUILD_ID,
    description: Option.none(),
    sport: Option.none(),
    logo_url: Option.none(),
    created_by: TEST_USER_ID,
    created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
    updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
    welcome_channel_id: Option.some(WELCOME_CHANNEL_ID),
    system_log_channel_id: Option.none(),
    welcome_message_template: Option.none(),
    rules_channel_id: Option.some(RULES_CHANNEL_ID),
    achievement_channel_id: Option.none(),
    onboarding_rules_role_id: Option.some(RULES_ROLE_ID),
    onboarding_rules_prompt_id: Option.none(),
    onboarding_locale: 'en',
    onboarding_synced_at: Option.some(DateTime.makeUnsafe('2024-06-01T00:00:00Z')),
    onboarding_sync_status: 'done',
    onboarding_sync_error: Option.none(),
  };
};

// Tracks calls to markOnboardingSyncPending
let syncPendingCalls: string[] = [];

// ---------------------------------------------------------------------------
// Memberships
// ---------------------------------------------------------------------------

const memberMembership: MembershipWithRole = {
  id: TEST_TEAM_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: [],
  permissions: [],
} as unknown as MembershipWithRole;

const managerMembership: MembershipWithRole = {
  id: TEST_TEAM_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  role_names: [],
  permissions: ['team:manage'],
} as unknown as MembershipWithRole;

let currentMembership: MembershipWithRole = memberMembership;

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('user-token', TEST_USER_ID);
sessionsStore.set('manager-token', TEST_USER_ID);

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

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
  findById: (id: Auth.UserId) =>
    Effect.succeed(
      id === TEST_USER_ID
        ? Option.some({
            id: TEST_USER_ID,
            discord_id: '12345',
            username: 'testuser',
            avatar: Option.none(),
            is_profile_complete: true,
            name: Option.some('Test User'),
            birth_date: Option.none(),
            gender: Option.none(),
            locale: 'en' as const,
            discord_display_name: Option.none(),
            created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
            updated_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  create: (input: { token: string; user_id: Auth.UserId }) => {
    sessionsStore.set(input.token, input.user_id);
    return Effect.succeed({
      id: 'session-1',
      user_id: input.user_id,
      token: input.token,
      expires_at: DateTime.makeUnsafe('2030-01-01T00:00:00Z'),
      created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
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
        expires_at: DateTime.makeUnsafe('2030-01-01T00:00:00Z'),
        created_at: DateTime.makeUnsafe('2024-01-01T00:00:00Z'),
      }),
    );
  },
  deleteByToken: () => Effect.void,
} as any);

const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findById: (id: Team.TeamId) =>
    Effect.succeed(id === TEST_TEAM_ID ? Option.some(teamState) : Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
  findByGuildId: () => Effect.succeed(Option.none()),
  update: (input: any) => {
    // Simulate the update — check if onboarding fields changed to detect no-op
    const prevRulesChannel = Option.getOrNull(teamState.rules_channel_id);
    const prevRoleId = Option.getOrNull(teamState.onboarding_rules_role_id);
    const prevLocale = teamState.onboarding_locale;
    const prevWelcome = Option.getOrNull(teamState.welcome_channel_id);

    // Apply updates
    if ('rules_channel_id' in input) teamState.rules_channel_id = input.rules_channel_id;
    if ('onboarding_rules_role_id' in input)
      teamState.onboarding_rules_role_id = input.onboarding_rules_role_id;
    if ('onboarding_locale' in input) teamState.onboarding_locale = input.onboarding_locale;
    if ('welcome_channel_id' in input) teamState.welcome_channel_id = input.welcome_channel_id;
    if ('achievement_channel_id' in input)
      teamState.achievement_channel_id = input.achievement_channel_id;
    if ('name' in input) teamState.name = input.name;

    // Simulate the no-op detection + auto-flip
    const nextRulesChannel = Option.getOrNull(teamState.rules_channel_id);
    const nextRoleId = Option.getOrNull(teamState.onboarding_rules_role_id);
    const nextLocale = teamState.onboarding_locale;
    const nextWelcome = Option.getOrNull(teamState.welcome_channel_id);

    const changed =
      prevRulesChannel !== nextRulesChannel ||
      prevRoleId !== nextRoleId ||
      prevLocale !== nextLocale ||
      prevWelcome !== nextWelcome;

    if (changed) {
      teamState.onboarding_sync_status = 'pending';
      syncPendingCalls.push(String(input.id));
    }

    return Effect.succeed(teamState);
  },
  markOnboardingSyncPending: (teamId: Team.TeamId) => {
    syncPendingCalls.push(teamId);
    teamState.onboarding_sync_status = 'pending';
    teamState.onboarding_sync_error = Option.none();
    return Effect.void;
  },
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId) => {
    if (teamId !== TEST_TEAM_ID) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some(currentMembership));
  },
  addMember: () => Effect.die(new Error('Not implemented')),
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  getPlayerRoleId: () => Effect.succeed(Option.some({ id: TEST_ROLE_ID })),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
  deactivateMemberByIds: () => Effect.void,
} as any);

// Minimal stubs for unused repositories
const noopMockLayer = <T>(tag: T) =>
  Layer.succeed(
    tag as any,
    new Proxy({} as any, {
      get: () => () => Effect.void,
    }),
  );

const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  upsert: () => Effect.void,
  remove: () => Effect.void,
  exists: () => Effect.succeed(false),
  findAll: () => Effect.succeed([]),
  findByGuildId: () => Effect.succeed(Option.some({ is_community_enabled: true })),
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

const MockPendingGuildJoinsLayer = Layer.succeed(PendingGuildJoinsRepository, {
  enqueue: () => Effect.void,
  listPending: () => Effect.succeed([]),
  markDone: () => Effect.void,
  markFailed: () => Effect.void,
} as never);

// Tracks calls to the settings upsert (used to verify discord_channel_training flip)
let settingsUpsertCalls: unknown[] = [];
// Current simulated discord_channel_training value in team_settings
let currentTrainingChannelId: Option.Option<string> = Option.none();
const TRAINING_CHANNEL_ID = '777777777777777777' as Discord.Snowflake;

const resetSettingsState = () => {
  settingsUpsertCalls = [];
  currentTrainingChannelId = Option.none();
};

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeam: () => Effect.succeed(Option.none()),
  findByTeamId: (teamId: string) =>
    teamId === TEST_TEAM_ID
      ? Effect.succeed(
          Option.some({
            team_id: teamId,
            event_horizon_days: 30,
            min_players_threshold: 0,
            rsvp_reminders_enabled: true,
            rsvp_reminder_days_before: 1,
            rsvp_reminder_time: '18:00',
            reminders_channel_id: Option.none(),
            timezone: 'Europe/Prague',
            discord_channel_training: currentTrainingChannelId,
            discord_channel_match: Option.none(),
            discord_channel_tournament: Option.none(),
            discord_channel_meeting: Option.none(),
            discord_channel_social: Option.none(),
            discord_channel_other: Option.none(),
            discord_channel_late_rsvp: Option.none(),
            create_discord_channel_on_group: true,
            create_discord_channel_on_roster: true,
            discord_archive_category_id: Option.none(),
            discord_channel_cleanup_on_group_delete: 'delete',
            discord_channel_cleanup_on_roster_deactivate: 'delete',
            discord_role_format: '{role}',
            discord_channel_format: '{channel}',
          }),
        )
      : Effect.succeed(Option.none()),
  upsertSettings: (input: any) => {
    settingsUpsertCalls.push(input);
    // Simulate the auto-flip: if discord_channel_training changed, flip onboarding status
    const prevTraining = Option.getOrNull(currentTrainingChannelId);
    const nextTraining = input.discord_channel_training
      ? Option.getOrNull(input.discord_channel_training as Option.Option<string>)
      : prevTraining;
    if (prevTraining !== nextTraining) {
      teamState.onboarding_sync_status = 'pending';
      syncPendingCalls.push(String(TEST_TEAM_ID));
    }
    currentTrainingChannelId = input.discord_channel_training ?? currentTrainingChannelId;
    return Effect.succeed({ team_id: 'test', event_horizon_days: 30 });
  },
  upsert: (input: any) => {
    settingsUpsertCalls.push(input);
    return Effect.succeed({
      team_id: input.teamId ?? 'test',
      event_horizon_days: input.eventHorizonDays ?? 30,
      min_players_threshold: input.minPlayersThreshold ?? 0,
      rsvp_reminders_enabled: input.rsvpRemindersEnabled ?? true,
      rsvp_reminder_days_before: input.rsvpReminderDaysBefore ?? 1,
      rsvp_reminder_time: input.rsvpReminderTime ?? '18:00',
      reminders_channel_id: input.remindersChannelId ?? Option.none(),
      timezone: input.timezone ?? 'Europe/Prague',
      discord_channel_training: input.discordChannelTraining ?? Option.none(),
      discord_channel_match: input.discordChannelMatch ?? Option.none(),
      discord_channel_tournament: input.discordChannelTournament ?? Option.none(),
      discord_channel_meeting: input.discordChannelMeeting ?? Option.none(),
      discord_channel_social: input.discordChannelSocial ?? Option.none(),
      discord_channel_other: input.discordChannelOther ?? Option.none(),
      discord_channel_late_rsvp: input.discordChannelLateRsvp ?? Option.none(),
      create_discord_channel_on_group: input.createDiscordChannelOnGroup ?? true,
      create_discord_channel_on_roster: input.createDiscordChannelOnRoster ?? true,
      discord_archive_category_id: input.discordArchiveCategoryId ?? Option.none(),
      discord_channel_cleanup_on_group_delete: input.discordChannelCleanupOnGroupDelete ?? 'delete',
      discord_channel_cleanup_on_roster_deactivate:
        input.discordChannelCleanupOnRosterDeactivate ?? 'delete',
      discord_role_format: input.discordRoleFormat ?? '{role}',
      discord_channel_format: input.discordChannelFormat ?? '{channel}',
    });
  },
  getHorizon: () => Effect.succeed({ event_horizon_days: 30 }),
  getHorizonDays: () => Effect.succeed(30),
} as any);

const MockNoopLayers = Layer.mergeAll(
  noopMockLayer(RolesRepository),
  noopMockLayer(GroupsRepository),
  noopMockLayer(TeamInvitesRepository),
  noopMockLayer(InviteAcceptancesRepository),
  MockPendingGuildJoinsLayer,
  noopMockLayer(TrainingTypesRepository),
  noopMockLayer(RostersRepository),
  noopMockLayer(DiscordChannelsRepository),
  noopMockLayer(DiscordRoleMappingRepository),
  noopMockLayer(DiscordRolesRepository),
  noopMockLayer(DiscordChannelMappingRepository),
  noopMockLayer(EventsRepository),
  noopMockLayer(EventSeriesRepository),
  noopMockLayer(EventRsvpsRepository),
  noopMockLayer(ICalTokensRepository),
  noopMockLayer(ActivityLogsRepository),
  noopMockLayer(ActivityTypesRepository),
  noopMockLayer(LeaderboardRepository),
  noopMockLayer(NotificationsRepository),
  noopMockLayer(RoleSyncEventsRepository),
  noopMockLayer(ChannelSyncEventsRepository),
  noopMockLayer(EventSyncEventsRepository),
  noopMockLayer(AgeThresholdRepository),
  noopMockLayer(OAuthConnectionsRepository),
  noopMockLayer(TeamChallengeRepository),
  noopMockLayer(AgeCheckService),
  noopMockLayer(AchievementRoleMappingsRepository),
  noopMockLayer(AchievementSettingsRepository),
  noopMockLayer(CustomAchievementsRepository),
  noopMockLayer(DiscordRoleProvisionEventsRepository),
  noopMockLayer(AchievementPreview),
  MockTeamSettingsRepositoryLayer,
  MockTranslationsLayers,
);

const TestLayer = ApiLive.pipe(
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockBotGuildsRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
  Layer.provide(MockNoopLayers),
)
  .pipe(Layer.provide(MockFinanceLayers))
  .pipe(Layer.provide(MockTeamOnboardingTokensRepositoryLayer))
  .pipe(Layer.provide(MockDashboardLayoutsRepositoryLayer))
  .pipe(Layer.provide(BotInfoStore.Default));

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

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
  resetTeamState();
  resetSettingsState();
  syncPendingCalls = [];
  currentMembership = memberMembership;
});

const TEAM_URL = `http://localhost/teams/${TEST_TEAM_ID}`;
const RETRY_URL = `http://localhost/teams/${TEST_TEAM_ID}/onboarding/retry`;
const SETTINGS_URL = `http://localhost/teams/${TEST_TEAM_ID}/settings`;

const patchTeam = (body: Record<string, unknown>, token = 'manager-token') =>
  handler(
    new Request(TEAM_URL, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );

const patchTeamSettings = (body: Record<string, unknown>, token = 'manager-token') =>
  handler(
    new Request(SETTINGS_URL, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    }),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PATCH /teams/:id — onboarding field change detection', () => {
  it('changing rules_channel_id flips onboarding_sync_status to pending', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';

    const response = await patchTeam({ rulesChannelId: '444444444444444444' });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('pending');
  });

  it('changing onboarding_rules_role_id flips status to pending', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';

    const response = await patchTeam({ onboardingRulesRoleId: '555555555555555555' });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('pending');
  });

  it('changing onboarding_locale flips status to pending', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';
    teamState.onboarding_locale = 'en';

    const response = await patchTeam({ onboardingLocale: 'cs' });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('pending');
  });

  it('changing welcome_channel_id flips status to pending', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';

    const response = await patchTeam({ welcomeChannelId: '666666666666666666' });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('pending');
  });

  it('no-op save (only name changes) does NOT flip status', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';
    const statusBefore = teamState.onboarding_sync_status;

    const response = await patchTeam({ name: 'New Team Name Only' });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe(statusBefore);
    // syncPendingCalls should be empty — no flip happened
    expect(syncPendingCalls).toHaveLength(0);
  });

  it('saving the same value for rules_channel_id does NOT flip status (idempotent save)', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';
    // Same value as the current state
    const response = await patchTeam({ rulesChannelId: RULES_CHANNEL_ID });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('done');
    expect(syncPendingCalls).toHaveLength(0);
  });
});

describe('PATCH /teams/:id/settings — discord_channel_training change', () => {
  it('changing discord_channel_training flips onboarding_sync_status to pending (plan §4 settings endpoint)', async () => {
    // Plan §4: captain saves to team-settings go through team-settings.ts which must apply
    // the SAME auto-flip narrowing for discord_channel_training changes.
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';
    currentTrainingChannelId = Option.none(); // no training channel set currently

    const response = await patchTeamSettings({
      discordChannelTraining: TRAINING_CHANNEL_ID,
    });

    expect(response.status).toBe(200);
    // The settings handler must call markOnboardingSyncPending when training channel changes
    expect(teamState.onboarding_sync_status).toBe('pending');
  });

  it('saving same discord_channel_training value does NOT flip status (idempotent)', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';
    currentTrainingChannelId = Option.some(TRAINING_CHANNEL_ID);

    const response = await patchTeamSettings({
      discordChannelTraining: TRAINING_CHANNEL_ID,
    });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('done');
  });
});

describe('PATCH /teams/:id — achievementChannelId does NOT trigger onboarding sync', () => {
  it('updating only achievementChannelId does NOT enqueue an onboarding sync', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'done';

    const response = await patchTeam({
      achievementChannelId: '111111111111111111',
    });

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('done');
    expect(syncPendingCalls).toHaveLength(0);
  });
});

describe('POST /teams/:id/onboarding/retry', () => {
  it('flips status to pending and clears error (requires team:manage)', async () => {
    currentMembership = managerMembership;
    teamState.onboarding_sync_status = 'failed';
    teamState.onboarding_sync_error = Option.some(
      JSON.stringify({ code: 'role_deleted', detail: 'Role gone' }),
    );

    const response = await handler(
      new Request(RETRY_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer manager-token' },
      }),
    );

    expect(response.status).toBe(200);
    expect(teamState.onboarding_sync_status).toBe('pending');
    expect(Option.isNone(teamState.onboarding_sync_error)).toBe(true);
  });

  it('returns 403 when user lacks team:manage permission', async () => {
    currentMembership = memberMembership;

    const response = await handler(
      new Request(RETRY_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer user-token' },
      }),
    );

    expect(response.status).toBe(403);
  });
});
