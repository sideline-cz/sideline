// Slice 1 ("Setup memberships") — the membership-plan HTTP routes (`api/membership-plan.ts`),
// backed by real repositories over a real Postgres instance. Pattern:
// `groupAssignRoleCrossTeam.test.ts` — a `SmallApi` built from just the one group under test,
// a mocked `SessionsRepository` for auth, and every other repository real.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { MembershipPlanApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { MembershipPlanApiLive } from '~/api/membership-plan.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(MembershipPlanApi.MembershipPlanApiGroup);

let sessionsStore: Map<string, User.UserId>;

const MockSessionsRepositoryLayer = Layer.succeed(SessionsRepository, {
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
  create: () => Effect.die(new Error('Not implemented')),
  deleteByToken: () => Effect.void,
} as any);

const RealRepos = Layer.mergeAll(
  UsersRepository.Default,
  TeamsRepository.Default,
  TeamMembersRepository.Default,
  RolesRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(MembershipPlanApiLive),
  Layer.provideMerge(AuthMiddlewareLive),
  Layer.provideMerge(HttpServer.layerServices),
  Layer.provide(MockSessionsRepositoryLayer),
  Layer.provide(RealRepos),
  Layer.provideMerge(TestPgClient),
);

const SeedLayer = RealRepos.pipe(Layer.provideMerge(TestPgClient));

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

beforeEach(async () => {
  await cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise);
  sessionsStore = new Map();
});

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

let discordIdCounter = 850_000_000_000_000_000n;
const nextDiscordId = (): Discord.Snowflake => (discordIdCounter++).toString() as Discord.Snowflake;

const createUser = (username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: nextDiscordId(),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (createdBy: User.UserId, name: string) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name,
        guild_id: nextDiscordId(),
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
    Effect.map((tm) => tm.id),
  );

const createRoleWithPermissions = (
  teamId: Team.TeamId,
  name: string,
  permissions: ReadonlyArray<Role.Permission>,
) =>
  RolesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertRole(teamId, name).pipe(
        Effect.tap((role) => repo.setRolePermissions(role.id, permissions)),
        Effect.map((role) => role.id),
      ),
    ),
  );

const assignRoleDirect = (memberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignRole(memberId, roleId)),
  );

// `R` is carried through so callers can pass an effect that still needs a repository —
// `Effect.provide(SeedLayer)` discharges it, and anything SeedLayer does not cover stays a
// type error at `runPromise` rather than being cast away at the call site.
const runSeeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SeedLayer)) as Effect.Effect<A, E, never>);

/** A fresh team (auto-seeded by the DB trigger with its one default plan), plus a member whose
 * own role carries exactly `withPermissions`. */
const seedFixture = (withPermissions: ReadonlyArray<Role.Permission> = []) =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('actorUserId', () => createUser('mp-actor')),
      Effect.bind('team', ({ actorUserId }) => createTeam(actorUserId, 'MP Team')),
      Effect.bind('actorMemberId', ({ team, actorUserId }) => addTeamMember(team.id, actorUserId)),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Actor role', withPermissions),
      ),
      Effect.tap(({ actorMemberId, roleId }) => assignRoleDirect(actorMemberId, roleId)),
    ),
  );

const getPlanRows = (teamId: Team.TeamId) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) => sql<{
          id: string;
          is_default: boolean;
          archived_at: Date | null;
          name: string | null;
        }>`
          SELECT id, is_default, archived_at, name FROM membership_plans
          WHERE team_id = ${teamId} ORDER BY created_at ASC
        `,
      ),
    ),
  );

const basicPayload = {
  name: 'Adult membership',
  priceMinor: 50000,
  currency: 'CZK',
  pricePerTrainingMinor: 0,
  expiresAt: null,
};

const asJson = async (response: Response) => response.json();

// ---------------------------------------------------------------------------
// 1-3. Read access — membership-gated, canManage reflects finance:manage_fees
// ---------------------------------------------------------------------------

