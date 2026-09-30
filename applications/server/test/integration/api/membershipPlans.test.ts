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

/** The allowance columns, which `getPlanRows` deliberately does not carry — `free_trainings_anchor_at`
 * is only ever asserted by the re-stamp cases below. */
const getPlanAllowance = (planId: string) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) => sql<{ free_trainings_included: number; free_trainings_anchor_at: Date }>`
          SELECT free_trainings_included, free_trainings_anchor_at
          FROM membership_plans WHERE id = ${planId}
        `,
      ),
      Effect.map((rows) => rows[0]),
    ),
  );

// `freeTrainingsIncluded` is an OPTIONAL KEY on the request schema (`applications/server/AGENTS.md`
// rule 5): web deploys LAST, so old bundles omit it for the whole rollout and a required field
// would 400 every one of their saves. Absent means KEEP THE STORED VALUE on an update (0 on a
// create) -- see the two cases in section 6 below. It is spelled out here because every other case
// in this file wants a known, explicit value.
const basicPayload = {
  name: 'Adult membership',
  priceMinor: 50000,
  currency: 'CZK',
  pricePerTrainingMinor: 0,
  freeTrainingsIncluded: 0,
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

  // The INSERT half of rule 5's optional key: there is no stored value to keep on a create, so
  // `COALESCE(<param>::int, 0)` in `insertQuery` is what an absent key must land on. NOT NULL on
  // the column means a regression here is a 500, not a silent 0 — but the assertion pins the
  // VALUE, which is the part an `EXCLUDED`-style mistake would get wrong.
  it('a create that OMITS freeTrainingsIncluded stores 0', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const { freeTrainingsIncluded: _omitted, ...withoutAllowance } = basicPayload;

    const response = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(withoutAllowance),
      }),
    );

    expect(response.status).toBe(201);
    const body = await asJson(response);
    expect(body.freeTrainingsIncluded).toBe(0);
    expect((await getPlanAllowance(body.membershipPlanId))?.free_trainings_included).toBe(0);
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

  // THE POINT OF RULE 5 (`applications/server/AGENTS.md` → Wire-value projection & effective-value
  // guards). Web deploys LAST, so for the whole rollout window a new server is serving old bundles
  // that do not know `freeTrainingsIncluded` and omit it from this FULL-ROW overwrite. Two ways to
  // get this wrong, both of which this case fails on:
  //   - a plain required field  -> 400 on every save from those bundles;
  //   - `withDecodingDefaultKey(() => 0)` (or COALESCEing `EXCLUDED`) -> the allowance is silently
  //     zeroed, and the manager's correction then re-stamps a FRESH anchor, handing out the
  //     allowance a second time.
  // Hence the anchor assertion alongside the value one: `free_trainings_anchor_at` must not move.
  it('an update that OMITS freeTrainingsIncluded keeps the stored allowance and the anchor', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    ).then(asJson);
    const atCreate = await getPlanAllowance(created.membershipPlanId);

    // 0 -> 2 is the one transition that re-stamps the anchor. Doing it here is what makes the
    // assertion below meaningful: an unmoved anchor only proves something once it HAS moved.
    const raised = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basicPayload, freeTrainingsIncluded: 2 }),
        },
      ),
    ).then(asJson);
    expect(raised.freeTrainingsIncluded).toBe(2);
    const afterRaise = await getPlanAllowance(created.membershipPlanId);
    expect(afterRaise?.free_trainings_anchor_at.getTime()).toBeGreaterThan(
      atCreate?.free_trainings_anchor_at.getTime() ?? 0,
    );

    // The old bundle's save: every key it knows, nothing it does not.
    const { freeTrainingsIncluded: _omitted, ...withoutAllowance } = basicPayload;
    const updateResponse = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...withoutAllowance, priceMinor: 12300 }),
        },
      ),
    );

    expect(updateResponse.status).toBe(200);
    const updated = await asJson(updateResponse);
    expect(updated.priceMinor).toBe(12300);
    expect(updated.freeTrainingsIncluded).toBe(2);

    const stored = await getPlanAllowance(created.membershipPlanId);
    expect(stored?.free_trainings_included).toBe(2);
    // COALESCE writes the SAME value back, so OLD = NEW = 2 and
    // `membership_plans_stamp_free_trainings_anchor_trg`'s
    // `WHEN (OLD.free_trainings_included = 0 AND NEW.free_trainings_included > 0)` is false.
    expect(stored?.free_trainings_anchor_at.getTime()).toBe(
      afterRaise?.free_trainings_anchor_at.getTime(),
    );
  });

  it('an update that SENDS freeTrainingsIncluded still overwrites the stored allowance', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...basicPayload, freeTrainingsIncluded: 4 }),
      }),
    ).then(asJson);
    expect(created.freeTrainingsIncluded).toBe(4);

    const updateResponse = await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        {
          method: 'PATCH',
          headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...basicPayload, freeTrainingsIncluded: 0 }),
        },
      ),
    );

    expect(updateResponse.status).toBe(200);
    expect((await asJson(updateResponse)).freeTrainingsIncluded).toBe(0);
    expect((await getPlanAllowance(created.membershipPlanId))?.free_trainings_included).toBe(0);
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

