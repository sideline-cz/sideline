import type { Auth, Role, Team, TeamMember } from '@sideline/domain';
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
import { DiscordOAuth } from '~/services/DiscordOAuth.js';
import { MockTranslationsLayers } from './mocks/translationMocks.js';

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;

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
  created_at: DateTime.nowUnsafe(),
  updated_at: DateTime.nowUnsafe(),
};

const testMembership: MembershipWithRole = {
  id: TEST_MEMBER_ID,
  team_id: TEST_TEAM_ID,
  user_id: TEST_USER_ID,
  active: true,
  permissions: [...ADMIN_PERMISSIONS],
  role_names: ['Admin'],
};

// --- Token state ---
let storedToken: {
  id: string;
  user_id: string;
  token: string;
  created_at: Date;
} | null = null;

const MockICalTokensRepositoryLayer = Layer.succeed(ICalTokensRepository, {
  _tag: 'api/ICalTokensRepository',
  findByToken: (token: string) =>
    Effect.succeed(
      storedToken && storedToken.token === token ? Option.some(storedToken) : Option.none(),
    ),
  findByUserId: (userId: string) =>
    Effect.succeed(
      storedToken && storedToken.user_id === userId ? Option.some(storedToken) : Option.none(),
    ),
  create: (userId: string) => {
    storedToken = {
      id: 'ical-id-1',
      user_id: userId,
      token: 'generated-ical-token',
      created_at: new Date(),
    };
    return Effect.succeed(storedToken);
  },
  regenerate: (userId: string) => {
    storedToken = {
      id: 'ical-id-2',
      user_id: userId,
      token: 'regenerated-ical-token',
      created_at: new Date(),
    };
    return Effect.succeed(storedToken);
  },
} as any);

const testEvents = [
  {
    id: '00000000-0000-0000-0000-000000000060',
    title: 'Tuesday Training',
    description: Option.some('Bring your boots'),
    start_at: DateTime.makeUnsafe('2026-03-15T18:00:00Z'),
    end_at: Option.some(DateTime.makeUnsafe('2026-03-15T19:30:00Z')),
    location: Option.some('Main Field'),
    location_url: Option.none<string>(),
    status: 'active',
    event_type: 'training',
    team_name: 'Test FC',
    rsvp_response: 'yes',
  },
  {
    id: '00000000-0000-0000-0000-000000000061',
    title: 'Match vs Rivals',
    description: Option.none<string>(),
    start_at: DateTime.makeUnsafe('2026-03-20T15:00:00Z'),
    end_at: Option.none<DateTime.Utc>(),
    location: Option.none<string>(),
    location_url: Option.none<string>(),
    status: 'active',
    event_type: 'match',
    team_name: 'Test FC',
    rsvp_response: 'maybe',
  },
  {
    id: '00000000-0000-0000-0000-000000000062',
    title: 'Training with Map Link',
    description: Option.some('Warm-up included'),
    start_at: DateTime.makeUnsafe('2026-03-22T17:00:00Z'),
    end_at: Option.none<DateTime.Utc>(),
    location: Option.some('Stadium'),
    location_url: Option.some('https://maps.google.com/x'),
    status: 'active',
    event_type: 'training',
    team_name: 'Test FC',
    rsvp_response: 'yes',
  },
];

const MockEventsRepositoryLayer = Layer.succeed(EventsRepository, {
  _tag: 'api/EventsRepository',
  findEventsByTeamId: () => Effect.succeed([]),
  findEventByIdWithDetails: () => Effect.succeed(Option.none()),
  insertEvent: () => Effect.succeed({} as never),
  updateEvent: () => Effect.succeed({} as never),
  cancelEvent: () => Effect.void,
  getScopedTrainingTypeIds: () => Effect.succeed([]),
  saveDiscordMessageId: () => Effect.void,
  getDiscordMessageId: () => Effect.succeed(Option.none()),
  findEventsByChannelId: () => Effect.succeed([]),
  markReminderSent: () => Effect.void,
  markEventSeriesModified: () => Effect.void,
  cancelFutureInSeries: () => Effect.void,
  updateFutureUnmodifiedInSeries: () => Effect.void,
  findUpcomingByGuildId: () => Effect.succeed([]),
  countUpcomingByGuildId: () => Effect.succeed(0),
  findEventsByUserId: () => Effect.succeed(testEvents),
} as any);

