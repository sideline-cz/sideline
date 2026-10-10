// The `GeneratedFeeImmutable` guards on `updateFee` / `updateAssignment` / **`assignFee`**
// (`applications/server/src/api/finance.ts`), backed by real repositories over a real Postgres.
//
// Scaffolding copied wholesale from `api/financeTrainingPeriod.test.ts` — the `SmallApi` built
// from just the `finance` group, a mocked `SessionsRepository`, every other repository real.
// `api/finance.test.ts` is a MOCK harness with no `fees.kind` column and cannot exercise any of
// this.
//
// `assignFee` IS THE HIGH-VALUE ENDPOINT HERE, and it is the one the first draft of the plan
// missed. `bulkInsert` honours `amountMinorOverride`, so a treasurer typing 1500 onto a
// membership shell inflates that member's `charged` sum, and the next sweep tick turns the
// resulting NEGATIVE delta into real, spendable member credit — repeatable, with a bigger payout
// for a bigger number. C7 therefore asserts the row count as well as the status: a 409 alone
// would pass if the guard ran AFTER `bulkInsert`.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { FinanceApi } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { HttpRouter, HttpServer } from 'effect/unstable/http';
import { HttpApi, HttpApiBuilder } from 'effect/unstable/httpapi';
import { SqlClient } from 'effect/unstable/sql';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { FinanceApiLive } from '~/api/finance.js';
import { AuthMiddlewareLive } from '~/middleware/AuthMiddlewareLive.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { MemberCreditsRepository } from '~/repositories/MemberCreditsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { SessionsRepository } from '~/repositories/SessionsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const SmallApi = HttpApi.make('api').add(FinanceApi.FinanceApiGroup);

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
        expires_at: new Date(),
        created_at: new Date(),
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
  FeesRepository.Default,
  FeeAssignmentsRepository.Default,
  PaymentsRepository.Default,
  FinanceOverviewRepository.Default,
  MemberCreditsRepository.Default,
  NotificationsRepository.Default,
);

const TestLayer = HttpApiBuilder.layer(SmallApi).pipe(
  Layer.provide(FinanceApiLive),
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

let discordIdCounter = 960_000_000_000_000_000n;
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

const createTeam = (createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Finance Membership API Team',
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

const runSeeded = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.runPromise(effect.pipe(Effect.provide(SeedLayer)) as Effect.Effect<A, E, never>);

/** A fresh team + a treasurer (`finance:manage_fees`), one already-billed member, and a THIRD
 *  member nobody has assigned yet — `assignFee` needs a target that does not already collide with
 *  `fee_assignments UNIQUE (fee_id, team_member_id)`. */
const seedFixture = () =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('finance-ms-owner')),
      Effect.bind('team', ({ ownerUserId }) => createTeam(ownerUserId)),
      Effect.bind('treasurerUserId', () => createUser('finance-ms-treasurer')),
      Effect.bind('treasurerMemberId', ({ team, treasurerUserId }) =>
        addTeamMember(team.id, treasurerUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('billedUserId', () => createUser('finance-ms-billed')),
      Effect.bind('billedMemberId', ({ team, billedUserId }) =>
        addTeamMember(team.id, billedUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('unassignedUserId', () => createUser('finance-ms-unassigned')),
      Effect.bind('unassignedMemberId', ({ team, unassignedUserId }) =>
        addTeamMember(team.id, unassignedUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Treasurer role', ['finance:manage_fees']),
      ),
      Effect.tap(({ treasurerMemberId, roleId }) => assignRoleDirect(treasurerMemberId, roleId)),
    ),
  );

/** Hand-inserts a `kind='membership'` fee keyed on the team's running season and its default
 *  plan, plus one assignment. The API guards read `fees.kind` and nothing else, so how the row
 *  was produced is irrelevant — but season_id and membership_plan_id are both forced NOT NULL for
 *  this kind by `fees_kind_season_check` / `fees_kind_plan_check`, so they have to be real. */
const createMembershipFeeAndAssignment = (teamId: Team.TeamId, memberId: string) =>
  runSeeded(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const seasonRows = yield* sql<{ id: string }>`
        SELECT s.id::text AS id FROM seasons s
         WHERE s.team_id = ${teamId} AND s.starts_at <= now()
         ORDER BY s.starts_at DESC LIMIT 1
      `;
      const seasonId = seasonRows[0]?.id;
      if (seasonId === undefined) throw new Error('expected a seeded running season');

      const planRows = yield* sql<{ id: string }>`
        SELECT id::text AS id FROM membership_plans
         WHERE team_id = ${teamId} AND is_default AND archived_at IS NULL
      `;
      const planId = planRows[0]?.id;
      if (planId === undefined) throw new Error('expected a seeded default membership plan');

      const feeRows = yield* sql<{ id: string }>`
        INSERT INTO fees (team_id, name, amount_minor, currency, due_at, target_scope, kind,
                          season_id, membership_plan_id)
        VALUES (${teamId}, '2026-09-01', 0, 'CZK', now() + INTERVAL '14 days', 'custom',
                'membership', ${seasonId}::uuid, ${planId}::uuid)
        RETURNING id::text AS id
      `;
      const feeId = feeRows[0]?.id;
      if (feeId === undefined) throw new Error('expected an inserted fee id');

      const assignmentRows = yield* sql<{ id: string }>`
        INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor, due_at)
        VALUES (${feeId}, ${memberId}, 1500, now() + INTERVAL '14 days')
        RETURNING id::text AS id
      `;
      const assignmentId = assignmentRows[0]?.id;
      if (assignmentId === undefined) throw new Error('expected an inserted assignment id');
      return { feeId, assignmentId };
    }),
  );

const createTrainingFeeAndAssignment = (teamId: Team.TeamId, memberId: string) =>
  runSeeded(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const feeRows = yield* sql<{ id: string }>`
        INSERT INTO fees (team_id, name, amount_minor, currency, due_at, target_scope, kind,
                          period_start)
        VALUES (${teamId}, '2026-09', 0, 'CZK', '2026-10-10', 'custom', 'training', '2026-09-01')
        RETURNING id::text AS id
      `;
      const feeId = feeRows[0]?.id;
      if (feeId === undefined) throw new Error('expected an inserted fee id');
      const assignmentRows = yield* sql<{ id: string }>`
        INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
        VALUES (${feeId}, ${memberId}, 100)
        RETURNING id::text AS id
      `;
      const assignmentId = assignmentRows[0]?.id;
      if (assignmentId === undefined) throw new Error('expected an inserted assignment id');
      return { feeId, assignmentId };
    }),
  );