// ---------------------------------------------------------------------------
// Slice 2 ("Setup memberships") — listMembershipPlans selection/deadline fields,
// PUT .../me/membership-plan (self-service), PUT .../membership-selection-deadline
// ---------------------------------------------------------------------------

const getMemberColumn = (memberId: TeamMember.TeamMemberId) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.flatMap(
        (sql) =>
          sql<{
            membership_plan_id: string | null;
          }>`SELECT membership_plan_id FROM team_members WHERE id = ${memberId}`,
      ),
      Effect.map((rows) => rows[0]?.membership_plan_id ?? null),
    ),
  );

const listResponseBody = async (teamId: Team.TeamId, token: string) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/membership-plans`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ).then(asJson);

const selectPlan = (teamId: Team.TeamId, token: string, membershipPlanId: string) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/me/membership-plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ membershipPlanId }),
    }),
  );

const setDeadline = (teamId: Team.TeamId, token: string, deadline: string | null) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/membership-selection-deadline`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ deadline }),
    }),
  );

describe('GET /teams/:teamId/membership-plans — selection and deadline fields', () => {
  it('a member who never chose a plan sees selectedPlanId null', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const body = await listResponseBody(fixture.team.id, 'actor-token');

    expect(body.selectedPlanId).toBeNull();
  });

  it('a member who chose a plan sees selectedPlanId as that plan id', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);

    const selectResponse = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);
    expect(selectResponse.status).toBe(204);

    const body = await listResponseBody(fixture.team.id, 'actor-token');
    expect(body.selectedPlanId).toBe(seeded?.id);
  });

  it('a configured deadline is present as an ISO string', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const deadline = '2099-06-15T12:00:00.000Z';

    const deadlineResponse = await setDeadline(fixture.team.id, 'actor-token', deadline);
    expect(deadlineResponse.status).toBe(204);

    const body = await listResponseBody(fixture.team.id, 'actor-token');
    expect(body.selectionDeadline).toBe(deadline);
  });
});

