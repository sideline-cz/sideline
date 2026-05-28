// Tests for DashboardLayoutApiLive handler.
// Uses an in-memory mock for DashboardLayoutsRepository.

import type { Auth, DashboardLayoutApi, Role, Team, TeamMember } from '@sideline/domain';
import { OAuth2Tokens } from 'arctic';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpClient, HttpClientResponse, HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DashboardLayoutApiLive } from '~/api/dashboard-layout.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { DashboardLayoutsRepository } from '~/repositories/DashboardLayoutsRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { DiscordOAuth } from '~/services/DiscordOAuth.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_MEMBER_USER_ID = '00000000-0000-0000-0005-000000000001' as Auth.UserId;
const TEST_OUTSIDER_USER_ID = '00000000-0000-0000-0005-000000000099' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0005-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0005-000000000020' as Team.TeamId;
const TEST_MEMBER_MEMBER_ID = '00000000-0000-0000-0005-000000000011' as TeamMember.TeamMemberId;

const MEMBER_PERMISSIONS: readonly Role.Permission[] = ['member:view'];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

const now = DateTime.nowUnsafe();

type StoredWidget = { id: string; visible: boolean; height: number };

let layoutStore: Map<string, ReadonlyArray<StoredWidget>>;

const resetStores = () => {
  layoutStore = new Map();
};

const layoutKey = (userId: Auth.UserId, teamId: Team.TeamId) => `${userId}:${teamId}`;

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const sessionsStore = new Map<string, Auth.UserId>([
  ['member-token', TEST_MEMBER_USER_ID],
  ['outsider-token', TEST_OUTSIDER_USER_ID],
]);