const createManualFeeAndAssignment = (teamId: Team.TeamId, memberId: string) =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('fees', () => FeesRepository.asEffect()),
      Effect.bind('fee', ({ fees }) =>
        fees.insert({
          team_id: teamId,
          name: 'Kit fee',
          description: Option.none(),
          amount_minor: 500,
          currency: 'CZK',
          due_at: Option.none(),
        }),
      ),
      Effect.bind('assignment', ({ fees, fee }) =>
        fees.insertAssignmentForTest(fee.id, memberId as never, 500),
      ),
      Effect.map(({ fee, assignment }) => ({ feeId: fee.id, assignmentId: assignment.id })),
    ),
  );

const assignmentCount = (feeId: string) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.flatMap(
        (sql) => sql<{ count: string }>`
          SELECT count(*)::text AS count FROM fee_assignments WHERE fee_id = ${feeId}::uuid
        `,
      ),
      Effect.map((rows) => Number(rows[0]?.count)),
    ),
  );

const patchFee = (teamId: string, feeId: string, token: string, body: Record<string, unknown>) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/fees/${feeId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const patchAssignment = (
  teamId: string,
  feeId: string,
  assignmentId: string,
  token: string,
  body: Record<string, unknown>,
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/fees/${feeId}/assignments/${assignmentId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const postAssignments = (
  teamId: string,
  feeId: string,
  token: string,
  body: Record<string, unknown>,
) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/fees/${feeId}/assignments`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const tagOf = async (response: Response) => {
  const body = await response.json();
  return String(body._tag ?? body.tag ?? JSON.stringify(body));
};

// ---------------------------------------------------------------------------
// C1, C2, C6 — updateFee
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/fees/:feeId — membership fee immutability', () => {
  // C1. A membership fee's identity is (season, plan, currency) and the generator owns it:
  // changing currency would violate `idx_fees_team_season_plan_currency` and surface as an
  // untyped 500 via `catchSqlErrors`. The tag must be the MEMBERSHIP one — "training" is a false
  // statement about this row.
  it("changing currency on a kind='membership' fee gets 409 GeneratedFeeImmutable", async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );

    const response = await patchFee(fixture.team.id, feeId, 'treasurer-token', {
      currency: 'EUR',
    });

    expect(response.status).toBe(409);
    const tag = await tagOf(response);
    expect(tag).toContain('GeneratedFeeImmutable');
    expect(tag).not.toContain('TrainingFeeImmutable');
  });

  // C2. The shell's name is locale-free and deliberately plain ("plan name + season start"), so
  // relabelling it is a treasurer's business.
  it('changing the NAME on a membership fee is still allowed', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );

    const response = await patchFee(fixture.team.id, feeId, 'treasurer-token', {
      name: 'Členské 2026/27',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe('Členské 2026/27');
  });

  // C6. The regression guard: widening the check from `kind === 'training'` to
  // `kind !== 'manual'` must not catch manual fees.
  it("the same currency change on a kind='manual' fee is unaffected (200)", async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createManualFeeAndAssignment(fixture.team.id, fixture.billedMemberId);

    const response = await patchFee(fixture.team.id, feeId, 'treasurer-token', {
      currency: 'EUR',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.currency).toBe('EUR');
  });
});

// ---------------------------------------------------------------------------
// C3, C4 — updateAssignment
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/fees/:feeId/assignments/:assignmentId — membership immutability', () => {
  // C3. A hand-edited membership amount is NOT silently reverted on the next tick: it sticks and
  // corrupts the member's `charged` sum, so the generator derives a bogus charge — or a bogus
  // refund, which is real spendable credit — from the edited figure.
  it('changing amountMinor on a membership assignment gets 409 GeneratedFeeImmutable', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId, assignmentId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );

    const response = await patchAssignment(
      fixture.team.id,
      feeId,
      assignmentId,
      'treasurer-token',
      { amountMinor: 999 },
    );

    expect(response.status).toBe(409);
    expect(await tagOf(response)).toContain('GeneratedFeeImmutable');
  });

  // C4. Only the AMOUNT is generator-owned. S4 writes `due_at` on INSERT and deliberately leaves
  // it out of the `DO UPDATE SET` so an edit survives the next tick (B19 pins that half).
  it('changing dueAt on a membership assignment is allowed (200)', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId, assignmentId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );

    const response = await patchAssignment(
      fixture.team.id,
      feeId,
      assignmentId,
      'treasurer-token',
      { dueAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString() },
    );

    expect(response.status).toBe(200);
  });

  // C4, the other half — and the reason B16b's waive is a legal arrangement rather than a
  // back-door SQL edit.
  it('WAIVING a membership assignment is allowed (200)', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId, assignmentId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );

    const response = await patchAssignment(
      fixture.team.id,
      feeId,
      assignmentId,
      'treasurer-token',
      { waived: true, waivedReason: 'hardship' },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.status).toBe('waived');
  });
});

// ---------------------------------------------------------------------------
// C7, C7b, C7c, C7d — assignFee, the credit-minting path
// ---------------------------------------------------------------------------

describe('POST /teams/:teamId/fees/:feeId/assignments — generated fees are the generator’s', () => {
  // C7. The single highest-value case in this file. The row COUNT is asserted as well as the
  // status: a 409 on its own would pass if the guard ran after `bulkInsert`, and the row is the
  // thing that mints credit on the next tick.
  it('assigning a member onto a membership fee WITH an override gets 409 and writes nothing', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );
    const before = await assignmentCount(feeId);

    const response = await postAssignments(fixture.team.id, feeId, 'treasurer-token', {
      memberIds: [fixture.unassignedMemberId],
      amountMinorOverride: 1500,
      dueAtOverride: null,
    });

    expect(response.status).toBe(409);
    expect(await tagOf(response)).toContain('GeneratedFeeImmutable');
    expect(await assignmentCount(feeId)).toBe(before);
  });

  // C7b. There is no "safe" override value: without one the insert lands at the shell's
  // `amount_minor = 0` and is merely wrong, so the WHOLE endpoint is refused.
  it('the same POST with NO override is still 409', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createMembershipFeeAndAssignment(
      fixture.team.id,
      fixture.billedMemberId,
    );
    const before = await assignmentCount(feeId);

    const response = await postAssignments(fixture.team.id, feeId, 'treasurer-token', {
      memberIds: [fixture.unassignedMemberId],
      amountMinorOverride: null,
      dueAtOverride: null,
    });

    expect(response.status).toBe(409);
    expect(await tagOf(response)).toContain('GeneratedFeeImmutable');
    expect(await assignmentCount(feeId)).toBe(before);
  });

  // C7c. NEW BEHAVIOUR for an existing kind: `assignFee` had no guard at all before, so a
  // training fee used to 201 here. The tag has to match the kind.
  it("the same POST against a kind='training' fee is 409 TrainingFeeImmutable", async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createTrainingFeeAndAssignment(fixture.team.id, fixture.billedMemberId);
    const before = await assignmentCount(feeId);

    const response = await postAssignments(fixture.team.id, feeId, 'treasurer-token', {
      memberIds: [fixture.unassignedMemberId],
      amountMinorOverride: 100,
      dueAtOverride: null,
    });

    expect(response.status).toBe(409);
    expect(await tagOf(response)).toContain('TrainingFeeImmutable');
    expect(await assignmentCount(feeId)).toBe(before);
  });

  // C7d. The regression guard for every existing treasurer workflow.
  it("the same POST against a kind='manual' fee is unchanged (201)", async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createManualFeeAndAssignment(fixture.team.id, fixture.billedMemberId);

    const response = await postAssignments(fixture.team.id, feeId, 'treasurer-token', {
      memberIds: [fixture.unassignedMemberId],
      amountMinorOverride: 700,
      dueAtOverride: null,
    });

    expect(response.status).toBe(201);
    expect(await assignmentCount(feeId)).toBe(2);
  });
});
