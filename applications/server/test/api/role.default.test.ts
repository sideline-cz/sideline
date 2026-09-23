// TDD — `.work-plans/configurable-default-roles.md`, T-S1.
//
// `PUT /teams/:teamId/default-role` (the new endpoint) and the "ONE resolve expression" contract
// on `listRoles`/`getRole`: the response's `defaultRoleId` / `defaultRoleGrantsManage` /
// `isDefaultForNewMembers` must come from `TeamMembersRepository.getDefaultRoleId` — the SAME
// resolver the three join paths use — never from any row's raw `roles.is_default` column. Cases
// 5/6/7/8 stub every `RolesRepository.findRolesByTeamId` row with `is_default: false` (the
// fallback state every team is in before configuring anything) to prove the response does not
// derive from that column.
//
// A lean "SmallApi" (only `RoleApiGroup`), not the full `ApiLive` + its ~40-layer mock block from
// `role.emit.test.ts` — `setDefaultRole`/`listRoles`/`getRole` touch only
// `TeamMembersRepository` + `RolesRepository`; `NotificationsRepository` is wired only because
// `RoleApiLive`'s top-level `Effect.Do`
// binds them unconditionally (and `syncMemberDiscordRoles` needs the last one) — noop stubs.
//
// EXPECTED TO FAIL against `main`: `RolesRepository.setDefaultRole` does not exist, the
// `setDefaultRole` handler is not wired in `api/role.ts`, and `listRoles`/`getRole` do not yet
// resolve `defaultRoleId`/`defaultRoleGrantsManage`/`isDefaultForNewMembers` at all.

import type { Auth, Role, Team } from '@sideline/domain';
import { RoleApi } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoleApiLive } from '~/api/role.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000099' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as Team.TeamId as never;
const PLAYER_ROLE_ID = '00000000-0000-0000-0000-000000000040' as Role.RoleId;
const GUEST_ROLE_ID = '00000000-0000-0000-0000-000000000041' as Role.RoleId;
const OTHER_TEAM_ROLE_ID = '00000000-0000-0000-0000-000000000098' as Role.RoleId;
const UNKNOWN_ROLE_ID = '00000000-0000-0000-0000-000000000099' as Role.RoleId;

const SmallApi = HttpApi.make('api').add(RoleApi.RoleApiGroup);

// ---------------------------------------------------------------------------
// Mutable mock state
// ---------------------------------------------------------------------------

type RoleRow = {
  readonly id: Role.RoleId;
  readonly team_id: Team.TeamId;
  readonly name: string;
  readonly is_built_in: boolean;
  readonly permission_count: number;
  // Deliberately `false` on every row in every test — see the header. The RESOLVED
  // `defaultRoleId` must never be derived from this column.
  readonly is_default: boolean;
};

let rolesStore: RoleRow[] = [];
let permissionsByRole = new Map<Role.RoleId, ReadonlyArray<Role.Permission>>();
let getDefaultRoleIdResult: Option.Option<{ readonly id: Role.RoleId; readonly name: string }> =
  Option.none();
let membershipPermissions: ReadonlyArray<Role.Permission> = ['role:manage', 'role:view'];

const setDefaultRoleMock = vi.fn((_roleId: Role.RoleId) => Effect.void);
const getPermissionsForRoleIdMock = vi.fn((roleId: Role.RoleId) =>
  Effect.succeed(permissionsByRole.get(roleId) ?? []),
);

const makeTeamMembersRepositoryLayer = () =>
  Layer.succeed(TeamMembersRepository, {
    findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) =>
      teamId === TEST_TEAM_ID && userId === TEST_USER_ID
        ? Effect.succeed(
            Option.some({
              id: TEST_MEMBER_ID,
              team_id: TEST_TEAM_ID,
              user_id: TEST_USER_ID,
              active: true,
              role_names: ['Admin'],
              permissions: membershipPermissions,
            }),
          )
        : Effect.succeed(Option.none()),
    getDefaultRoleId: () => Effect.succeed(getDefaultRoleIdResult),
  } as any);

const makeRolesRepositoryLayer = () =>
  Layer.succeed(RolesRepository, {
    findRolesByTeamId: (teamId: Team.TeamId) =>
      Effect.succeed(rolesStore.filter((r) => r.team_id === teamId)),
    findRoleById: (id: Role.RoleId) => {
      const role = rolesStore.find((r) => r.id === id);
      return Effect.succeed(role ? Option.some(role) : Option.none());
    },
    getPermissionsForRoleId: getPermissionsForRoleIdMock,
    setDefaultRole: setDefaultRoleMock,
  } as any);