describe('PUT /teams/:teamId/me/membership-plan', () => {
  it(
    'an ordinary member with NO permissions gets 204, and the plan is reflected in a ' +
      'follow-up list call — self-service must NOT require finance:manage_fees',
    async () => {
      const fixture = await seedFixture([]);
      sessionsStore.set('actor-token', fixture.actorUserId);
      const [seeded] = await getPlanRows(fixture.team.id);

      const response = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);

      expect(response.status).toBe(204);
      const body = await listResponseBody(fixture.team.id, 'actor-token');
      expect(body.selectedPlanId).toBe(seeded?.id);
    },
  );

  it('a non-member gets 403 MembershipPlanForbidden', async () => {
    const fixture = await seedFixture([]);
    const outsiderUserId = await runSeeded(createUser('mp-outsider2'));
    sessionsStore.set('outsider-token', outsiderUserId);
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await selectPlan(fixture.team.id, 'outsider-token', seeded?.id);

    expect(response.status).toBe(403);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanForbidden');
  });

  it("another team's plan id -> 404 MembershipPlanNotFound, and the member's column is still NULL", async () => {
    const fixtureA = await seedFixture([]);
    const fixtureB = await seedFixture([]);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);
    const [planB] = await getPlanRows(fixtureB.team.id);

    const response = await selectPlan(fixtureA.team.id, 'actor-a-token', planB?.id);

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
    const column = await getMemberColumn(fixtureA.actorMemberId);
    expect(column).toBeNull();
  });

  it('an archived plan id -> 404 MembershipPlanNotFound', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    ).then(asJson);
    await handler(
      new Request(
        `http://localhost/teams/${fixture.team.id}/membership-plans/${created.membershipPlanId}`,
        { method: 'DELETE', headers: { Authorization: 'Bearer actor-token' } },
      ),
    );

    const response = await selectPlan(fixture.team.id, 'actor-token', created.membershipPlanId);

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
  });

  it('a deadline in the past -> 409 MembershipSelectionClosed, column unchanged', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);
    const pastDeadline = '2020-01-01T00:00:00.000Z';
    const deadlineResponse = await setDeadline(fixture.team.id, 'actor-token', pastDeadline);
    expect(deadlineResponse.status).toBe(204);

    const response = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);

    expect(response.status).toBe(409);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipSelectionClosed');
    const column = await getMemberColumn(fixture.actorMemberId);
    expect(column).toBeNull();
  });

  it('a deadline in the future -> 204', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);
    const futureDeadline = '2099-06-15T12:00:00.000Z';
    const deadlineResponse = await setDeadline(fixture.team.id, 'actor-token', futureDeadline);
    expect(deadlineResponse.status).toBe(204);

    const response = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);

    expect(response.status).toBe(204);
  });

  it('switching plans twice: 204 both times, last write wins', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seededDefault] = await getPlanRows(fixture.team.id);
    const created = await handler(
      new Request(`http://localhost/teams/${fixture.team.id}/membership-plans`, {
        method: 'POST',
        headers: { Authorization: 'Bearer actor-token', 'Content-Type': 'application/json' },
        body: JSON.stringify(basicPayload),
      }),
    ).then(asJson);

    const firstResponse = await selectPlan(fixture.team.id, 'actor-token', seededDefault?.id);
    expect(firstResponse.status).toBe(204);

    const secondResponse = await selectPlan(
      fixture.team.id,
      'actor-token',
      created.membershipPlanId,
    );
    expect(secondResponse.status).toBe(204);

    const column = await getMemberColumn(fixture.actorMemberId);
    expect(column).toBe(created.membershipPlanId);
  });
});

describe('PUT /teams/:teamId/membership-selection-deadline', () => {
  it('a finance:manage_fees holder gets 204, reflected in the list response', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const deadline = '2099-06-15T12:00:00.000Z';

    const response = await setDeadline(fixture.team.id, 'actor-token', deadline);

    expect(response.status).toBe(204);
    const body = await listResponseBody(fixture.team.id, 'actor-token');
    expect(body.selectionDeadline).toBe(deadline);
  });

  it('a member WITHOUT finance:manage_fees gets 403, deadline unchanged', async () => {
    const fixture = await seedFixture([]);
    sessionsStore.set('actor-token', fixture.actorUserId);

    const response = await setDeadline(fixture.team.id, 'actor-token', '2099-06-15T12:00:00.000Z');

    expect(response.status).toBe(403);
    const body = await listResponseBody(fixture.team.id, 'actor-token');
    expect(body.selectionDeadline).toBeNull();
  });

  it('a non-member gets 403', async () => {
    const fixture = await seedFixture([]);
    const outsiderUserId = await runSeeded(createUser('mp-outsider3'));
    sessionsStore.set('outsider-token', outsiderUserId);

    const response = await setDeadline(
      fixture.team.id,
      'outsider-token',
      '2099-06-15T12:00:00.000Z',
    );

    expect(response.status).toBe(403);
  });

  it("{ deadline: null } -> 204, and a select that previously 409'd now returns 204", async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);
    const pastDeadline = '2020-01-01T00:00:00.000Z';
    await setDeadline(fixture.team.id, 'actor-token', pastDeadline);

    const closedAttempt = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);
    expect(closedAttempt.status).toBe(409);

    const clearResponse = await setDeadline(fixture.team.id, 'actor-token', null);
    expect(clearResponse.status).toBe(204);

    const reopenedAttempt = await selectPlan(fixture.team.id, 'actor-token', seeded?.id);
    expect(reopenedAttempt.status).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Slice 3 ("Add CRUD for managing membership assigned members") — TDD: written