// --- Minimal mocks for other repos (same pattern as other test files) ---
const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  findByToken: (token: string) =>
    token === 'test-session-token'
      ? Effect.succeed(
          Option.some({
            id: 'sess-1',
            user_id: TEST_USER_ID,
            token: 'test-session-token',
            expires_at: DateTime.add(DateTime.nowUnsafe(), { days: 30 }),
            created_at: DateTime.nowUnsafe(),
          }),
        )
      : Effect.succeed(Option.none()),
  create: () => Effect.succeed({} as never),
  deleteByToken: () => Effect.void,
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: () => Effect.succeed(Option.some(testUser)),
  upsertFromDiscord: () => Effect.succeed(testUser),
  completeProfile: () => Effect.succeed(testUser),
  updateLocale: () => Effect.succeed(testUser),
  updateAdminProfile: () => Effect.succeed(testUser),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  _tag: 'api/TeamMembersRepository',
  findByTeamAndUser: () => Effect.succeed(Option.some(testMembership)),
  findByTeam: () => Effect.succeed([testMembership]),
  findByUser: () => Effect.succeed([testMembership]),
  addMember: () => Effect.succeed({} as never),
  deactivateMember: () => Effect.void,
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  findByTeamDetailed: () => Effect.succeed([]),
  findByIdDetailed: () => Effect.succeed(Option.none()),
  updateMemberProfile: () => Effect.succeed(Option.none()),
  listRosters: () => Effect.succeed([]),
} as any);

// Stub layers for services we don't test here
const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  _tag: 'api/TeamsRepository',
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.succeed({} as never),
} as any);
const MockRostersRepositoryLayer = Layer.succeed(RostersRepository, {
  _tag: 'api/RostersRepository',
} as any);
const MockRolesRepositoryLayer = Layer.succeed(RolesRepository, {
  _tag: 'api/RolesRepository',
} as any);
const MockGroupsRepositoryLayer = Layer.succeed(GroupsRepository, {
  _tag: 'api/GroupsRepository',
} as any);
const MockTrainingTypesRepositoryLayer = Layer.succeed(TrainingTypesRepository, {
  _tag: 'api/TrainingTypesRepository',
} as any);
const MockTeamInvitesRepositoryLayer = Layer.succeed(TeamInvitesRepository, {
  _tag: 'api/TeamInvitesRepository',
} as any);
const MockAgeThresholdRepositoryLayer = Layer.succeed(AgeThresholdRepository, {
  _tag: 'api/AgeThresholdRepository',
} as any);
const MockNotificationsRepositoryLayer = Layer.succeed(NotificationsRepository, {
  _tag: 'api/NotificationsRepository',
} as any);
const MockRoleSyncEventsRepositoryLayer = Layer.succeed(RoleSyncEventsRepository, {
  _tag: 'api/RoleSyncEventsRepository',
} as any);
const MockChannelSyncEventsRepositoryLayer = Layer.succeed(ChannelSyncEventsRepository, {
  _tag: 'api/ChannelSyncEventsRepository',
  hasUnprocessedForGroups: () => Effect.succeed([]),
  hasUnprocessedForRosters: () => Effect.succeed([]),
} as any);
const MockEventSyncEventsRepositoryLayer = Layer.succeed(EventSyncEventsRepository, {
  _tag: 'api/EventSyncEventsRepository',
} as any);
const MockDiscordChannelMappingRepositoryLayer = Layer.succeed(DiscordChannelMappingRepository, {
  _tag: 'api/DiscordChannelMappingRepository',
} as any);
const MockBotGuildsRepositoryLayer = Layer.succeed(BotGuildsRepository, {
  _tag: 'api/BotGuildsRepository',
  findByGuildId: () => Effect.succeed(Option.none()),
} as any);
const MockDiscordChannelsRepositoryLayer = Layer.succeed(DiscordChannelsRepository, {
  _tag: 'api/DiscordChannelsRepository',
} as any);

const MockDiscordRolesRepositoryLayer = Layer.succeed(
  DiscordRolesRepository,
  new Proxy({} as any, { get: () => () => Effect.void }),
);