// Noop proxies — bound unconditionally by `RoleApiLive`'s top-level `Effect.Do` / needed only by
// `syncMemberDiscordRoles`, which no test here calls.
const noopMockLayer = <T>(tag: T) =>
  Layer.succeed(
    tag as any,
    new Proxy(
      {},
      {
        get: () => () => Effect.void,
      },
    ),
  );

const sessionsStore = new Map<string, Auth.UserId>();
sessionsStore.set('admin-token', TEST_USER_ID);

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
  findByToken: (token: string) => {
    const userId = sessionsStore.get(token);
    return Effect.succeed(
      userId ? Option.some({ id: 'session-1', user_id: userId }) : Option.none(),
    );
  },
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
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
            discord_nickname: Option.none(),
            is_global_admin: false,
          })
        : Option.none(),
    ),
  findByDiscordId: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
} as any);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(RoleApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(MockUsersRepositoryLayer),
  Layer.provide(makeTeamMembersRepositoryLayer()),
  Layer.provide(makeRolesRepositoryLayer()),
  Layer.provide(noopMockLayer(NotificationsRepository)),
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
  rolesStore = [
    {
      id: PLAYER_ROLE_ID,
      team_id: TEST_TEAM_ID,
      name: 'Player',
      is_built_in: true,
      permission_count: 2,
      is_default: false,
    },
    {
      id: GUEST_ROLE_ID,
      team_id: TEST_TEAM_ID,
      name: 'Guest',
      is_built_in: false,
      permission_count: 0,
      is_default: false,
    },
    {
      id: OTHER_TEAM_ROLE_ID,
      team_id: OTHER_TEAM_ID,
      name: 'Foreign',
      is_built_in: false,
      permission_count: 0,
      is_default: false,
    },
  ];
  permissionsByRole = new Map([
    [PLAYER_ROLE_ID, ['roster:view', 'member:view']],
    [GUEST_ROLE_ID, []],
  ]);
  getDefaultRoleIdResult = Option.some({ id: PLAYER_ROLE_ID, name: 'Player' });
  membershipPermissions = ['role:manage', 'role:view'];
  setDefaultRoleMock.mockClear();
  setDefaultRoleMock.mockImplementation((_roleId: Role.RoleId) => Effect.void);
  getPermissionsForRoleIdMock.mockClear();
});

const authHeaders = { Authorization: 'Bearer admin-token' };

const putDefaultRole = (teamId: Team.TeamId, roleId: Role.RoleId) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/default-role`, {
      method: 'PUT',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ roleId }),
    }),
  );

const getRoles = (teamId: Team.TeamId) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/roles`, {
      method: 'GET',
      headers: authHeaders,
    }),
  );