// BEFORE the handlers exist. Every test below FAILS until `api/membership-plan.ts`
// gains the `assignMembershipPlan` / `reassignMembershipPlan` handlers and the
// `assignments` field on `listMembershipPlans` (plan Task 3).
// ---------------------------------------------------------------------------

/** A second, ordinary member of the fixture's team — the one the actor assigns plans TO. */
const seedSecondMember = (teamId: Team.TeamId, username: string) =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser(username)),
      Effect.bind('memberId', ({ userId }) => addTeamMember(teamId, userId)),
    ),
  );

/** Sets the users table's profile `name` column directly — `upsertFromDiscord` has no slot
 * for it, and `pickDisplayName` prefers it over every Discord field. */
const setUserProfileName = (userId: User.UserId, name: string) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen((sql) => sql`UPDATE users SET name = ${name} WHERE id = ${userId}`),
    ),
  );

const setMemberActiveRaw = (memberId: TeamMember.TeamMemberId, active: boolean) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) => sql`UPDATE team_members SET active = ${active} WHERE id = ${memberId}`,
      ),
    ),
  );

const setMemberPlanRaw = (memberId: TeamMember.TeamMemberId, planId: string | null) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen(
        (sql) => sql`UPDATE team_members SET membership_plan_id = ${planId} WHERE id = ${memberId}`,
      ),
    ),
  );

/** PUT /teams/:teamId/members/:memberId/membership-plan — mirrors `selectPlan` above. */
const assignPlan = (
  teamId: Team.TeamId,
  token: string,
  memberId: TeamMember.TeamMemberId,
  membershipPlanId: string | null,
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/members/${memberId}/membership-plan`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ membershipPlanId }),
    }),
  );

/** POST /teams/:teamId/membership-plan-reassign — the FLAT bulk path (§B.5). */
const reassignPlans = (
  teamId: Team.TeamId,
  token: string,
  fromMembershipPlanId: string | null,
  toMembershipPlanId: string | null,
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/membership-plan-reassign`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromMembershipPlanId, toMembershipPlanId }),
    }),
  );