const MockEventRsvpsRepositoryLayer = Layer.succeed(EventRsvpsRepository, {
  _tag: 'api/EventRsvpsRepository',
} as any);
const MockEventSeriesRepositoryLayer = Layer.succeed(EventSeriesRepository, {
  _tag: 'api/EventSeriesRepository',
} as any);
const MockOAuthConnectionsRepositoryLayer = Layer.succeed(OAuthConnectionsRepository, {
  _tag: 'api/OAuthConnectionsRepository',
} as any);
const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {} as any);
const MockAgeCheckServiceLayer = Layer.succeed(AgeCheckService, {} as any);
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
        } as never),
        Layer.succeed(InviteAcceptancesRepository, {
          _tag: 'api/InviteAcceptancesRepository',
        } as never),
      ),
    ),
  ),
  Layer.provide(Layer.merge(MockHttpClientLayer, MockAgeCheckServiceLayer)),
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
        upsert: () => Effect.succeed({ team_id: 'test', event_horizon_days: 30 }),
        getHorizonDays: () => Effect.succeed(30),
      } as any),
    ),
  ),
  Layer.provide(MockOAuthConnectionsRepositoryLayer),
  Layer.provide(MockAchievementAdminLayers),
).pipe(Layer.provide(MockTranslationsLayers));

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

describe('iCal Subscription API', () => {
  beforeAll(() => {
    storedToken = null;
  });

  it('GET /me/ical-token creates a token when none exists', async () => {
    storedToken = null;
    const response = await handler(
      new Request('http://localhost/me/ical-token', {
        headers: { Authorization: 'Bearer test-session-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBe('generated-ical-token');
    expect(body.url).toContain('webcal://');
    expect(body.url).toContain('/ical/generated-ical-token');
  });

  it('GET /me/ical-token returns existing token', async () => {
    storedToken = {
      id: 'ical-id-existing',
      user_id: TEST_USER_ID,
      token: 'existing-ical-token',
      created_at: new Date(),
    };
    const response = await handler(
      new Request('http://localhost/me/ical-token', {
        headers: { Authorization: 'Bearer test-session-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBe('existing-ical-token');
  });

  it('POST /me/ical-token/regenerate rotates the token', async () => {
    const response = await handler(
      new Request('http://localhost/me/ical-token/regenerate', {
        method: 'POST',
        headers: { Authorization: 'Bearer test-session-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.token).toBe('regenerated-ical-token');
    expect(body.url).toContain('/ical/regenerated-ical-token');
  });

  it('GET /me/ical-token without auth returns 401', async () => {
    const response = await handler(new Request('http://localhost/me/ical-token'));
    expect(response.status).toBe(401);
  });

  it('GET /ical/:token with valid token returns iCalendar feed', async () => {
    storedToken = {
      id: 'ical-id-1',
      user_id: TEST_USER_ID,
      token: 'feed-token',
      created_at: new Date(),
    };
    const response = await handler(new Request('http://localhost/ical/feed-token'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/calendar');
    const text = await response.text();
    expect(text).toContain('BEGIN:VCALENDAR');
    expect(text).toContain('CALNAME:Test FC - Sideline events');
    expect(text).toContain('X-WR-CALNAME:Test FC - Sideline events');
    expect(text).toContain('BEGIN:VEVENT');
    expect(text).toContain('SUMMARY:Tuesday Training');
    expect(text).not.toContain('SUMMARY:[Test FC]');
    expect(text).toContain('DESCRIPTION:Bring your boots');
    expect(text).toContain('LOCATION:Main Field');
    expect(text).toContain('SUMMARY:[Maybe] Match vs Rivals');
    expect(text).toContain('END:VCALENDAR');
    expect(text).toContain('STATUS:CONFIRMED');
  });

  it('GET /ical/:token without auth header works (public endpoint)', async () => {
    storedToken = {
      id: 'ical-id-1',
      user_id: TEST_USER_ID,
      token: 'public-token',
      created_at: new Date(),
    };
    const response = await handler(new Request('http://localhost/ical/public-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain('BEGIN:VCALENDAR');
  });

  it('GET /ical/:token with invalid token returns 404', async () => {
    storedToken = null;
    const response = await handler(new Request('http://localhost/ical/invalid-token'));
    expect(response.status).toBe(404);
  });

  it('GET /ical/:token embeds location_url in DESCRIPTION when present', async () => {
    storedToken = {
      id: 'ical-id-1',
      user_id: TEST_USER_ID,
      token: 'loc-url-token',
      created_at: new Date(),
    };
    const response = await handler(new Request('http://localhost/ical/loc-url-token'));
    expect(response.status).toBe(200);
    const text = await response.text();
    // The event "Training with Map Link" has location_url set.
    // The URL must appear in the DESCRIPTION field (embedded), NOT as a URL: property.
    expect(text).toContain('SUMMARY:Training with Map Link');
    // URL appended to description
    expect(text).toContain('https://maps.google.com/x');
    // Must NOT use a standalone URL: property for location URL (RFC-incorrect for location)
    expect(text).not.toMatch(/^URL:https:\/\/maps\.google\.com\/x/m);
  });
});