const usersMap = new Map<Auth.UserId, any>([
  [
    TEST_MEMBER_USER_ID,
    {
      id: TEST_MEMBER_USER_ID,
      discord_id: '111111111111111111',
      username: 'member',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
  [
    TEST_OUTSIDER_USER_ID,
    {
      id: TEST_OUTSIDER_USER_ID,
      discord_id: '999999999999999999',
      username: 'outsider',
      avatar: Option.none(),
      is_profile_complete: true,
      name: Option.none(),
      birth_date: Option.none(),
      gender: Option.none(),
      locale: 'en',
      discord_display_name: Option.none(),
      created_at: now,
      updated_at: now,
    },
  ],
]);

const membersStore = new Map<string, MembershipWithRole>([
  [
    `${TEST_TEAM_ID}:${TEST_MEMBER_USER_ID}`,
    {
      id: TEST_MEMBER_MEMBER_ID,
      team_id: TEST_TEAM_ID,
      user_id: TEST_MEMBER_USER_ID,
      active: true,
      role_names: ['Player'],
      permissions: MEMBER_PERMISSIONS as any,
    } as MembershipWithRole,
  ],
]);

const testTeam = {
  id: TEST_TEAM_ID,
  name: 'Dashboard Layout Test Team',
  guild_id: '555555555555555555',
  created_by: TEST_MEMBER_USER_ID,
  created_at: now,
  updated_at: now,
};

const MockDiscordOAuthLayer = Layer.succeed(DiscordOAuth, {
  _tag: 'api/DiscordOAuth',
  createAuthorizationURL: () =>
    Effect.succeed(new URL('https://discord.com/oauth2/authorize?client_id=test')),
  validateAuthorizationCode: () =>
    Effect.succeed(new OAuth2Tokens({ access_token: 'mock', refresh_token: 'mock' })),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  _tag: 'api/UsersRepository',
  findById: (id: Auth.UserId) =>
    Effect.succeed(usersMap.has(id) ? Option.some(usersMap.get(id)!) : Option.none()),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  _tag: 'api/SessionsRepository',
  create: () => Effect.die(new Error('Not implemented')),
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    if (!userId) return Effect.succeed(Option.none());
    return Effect.succeed(
      Option.some({ id: 'session-1', user_id: userId, token, expires_at: now, created_at: now }),
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
  findById: () => Effect.succeed(Option.none()),
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    const member = membersStore.get(`${teamId}:${userId}`);
    return Effect.succeed(member ? Option.some(member) : Option.none());
  },
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

const MockDashboardLayoutsRepositoryLayer = Layer.succeed(DashboardLayoutsRepository, {
  _tag: 'api/DashboardLayoutsRepository',
  findByUserTeam: (userId: Auth.UserId, teamId: Team.TeamId) => {
    const stored = layoutStore.get(layoutKey(userId, teamId));
    if (!stored) return Effect.succeed(Option.none());
    return Effect.succeed(Option.some({ widgets: stored as any }));
  },
  upsert: (
    userId: Auth.UserId,
    teamId: Team.TeamId,
    widgets: ReadonlyArray<DashboardLayoutApi.DashboardWidget>,
  ) => {
    const serialized: StoredWidget[] = widgets.map((w) => ({
      id: w.id,
      visible: w.visible,
      height: w.height,
    }));
    layoutStore.set(layoutKey(userId, teamId), serialized);
    return Effect.succeed({ widgets: serialized as any });
  },
} as any);

const MockHttpClientLayer = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify({}), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  ),
);

// ---------------------------------------------------------------------------
// Build a minimal API that only contains the DashboardLayout group
// ---------------------------------------------------------------------------

import { DashboardLayoutApi as DomainDashboardLayoutApi } from '@sideline/domain';
import { HttpApi } from 'effect/unstable/httpapi';

const TestApi = HttpApi.make('test-api').add(DomainDashboardLayoutApi.DashboardLayoutApiGroup);

const TestLayer = HttpApiBuilder.layer(TestApi).pipe(
  Layer.provide(DashboardLayoutApiLive),
  Layer.provide(AuthMiddlewareLive),
  Layer.provide(HttpServer.layerServices),
  Layer.provide(MockDiscordOAuthLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockTeamsRepositoryLayer),
  Layer.provide(MockTeamMembersRepositoryLayer),
  Layer.provide(MockDashboardLayoutsRepositoryLayer),
  Layer.provide(MockHttpClientLayer),
);

// ---------------------------------------------------------------------------
// Handler setup
// ---------------------------------------------------------------------------

let handler: (...args: any) => Promise<Response>;
let dispose: () => Promise<void>;

beforeAll(() => {
  const app = HttpRouter.toWebHandler(
    TestLayer as unknown as Parameters<typeof HttpRouter.toWebHandler>[0],
  );
  handler = app.handler;
  dispose = app.dispose;
});

afterAll(async () => {
  await dispose();
});

beforeEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

const getLayoutUrl = (teamId: string = TEST_TEAM_ID) =>
  `http://localhost/teams/${teamId}/dashboard-layout`;

const putLayoutUrl = (teamId: string = TEST_TEAM_ID) =>
  `http://localhost/teams/${teamId}/dashboard-layout`;

// ---------------------------------------------------------------------------
// getDashboardLayout
// ---------------------------------------------------------------------------

describe('DashboardLayout API — getDashboardLayout', () => {
  it('GET → 200 with DEFAULT 4 widgets all visible when no stored row', async () => {
    const response = await handler(
      new Request(getLayoutUrl(), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.widgets)).toBe(true);
    expect(body.widgets).toHaveLength(4);
    for (const widget of body.widgets) {
      expect(widget.visible).toBe(true);
    }
    // Canonical order
    expect(body.widgets[0].id).toBe('stats');
    expect(body.widgets[1].id).toBe('upcomingEvents');
    expect(body.widgets[2].id).toBe('activity');
    expect(body.widgets[3].id).toBe('teamManagement');
    // Height field present
    expect(typeof body.widgets[0].height).toBe('number');
    expect(body.widgets[0].height).toBe(140);
    expect(body.widgets[1].height).toBe(280);
    expect(body.widgets[2].height).toBe(200);
    expect(body.widgets[3].height).toBe(260);
  });

  it('GET → 200 with normalized result when stored partial/legacy row exists', async () => {
    // Pre-seed a partial layout (only 1 widget stored, with height)
    layoutStore.set(layoutKey(TEST_MEMBER_USER_ID, TEST_TEAM_ID), [
      { id: 'teamManagement', visible: false, height: 260 },
    ]);

    const response = await handler(
      new Request(getLayoutUrl(), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // normalizeWidgets should fill in the missing 3 widgets
    expect(body.widgets).toHaveLength(4);
    // The stored widget comes first
    expect(body.widgets[0].id).toBe('teamManagement');
    expect(body.widgets[0].visible).toBe(false);
    // Height field must be present
    expect(typeof body.widgets[0].height).toBe('number');
  });

  it('GET → 403 DashboardLayoutForbidden for non-member of team', async () => {
    const response = await handler(
      new Request(getLayoutUrl(TEST_OTHER_TEAM_ID), {
        headers: { Authorization: 'Bearer member-token' },
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/DashboardLayoutForbidden/i);
  });

  it('GET → 401 when no auth token provided', async () => {
    const response = await handler(new Request(getLayoutUrl()));
    expect(response.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// updateDashboardLayout
// ---------------------------------------------------------------------------

describe('DashboardLayout API — updateDashboardLayout', () => {
  it('PUT → 200 persists & returns normalized widgets with height fields', async () => {
    const payload = {
      widgets: [
        { id: 'activity', visible: false, height: 200 },
        { id: 'stats', visible: true, height: 140 },
        { id: 'upcomingEvents', visible: true, height: 280 },
        { id: 'teamManagement', visible: true, height: 260 },
      ],
    };

    const response = await handler(
      new Request(putLayoutUrl(), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Array.isArray(body.widgets)).toBe(true);
    // Should contain all 4 widgets
    expect(body.widgets).toHaveLength(4);
    // Height fields present
    for (const w of body.widgets) {
      expect(typeof w.height).toBe('number');
    }
    // Persisted — verify store was written
    const stored = layoutStore.get(layoutKey(TEST_MEMBER_USER_ID, TEST_TEAM_ID));
    expect(stored).toBeDefined();
  });

  it('PUT → 200 normalizes partial payload (fills in missing widgets)', async () => {
    const payload = {
      widgets: [{ id: 'stats', visible: false, height: 140 }],
    };

    const response = await handler(
      new Request(putLayoutUrl(), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    // normalizeWidgets fills in missing widgets
    expect(body.widgets).toHaveLength(4);
    const statsWidget = body.widgets.find((w: any) => w.id === 'stats');
    expect(statsWidget).toBeDefined();
    expect(statsWidget.visible).toBe(false);
  });

  it('PUT persists custom height values', async () => {
    const payload = {
      widgets: [
        { id: 'stats', visible: true, height: 350 },
        { id: 'upcomingEvents', visible: true, height: 500 },
        { id: 'activity', visible: true, height: 200 },
        { id: 'teamManagement', visible: true, height: 260 },
      ],
    };

    const response = await handler(
      new Request(putLayoutUrl(), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const statsWidget = body.widgets.find((w: any) => w.id === 'stats');
    expect(statsWidget?.height).toBe(350);
    const upcomingWidget = body.widgets.find((w: any) => w.id === 'upcomingEvents');
    expect(upcomingWidget?.height).toBe(500);
  });

  it('PUT → 403 DashboardLayoutForbidden for non-member of team', async () => {
    const payload = {
      widgets: [
        { id: 'stats', visible: true, height: 140 },
        { id: 'upcomingEvents', visible: true, height: 280 },
        { id: 'activity', visible: true, height: 200 },
        { id: 'teamManagement', visible: true, height: 260 },
      ],
    };

    const response = await handler(
      new Request(putLayoutUrl(TEST_OTHER_TEAM_ID), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(JSON.stringify(body)).toMatch(/DashboardLayoutForbidden/i);
  });

  it('PUT → 401 when no auth token provided', async () => {
    const payload = {
      widgets: [{ id: 'stats', visible: true, height: 140 }],
    };

    const response = await handler(
      new Request(putLayoutUrl(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
    );
    expect(response.status).toBe(401);
  });

  it('PUT → 400 when payload contains an invalid widget id', async () => {
    const payload = {
      widgets: [{ id: 'awaitingRsvp', visible: true, height: 200 }],
    };

    const response = await handler(
      new Request(putLayoutUrl(), {
        method: 'PUT',
        headers: {
          Authorization: 'Bearer member-token',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      }),
    );
    // Schema validation should reject 'awaitingRsvp' → 400 ParseError
    expect(response.status).toBe(400);
  });
});