/** Creates a second, non-default plan on the team via the real POST route. */
const createPlanViaApi = (teamId: Team.TeamId, token: string, name: string) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/membership-plans`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...basicPayload, name }),
    }),
  ).then(asJson);

const archivePlanViaApi = (teamId: Team.TeamId, token: string, planId: string) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/membership-plans/${planId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }),
  );

// The realistic permission drift for this feature is `finance:manage_fees` -> `finance:view`.
// Every Captain AND every Treasurer holds `finance:view` (`Role.ts:68,81`), so a fixture with
// ONLY `finance:view` (plus the roster reads a Captain also has) is the one that actually
// catches the regression — `seedFixture([])` stays green through it.
const NEAR_MISS_PERMISSIONS = ['finance:view', 'roster:view', 'member:view'] as const;

describe('PUT /teams/:teamId/members/:memberId/membership-plan', () => {
  it('a finance:manage_fees holder assigns ANOTHER member onto a plan -> 204, column written', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-1');
    const created = await createPlanViaApi(fixture.team.id, 'actor-token', 'Adult membership');

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      created.membershipPlanId,
    );

    expect(response.status).toBe(204);
    expect(await getMemberColumn(target.memberId)).toBe(created.membershipPlanId);
  });

  it('{ membershipPlanId: null } clears the assignment -> 204, column null', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-2');
    const [seeded] = await getPlanRows(fixture.team.id);
    await setMemberPlanRaw(target.memberId, seeded?.id ?? null);

    const response = await assignPlan(fixture.team.id, 'actor-token', target.memberId, null);

    expect(response.status).toBe(204);
    expect(await getMemberColumn(target.memberId)).toBeNull();
  });

  it('finance:view + roster:view + member:view -> 403, column unchanged (§B.3 drift guard)', async () => {
    const fixture = await seedFixture([...NEAR_MISS_PERMISSIONS]);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-3');
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      seeded?.id ?? null,
    );

    expect(response.status).toBe(403);
    expect(await getMemberColumn(target.memberId)).toBeNull();
  });

  it('team:manage alone -> 403 (pins §B.3: the gate is finance:manage_fees, not team:manage)', async () => {
    const fixture = await seedFixture(['team:manage']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-4');
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      seeded?.id ?? null,
    );

    expect(response.status).toBe(403);
    expect(await getMemberColumn(target.memberId)).toBeNull();
  });

  it('member:edit alone -> 403 (this did NOT ride on the roster gate)', async () => {
    const fixture = await seedFixture(['member:edit', 'member:view']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-5');
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      seeded?.id ?? null,
    );

    expect(response.status).toBe(403);
    expect(await getMemberColumn(target.memberId)).toBeNull();
  });

  it('a non-member of the team -> 403 MembershipPlanForbidden', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    const outsiderUserId = await runSeeded(createUser('mp-assign-outsider'));
    sessionsStore.set('outsider-token', outsiderUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-6');
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await assignPlan(
      fixture.team.id,
      'outsider-token',
      target.memberId,
      seeded?.id ?? null,
    );

    expect(response.status).toBe(403);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanForbidden');
  });

  it('an ARCHIVED plan id -> 404 MembershipPlanNotFound, column unchanged', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-assign-target-7');
    const created = await createPlanViaApi(fixture.team.id, 'actor-token', 'Soon archived');
    await archivePlanViaApi(fixture.team.id, 'actor-token', created.membershipPlanId);

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      created.membershipPlanId,
    );

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
    expect(await getMemberColumn(target.memberId)).toBeNull();
  });

  it('an unknown memberId -> 404 MembershipPlanNotFound (the single-404 ceiling)', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await assignPlan(
      fixture.team.id,
      'actor-token',
      '00000000-0000-0000-0000-000000000000' as TeamMember.TeamMemberId,
      seeded?.id ?? null,
    );

    expect(response.status).toBe(404);
    const body = await asJson(response);
    expect(body._tag).toBe('MembershipPlanNotFound');
  });

  // THE WHOLE OF §B.2, in one test. Two calls, one passed deadline: the manager writes, the
  // member is refused. Splitting these into two tests would let a regression that copies the
  // deadline EXISTS clause into the manager UPDATE pass one and fail the other in isolation.
  it(
    'after the deadline has passed: the manager assign returns 204 while the same member ' +
      'own PUT /me/membership-plan returns 409 MembershipSelectionClosed',
    async () => {
      const fixture = await seedFixture(['finance:manage_fees']);
      sessionsStore.set('actor-token', fixture.actorUserId);
      const target = await seedSecondMember(fixture.team.id, 'mp-assign-deadline');
      sessionsStore.set('target-token', target.userId);
      const [seeded] = await getPlanRows(fixture.team.id);
      const created = await createPlanViaApi(fixture.team.id, 'actor-token', 'Adult membership');
      await setDeadline(fixture.team.id, 'actor-token', '2020-01-01T00:00:00.000Z');

      const selfService = await selectPlan(fixture.team.id, 'target-token', seeded?.id);
      expect(selfService.status, 'the deadline binds the MEMBER').toBe(409);
      expect((await asJson(selfService))._tag).toBe('MembershipSelectionClosed');

      const managerAssign = await assignPlan(
        fixture.team.id,
        'actor-token',
        target.memberId,
        created.membershipPlanId,
      );

      expect(managerAssign.status, 'the deadline does NOT bind the treasurer').toBe(204);
      expect(await getMemberColumn(target.memberId)).toBe(created.membershipPlanId);
    },
  );
});

describe('POST /teams/:teamId/membership-plan-reassign', () => {
  it('a finance:manage_fees holder moves 2 members A -> B: 200, movedCount 2, both columns B', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const m1 = await seedSecondMember(fixture.team.id, 'mp-bulk-1a');
    const m2 = await seedSecondMember(fixture.team.id, 'mp-bulk-1b');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');
    await setMemberPlanRaw(m1.memberId, planA.membershipPlanId);
    await setMemberPlanRaw(m2.memberId, planA.membershipPlanId);

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    const body = await asJson(response);
    expect(body.movedCount).toBe(2);
    expect(await getMemberColumn(m1.memberId)).toBe(planB.membershipPlanId);
    expect(await getMemberColumn(m2.memberId)).toBe(planB.membershipPlanId);
  });

  it('finance:view + roster:view + member:view -> 403, nothing moved (§B.3 drift guard)', async () => {
    const manager = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('manager-token', manager.actorUserId);
    const planA = await createPlanViaApi(manager.team.id, 'manager-token', 'Plan A');
    const planB = await createPlanViaApi(manager.team.id, 'manager-token', 'Plan B');
    const victim = await seedSecondMember(manager.team.id, 'mp-bulk-2-victim');
    await setMemberPlanRaw(victim.memberId, planA.membershipPlanId);
    const nearMissUserId = await runSeeded(createUser('mp-bulk-2-nearmiss'));
    const nearMissMemberId = await runSeeded(addTeamMember(manager.team.id, nearMissUserId));
    const nearMissRoleId = await runSeeded(
      createRoleWithPermissions(manager.team.id, 'Near miss', [...NEAR_MISS_PERMISSIONS]),
    );
    await runSeeded(assignRoleDirect(nearMissMemberId, nearMissRoleId));
    sessionsStore.set('nearmiss-token', nearMissUserId);

    const response = await reassignPlans(
      manager.team.id,
      'nearmiss-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(403);
    expect(await getMemberColumn(victim.memberId)).toBe(planA.membershipPlanId);
  });

  it('team:manage alone -> 403 (pins §B.3)', async () => {
    const fixture = await seedFixture(['team:manage']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const [seeded] = await getPlanRows(fixture.team.id);

    const response = await reassignPlans(fixture.team.id, 'actor-token', null, seeded?.id ?? null);

    expect(response.status).toBe(403);
  });

  it('an ARCHIVED target -> 404 MembershipPlanNotFound, every column unchanged (§B.7)', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const member = await seedSecondMember(fixture.team.id, 'mp-bulk-3');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');
    await setMemberPlanRaw(member.memberId, planA.membershipPlanId);
    await archivePlanViaApi(fixture.team.id, 'actor-token', planB.membershipPlanId);

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(404);
    expect((await asJson(response))._tag).toBe('MembershipPlanNotFound');
    expect(await getMemberColumn(member.memberId)).toBe(planA.membershipPlanId);
  });

  it("another team's plan id as target -> 404 MembershipPlanNotFound", async () => {
    const fixtureA = await seedFixture(['finance:manage_fees']);
    const fixtureB = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);
    const [planOfB] = await getPlanRows(fixtureB.team.id);

    const response = await reassignPlans(
      fixtureA.team.id,
      'actor-a-token',
      null,
      planOfB?.id ?? null,
    );

    expect(response.status).toBe(404);
    expect((await asJson(response))._tag).toBe('MembershipPlanNotFound');
  });

  // §B.5's NULL source, through the wire. `fromMembershipPlanId: null` must decode to `None`
  // and match the never-picked members with `IS NOT DISTINCT FROM`.
  it('fromMembershipPlanId null sweeps the NEVER-PICKED members onto B -> 200', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const m1 = await seedSecondMember(fixture.team.id, 'mp-bulk-null-1');
    const m2 = await seedSecondMember(fixture.team.id, 'mp-bulk-null-2');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      null,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    const body = await asJson(response);
    // The actor themselves has never picked either, so all three move.
    expect(body.movedCount).toBe(3);
    expect(await getMemberColumn(m1.memberId)).toBe(planB.membershipPlanId);
    expect(await getMemberColumn(m2.memberId)).toBe(planB.membershipPlanId);
  });

  it('toMembershipPlanId null clears every member on A back to the default -> 200, columns null', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const m1 = await seedSecondMember(fixture.team.id, 'mp-bulk-clear-1');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    await setMemberPlanRaw(m1.memberId, planA.membershipPlanId);

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      null,
    );

    expect(response.status).toBe(200);
    expect((await asJson(response)).movedCount).toBe(1);
    expect(await getMemberColumn(m1.memberId)).toBeNull();
  });

  // §B.8 — `movedCount: 0` is a SUCCESS, never a 404. The target here is valid and active, so
  // the handler's 0-row classification re-read must take the `Some -> movedCount 0` branch.
  it('no match -> 200 with movedCount 0, NOT 404', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    expect((await asJson(response)).movedCount).toBe(0);
  });

  it('an ARCHIVED source is allowed: its members are swept onto B -> 200 (§B.5)', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const member = await seedSecondMember(fixture.team.id, 'mp-bulk-archsrc');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');
    await setMemberPlanRaw(member.memberId, planA.membershipPlanId);
    await archivePlanViaApi(fixture.team.id, 'actor-token', planA.membershipPlanId);

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    expect((await asJson(response)).movedCount).toBe(1);
    expect(await getMemberColumn(member.memberId)).toBe(planB.membershipPlanId);
  });

  it('a passed deadline does not block the bulk move -> 200 (§B.2)', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const member = await seedSecondMember(fixture.team.id, 'mp-bulk-deadline');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');
    await setMemberPlanRaw(member.memberId, planA.membershipPlanId);
    await setDeadline(fixture.team.id, 'actor-token', '2020-01-01T00:00:00.000Z');

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    expect((await asJson(response)).movedCount).toBe(1);
    expect(await getMemberColumn(member.memberId)).toBe(planB.membershipPlanId);
  });

  it("TENANCY: a manager of team A cannot move team B's members", async () => {
    const fixtureA = await seedFixture(['finance:manage_fees']);
    const fixtureB = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-a-token', fixtureA.actorUserId);
    sessionsStore.set('actor-b-token', fixtureB.actorUserId);
    const targetA = await createPlanViaApi(fixtureA.team.id, 'actor-a-token', 'Target A');
    const memberA = await seedSecondMember(fixtureA.team.id, 'mp-bulk-tenancy-a');
    const memberB = await seedSecondMember(fixtureB.team.id, 'mp-bulk-tenancy-b');

    const response = await reassignPlans(
      fixtureA.team.id,
      'actor-a-token',
      null,
      targetA.membershipPlanId,
    );

    expect(response.status).toBe(200);
    const body = await asJson(response);
    // Team A's actor + memberA — team B's never-picked members must not be counted.
    expect(body.movedCount).toBe(2);
    expect(await getMemberColumn(memberA.memberId)).toBe(targetA.membershipPlanId);
    expect(await getMemberColumn(memberB.memberId)).toBeNull();
    expect(await getMemberColumn(fixtureB.actorMemberId)).toBeNull();
  });

  it('movedCount is the ACTUAL affected count, not the intent: a deactivated member is excluded', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const m1 = await seedSecondMember(fixture.team.id, 'mp-bulk-count-1');
    const m2 = await seedSecondMember(fixture.team.id, 'mp-bulk-count-2');
    const m3 = await seedSecondMember(fixture.team.id, 'mp-bulk-count-3');
    const planA = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan A');
    const planB = await createPlanViaApi(fixture.team.id, 'actor-token', 'Plan B');
    for (const m of [m1, m2, m3]) await setMemberPlanRaw(m.memberId, planA.membershipPlanId);
    await setMemberActiveRaw(m3.memberId, false);

    const response = await reassignPlans(
      fixture.team.id,
      'actor-token',
      planA.membershipPlanId,
      planB.membershipPlanId,
    );

    expect(response.status).toBe(200);
    expect((await asJson(response)).movedCount).toBe(2);
    expect(await getMemberColumn(m3.memberId)).toBe(planA.membershipPlanId);
  });
});

describe('GET /teams/:teamId/membership-plans — the assignments roster', () => {
  // THE ENCODE GUARD for `MembershipPlanAssignment`. `check-rpc-encoding.mjs` only resolves an
  // endpoint's `success:` value and unwraps at most one `Schema.Array(` — a `Schema.Class`
  // nested in a FIELD is invisible to it (A.5). A length-only assertion never touches the
  // encoded row either; reading `displayName` off the JSON is what proves the handler built a
  // real `new MembershipPlanApi.MembershipPlanAssignment({...})` and that it encodes.
  it('a manager sees one entry per active member, with the RESOLVED displayName encoded', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-roster-named');
    await setUserProfileName(target.userId, 'Jana Nováková');

    const body = await listResponseBody(fixture.team.id, 'actor-token');

    expect(body.assignments).toHaveLength(2);
    const entry = body.assignments.find(
      (a: { memberId: string }) => a.memberId === target.memberId,
    );
    expect(entry).toBeDefined();
    expect(entry.displayName).toBe('Jana Nováková');
    expect(entry.membershipPlanId, 'never picked -> null on the wire').toBeNull();
  });

  it('displayName falls back to username when the user has no profile name', async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-roster-nameless');

    const body = await listResponseBody(fixture.team.id, 'actor-token');

    const entry = body.assignments.find(
      (a: { memberId: string }) => a.memberId === target.memberId,
    );
    expect(entry.displayName).toBe('mp-roster-nameless');
  });

  // THE PRIVACY BOUNDARY (§B.3). `finance:view` is held by every Captain AND every Treasurer
  // (`Role.ts:68,81`), so this — not a zero-permission fixture — is the test that stays red
  // through a `finance:manage_fees` -> `finance:view` regression.
  it('a finance:view + roster:view + member:view holder sees assignments: []', async () => {
    const fixture = await seedFixture([...NEAR_MISS_PERMISSIONS]);
    sessionsStore.set('actor-token', fixture.actorUserId);
    await seedSecondMember(fixture.team.id, 'mp-roster-private');

    const body = await listResponseBody(fixture.team.id, 'actor-token');

    expect(body.canManage).toBe(false);
    expect(body.assignments).toEqual([]);
  });

  it("the two reads agree: a captain-assigned plan shows in assignments AND as that member's own selectedPlanId", async () => {
    const fixture = await seedFixture(['finance:manage_fees']);
    sessionsStore.set('actor-token', fixture.actorUserId);
    const target = await seedSecondMember(fixture.team.id, 'mp-roster-agree');
    sessionsStore.set('target-token', target.userId);
    const created = await createPlanViaApi(fixture.team.id, 'actor-token', 'Adult membership');

    const assignResponse = await assignPlan(
      fixture.team.id,
      'actor-token',
      target.memberId,
      created.membershipPlanId,
    );
    expect(assignResponse.status).toBe(204);

    const managerBody = await listResponseBody(fixture.team.id, 'actor-token');
    const entry = managerBody.assignments.find(
      (a: { memberId: string }) => a.memberId === target.memberId,
    );
    expect(entry.membershipPlanId).toBe(created.membershipPlanId);

    const memberBody = await listResponseBody(fixture.team.id, 'target-token');
    expect(memberBody.selectedPlanId).toBe(created.membershipPlanId);
    expect(memberBody.assignments, 'the member is not a manager').toEqual([]);
  });
});