describe('GET /teams/:teamId/membership-plans', () => {
  it('a member WITHOUT finance:manage_fees gets 200, canManage false, and sees the plans', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await asJson(response);
    expect(body.canManage).toBe(false);
    expect(body.plans).toHaveLength(1);
  });

  it('a non-member gets 403 MembershipPlanForbidden', async () => {
    const fixture = await seedFixture([]);
    const outsiderUserId = await runSeeded(createUser('mp-outsider'));
    sessionsStore.set('outsider-token', outsiderUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        headers: { Authorization: 'Bearer outsider-token' },
      }),
    );

    expect(response.status).toBe(403);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanForbidden');
  });

  it('a member WITH finance:manage_fees gets canManage true', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );

    expect(response.status).toBe(200);
    const body = await asJson(response);
    expect(body.canManage).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Every mutating route requires finance:manage_fees
// ---------------------------------------------------------------------------

describe('membership-plan mutations — require finance:manage_fees', () => {
  it('create WITHOUT finance:manage_fees -> 403, no row written', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    );

    expect(response.status).toBe(403);
    const rows = await getPlanRows(fixture.team.id);
    expect(rows).toHaveLength(1); // still just the seeded default
  });

  it('update WITHOUT finance:manage_fees -> 403, no row changed', async () => {
    const fixture = await seedFixture([]);
    const [seeded] = await getPlanRows(fixture.team.id);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans/${seeded?.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    );

    expect(response.status).toBe(403);
    const [after] = await getPlanRows(fixture.team.id);
    expect(after?.name).toBeNull(); // untouched — still the seeded NULL name
  });

  it('setDefault WITHOUT finance:manage_fees -> 403', async () => {
    const fixture = await seedFixture([]);
    const [seeded] = await getPlanRows(fixture.team.id);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${seeded?.id}/default`,
        { method: 'PUT', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );

    expect(response.status).toBe(403);
  });

  it('delete WITHOUT finance:manage_fees -> 403, plan not archived', async () => {
    const fixture = await seedFixture([]);
    const [seeded] = await getPlanRows(fixture.team.id);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans/${seeded?.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );

    expect(response.status).toBe(403);
    const [after] = await getPlanRows(fixture.team.id);
    expect(after?.archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. Create with finance:manage_fees — round-trips values, isDefault false
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/membership-plans', () => {
  it('creates a plan: 201, isDefault false, values round-trip (expiresAt None)', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    );

    expect(response.status).toBe(201);
    const body = await asJson(response);
    expect(body.isDefault).toBe(false);
    expect(body.name).toBe('Adult membership');
    expect(body.priceMinor).toBe(50000);
    expect(body.currency).toBe('CZK');
    expect(body.pricePerTrainingMinor).toBe(0);
    expect(body.expiresAt).toBeNull();
  });

  it('round-trips an expiresAt Some value', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const expiresAt = '2099-06-15T12:00:00.000Z';

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicPayload, expiresAt }),
      }),
    );

    expect(response.status).toBe(201);
    const body = await asJson(response);
    expect(body.expiresAt).toBe(expiresAt);
  });
});

// ---------------------------------------------------------------------------
// 6. Update is a full replace
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/membership-plans/:membershipPlanId — full replace', () => {
  it('changing only the name preserves currency when the caller resends it', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicPayload, currency: 'EUR' }),
      }),
    ).then(asJson);

    const updateResponse = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basicPayload, name: 'Renamed', currency: 'EUR' }),
        },
      ),
    );

    expect(updateResponse.status).toBe(200);
    const updated = await asJson(updateResponse);
    expect(updated.name).toBe('Renamed');
    expect(updated.currency).toBe('EUR');
  });

  it('an expiresAt Some -> None in the payload actually clears the column', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicPayload, expiresAt: '2099-06-15T12:00:00.000Z' }),
      }),
    ).then(asJson);
    expect(created.expiresAt).not.toBeNull();

    const updateResponse = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basicPayload, expiresAt: null }),
        },
      ),
    );

    expect(updateResponse.status).toBe(200);
    const updated = await asJson(updateResponse);
    expect(updated.expiresAt).toBeNull();
  });

  // Regression test for the blocker: editing the seeded default plan's price without setting a
  // name must NOT freeze a translated label (or anything else) into the NULL name column — the
  // whole reason the seeded default plan reads correctly in every viewer's locale.
  it('editing the seeded default plan with name: null leaves the name column NULL', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    const [seeded] = await getPlanRows(fixture.team.id);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const updateResponse = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans/${seeded?.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicPayload, name: null, priceMinor: 12300 }),
      }),
    );

    expect(updateResponse.status).toBe(200);
    const updated = await asJson(updateResponse);
    expect(updated.name).toBeNull();
    expect(updated.priceMinor).toBe(12300);

    const [after] = await getPlanRows(fixture.team.id);
    expect(after?.name).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 7. Cross-team plan id -> 404, never a leak
// ---------------------------------------------------------------------------

describe('membership-plan routes — cross-team plan id is 404, not a leak', () => {
  it("update with ANOTHER team's plan id -> 404 MembershipPlanNotFound", async () => {
    const fixtureA = await seedFixture(['finance:manage_fees']);
    const fixtureB = await seedFixture(['finance:manage_fees']);
    const [planB] = await getPlanRows(fixtureB.team.id);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixtureA.team.id}/membership-plans/${planB?.id}`, {
        method: 'PATCH',
        headers: { Authorization: 'Bearer actor-a-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    );

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
  });

  it("delete with ANOTHER team's plan id -> 404 MembershipPlanNotFound", async () => {
    const fixtureA = await seedFixture(['finance:manage_fees']);
    const fixtureB = await seedFixture(['finance:manage_fees']);
    const [planB] = await getPlanRows(fixtureB.team.id);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);

    const response = await handler(
      new Request(`http://localhost/teams/${fixtureA.team.id}/membership-plans/${planB?.id}`, {
        method: 'DELETE',
        headers: { Authorization: 'Bearer actor-a-token' },
      }),
    );

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
  });

  // Regression test for FIX 3: `setDefaultMembershipPlan` used to be the only unscoped
  // repository method, with tenancy enforced ONLY by a pre-check in the handler. Team A's
  // captain promoting team B's plan id must 404, and team B's own default must be untouched.
  it("setDefault with ANOTHER team's plan id -> 404 MembershipPlanNotFound, team B's default unchanged", async () => {
    const fixtureA = await seedFixture(['finance:manage_fees']);
    const fixtureB = await seedFixture(['finance:manage_fees']);
    const [planB] = await getPlanRows(fixtureB.team.id);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixtureA.team.id}/membership-plans/${planB?.id}/default`,
        { method: 'PUT', headers: { Authorization: 'Bearer actor-a-token' } },
      ),
    );

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');

    const [afterB] = await getPlanRows(fixtureB.team.id);
    expect(afterB?.id).toBe(planB?.id);
    expect(afterB?.is_default).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Delete the default plan is refused, and the refusal never half-applies
// ---------------------------------------------------------------------------

describe('DELETE /teams/:teamId/membership-plans/:membershipPlanId — the default plan', () => {
  it('refuses to delete the default plan: 409 MembershipPlanIsDefault, archived_at stays NULL', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    const [seededDefault] = await getPlanRows(fixture.team.id);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${seededDefault?.id}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );

    expect(response.status).toBe(409);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanIsDefault');

    const [after] = await getPlanRows(fixture.team.id);
    expect(after?.archived_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Delete a non-default plan archives it and it disappears from the list
// ---------------------------------------------------------------------------

describe('DELETE /teams/:teamId/membership-plans/:membershipPlanId — a non-default plan', () => {
  it('archives the plan: 204, archived_at set, and it is gone from the list response', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    ).then(asJson);

    const deleteResponse = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );

    expect(deleteResponse.status).toBe(204);

    const [, archived] = await getPlanRows(fixture.team.id);
    expect(archived?.archived_at).not.toBeNull();

    const listResponse = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );
    const listBody = await asJson(listResponse);
    expect(
      listBody.plans.some(
        (p: { membershipPlanId: string }) => p.membershipPlanId === created.membershipPlanId,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 10. PUT .../default happy path — the only case that was previously untested
// ---------------------------------------------------------------------------

describe('PUT /teams/:teamId/membership-plans/:membershipPlanId/default', () => {
  it('promotes a second plan to default: 204, and the list response reflects the move', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    ).then(asJson);

    const response = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}/default`,
        { method: 'PUT', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );

    expect(response.status).toBe(204);

    const listResponse = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        headers: { Authorization: 'Bearer actor-token' },
      }),
    );
    const listBody = await asJson(listResponse);
    const promoted = listBody.plans.find(
      (p: { membershipPlanId: string }) => p.membershipPlanId === created.membershipPlanId,
    );
    const previousDefault = listBody.plans.find(
      (p: { membershipPlanId: string }) => p.membershipPlanId !== created.membershipPlanId,
    );
    expect(promoted.isDefault).toBe(true);
    expect(previousDefault.isDefault).toBe(false);
  });
});