const getRole = (teamId: Team.TeamId, roleId: Role.RoleId) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/roles/${roleId}`, {
      method: 'GET',
      headers: authHeaders,
    }),
  );

describe('PUT /teams/:teamId/default-role', () => {
  it('1. a valid roleId calls setDefaultRole(<id>) and returns 204', async () => {
    const response = await putDefaultRole(TEST_TEAM_ID, GUEST_ROLE_ID);

    expect(response.status).toBe(204);
    expect(setDefaultRoleMock).toHaveBeenCalledWith(GUEST_ROLE_ID);
  });

  it('2. unknown roleId → 404 RoleNotFound, setDefaultRole NOT called', async () => {
    const response = await putDefaultRole(TEST_TEAM_ID, UNKNOWN_ROLE_ID);
    // Read as text first: a 404 from `RouteNotFound` (the endpoint not wired at all) carries no
    // JSON body, and `.json()` on it throws a `SyntaxError` that masks the real assertion below
    // with a parse error instead of a clean mismatch.
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ _tag: 'RoleNotFound' });
    expect(setDefaultRoleMock).not.toHaveBeenCalled();
  });

  it('3. a roleId belonging to ANOTHER team → 404 RoleNotFound, setDefaultRole NOT called (BLOCKER 2)', async () => {
    const response = await putDefaultRole(TEST_TEAM_ID, OTHER_TEAM_ROLE_ID);
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};

    expect(response.status).toBe(404);
    expect(body).toMatchObject({ _tag: 'RoleNotFound' });
    expect(setDefaultRoleMock).not.toHaveBeenCalled();
  });

  it('4. role:view only → 403, setDefaultRole NOT called', async () => {
    membershipPermissions = ['role:view'];

    const response = await putDefaultRole(TEST_TEAM_ID, GUEST_ROLE_ID);

    expect(response.status).toBe(403);
    expect(setDefaultRoleMock).not.toHaveBeenCalled();
  });
});

describe('listRoles / getRole — the resolved-value contract (C1)', () => {
  it('5. listRoles reports defaultRoleId from getDefaultRoleId, NOT from any row is_default', async () => {
    // Every row in `rolesStore` carries `is_default: false` (set in beforeEach) — the fallback
    // state Poletime is in before configuring anything. The resolver still names Player.
    getDefaultRoleIdResult = Option.some({ id: PLAYER_ROLE_ID, name: 'Player' });

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultRoleId: string | null };
    expect(body.defaultRoleId).toBe(PLAYER_ROLE_ID);
  });

  it('6a. defaultRoleGrantsManage is true when the RESOLVED default holds team:manage', async () => {
    getDefaultRoleIdResult = Option.some({ id: GUEST_ROLE_ID, name: 'Guest' });
    permissionsByRole.set(GUEST_ROLE_ID, ['team:manage']);

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultRoleGrantsManage: boolean };
    expect(body.defaultRoleGrantsManage).toBe(true);
    expect(getPermissionsForRoleIdMock).toHaveBeenCalledWith(GUEST_ROLE_ID);
    expect(getPermissionsForRoleIdMock).not.toHaveBeenCalledWith(PLAYER_ROLE_ID);
  });

  it('6b. defaultRoleGrantsManage is false when the RESOLVED default does not hold team:manage', async () => {
    getDefaultRoleIdResult = Option.some({ id: GUEST_ROLE_ID, name: 'Guest' });
    permissionsByRole.set(GUEST_ROLE_ID, ['roster:view']);
    // A DIFFERENT role carries team:manage — must not leak into the answer.
    permissionsByRole.set(PLAYER_ROLE_ID, ['team:manage']);

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultRoleGrantsManage: boolean };
    expect(body.defaultRoleGrantsManage).toBe(false);
    expect(getPermissionsForRoleIdMock).toHaveBeenCalledWith(GUEST_ROLE_ID);
  });

  // F1 (review): the warning must fire for `role:manage` too — a holder of that permission can
  // immediately self-grant `team:manage` via `setRolePermissions`, so it is equivalent escalation.
  it('6c. defaultRoleGrantsManage is true when the RESOLVED default holds role:manage', async () => {
    getDefaultRoleIdResult = Option.some({ id: GUEST_ROLE_ID, name: 'Guest' });
    permissionsByRole.set(GUEST_ROLE_ID, ['role:manage']);

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultRoleGrantsManage: boolean };
    expect(body.defaultRoleGrantsManage).toBe(true);
  });

  // F1 (review): `member:remove` lets a joiner strip every other admin/captain from the roster —
  // equally worth warning about.
  it('6d. defaultRoleGrantsManage is true when the RESOLVED default holds member:remove', async () => {
    getDefaultRoleIdResult = Option.some({ id: GUEST_ROLE_ID, name: 'Guest' });
    permissionsByRole.set(GUEST_ROLE_ID, ['member:remove']);

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as { defaultRoleGrantsManage: boolean };
    expect(body.defaultRoleGrantsManage).toBe(true);
  });

  it('7. getRole reports isDefaultForNewMembers true for the resolved role, false for a sibling', async () => {
    getDefaultRoleIdResult = Option.some({ id: GUEST_ROLE_ID, name: 'Guest' });

    const defaultResponse = await getRole(TEST_TEAM_ID, GUEST_ROLE_ID);
    const siblingResponse = await getRole(TEST_TEAM_ID, PLAYER_ROLE_ID);

    expect(defaultResponse.status).toBe(200);
    expect(siblingResponse.status).toBe(200);
    const defaultBody = (await defaultResponse.json()) as { isDefaultForNewMembers: boolean };
    const siblingBody = (await siblingResponse.json()) as { isDefaultForNewMembers: boolean };
    expect(defaultBody.isDefaultForNewMembers).toBe(true);
    expect(siblingBody.isDefaultForNewMembers).toBe(false);
  });

  it('8. listRoles with getDefaultRoleId → None reports defaultRoleId: null, defaultRoleGrantsManage: false, and never calls getPermissionsForRoleId', async () => {
    getDefaultRoleIdResult = Option.none();

    const response = await getRoles(TEST_TEAM_ID);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      defaultRoleId: string | null;
      defaultRoleGrantsManage: boolean;
    };
    expect(body.defaultRoleId).toBeNull();
    expect(body.defaultRoleGrantsManage).toBe(false);
    expect(getPermissionsForRoleIdMock).not.toHaveBeenCalled();
  });
});
