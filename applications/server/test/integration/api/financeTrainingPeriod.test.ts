// Slice 3b of "Setup memberships" — the `TrainingFeeImmutable` guards on `updateFee` /
// `updateAssignment` (`applications/server/src/api/finance.ts`), backed by real repositories over
// a real Postgres instance.
//
// `test/integration/api/finance.test.ts` is a MOCK harness (in-memory `Map`s standing in for
// `FeesRepository`/`FeeAssignmentsRepository` — there is no `fees.kind` column to even read), so
// it cannot exercise these guards at all. Pattern instead: `test/integration/api/
// eventAttendance.test.ts` — a `SmallApi` built from just the `finance` group, a mocked
// `SessionsRepository` for auth, and every other repository real.

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

let discordIdCounter = 950_000_000_000_000_000n;
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
        name: 'Finance Training Period API Team',
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

/** A fresh team + a treasurer member (`finance:manage_fees`), plus one billed member. */
const seedFixture = () =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('finance-tp-owner')),
      Effect.bind('team', ({ ownerUserId }) => createTeam(ownerUserId)),
      Effect.bind('treasurerUserId', () => createUser('finance-tp-treasurer')),
      Effect.bind('treasurerMemberId', ({ team, treasurerUserId }) =>
        addTeamMember(team.id, treasurerUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('billedUserId', () => createUser('finance-tp-billed')),
      Effect.bind('billedMemberId', ({ team, billedUserId }) =>
        addTeamMember(team.id, billedUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Treasurer role', ['finance:manage_fees']),
      ),
      Effect.tap(({ treasurerMemberId, roleId }) => assignRoleDirect(treasurerMemberId, roleId)),
    ),
  );

/** Hand-inserts a `kind='training'` fee + one unpaid assignment — the API guard cares only
 * about `fees.kind`, never about how the row was produced. */
const createTrainingFeeAndAssignment = (teamId: Team.TeamId, memberId: string) =>
  runSeeded(
    SqlClient.SqlClient.asEffect().pipe(
      Effect.andThen((sql) =>
        Effect.gen(function* () {
          const feeRows = yield* sql<{ id: string }>`
            INSERT INTO fees (team_id, name, amount_minor, currency, due_at, target_scope, kind, period_start)
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
      ),
    ),
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

// ---------------------------------------------------------------------------
// 25-26. updateFee
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/fees/:feeId — training fee immutability', () => {
  it("changing currency on a kind='training' fee gets 409 TrainingFeeImmutable, not a 500", async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createTrainingFeeAndAssignment(fixture.team.id, fixture.billedMemberId);

    const response = await patchFee(fixture.team.id, feeId, 'treasurer-token', {
      currency: 'EUR',
    });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body._tag ?? body.tag ?? JSON.stringify(body)).toContain('TrainingFeeImmutable');
  });

  it('changing name on a training fee is still allowed', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId } = await createTrainingFeeAndAssignment(fixture.team.id, fixture.billedMemberId);

    const response = await patchFee(fixture.team.id, feeId, 'treasurer-token', {
      name: 'September (renamed)',
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.name).toBe('September (renamed)');
  });

  it('the same currency change on a MANUAL fee is unaffected (200, not 409)', async () => {
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
// 27-28. updateAssignment
// ---------------------------------------------------------------------------

describe('PATCH /teams/:teamId/fees/:feeId/assignments/:assignmentId — training fee immutability', () => {
  it('changing amountMinor on a training-fee assignment gets 409 TrainingFeeImmutable', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId, assignmentId } = await createTrainingFeeAndAssignment(
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
    const body = await response.json();
    expect(body._tag ?? body.tag ?? JSON.stringify(body)).toContain('TrainingFeeImmutable');
  });

  it('the same amountMinor change on a MANUAL fee assignment is unaffected (200, not 409)', async () => {
    const fixture = await seedFixture();
    sessionsStore.set('treasurer-token', fixture.treasurerUserId);
    const { feeId, assignmentId } = await createManualFeeAndAssignment(
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

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.dueMinor).toBe(999);
  });
});
