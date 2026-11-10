// TDD — written before the importFees handler exists. Spec: .dev-loop/plan.md, Task 3.
// Scaffolding copied from api/financeMembershipFee.test.ts.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, Role, Team, TeamMember, User } from '@sideline/domain';
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

let discordIdCounter = 961_000_000_000_000_000n;
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
        name: 'Finance Import API Team',
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

// Treasurer (finance:manage_fees), active alice + bob, inactive carol, and a plain member.
const seedFixture = () =>
  runSeeded(
    Effect.Do.pipe(
      Effect.bind('ownerUserId', () => createUser('import-owner')),
      Effect.bind('team', ({ ownerUserId }) => createTeam(ownerUserId)),
      Effect.bind('treasurerUserId', () => createUser('import-treasurer')),
      Effect.bind('treasurerMemberId', ({ team, treasurerUserId }) =>
        addTeamMember(team.id, treasurerUserId).pipe(Effect.map((m) => m.id)),
      ),
      Effect.bind('plainUserId', () => createUser('import-plain')),
      Effect.tap(({ team, plainUserId }) => addTeamMember(team.id, plainUserId)),
      Effect.bind('aliceMemberId', ({ team }) =>
        createUser('alice').pipe(
          Effect.flatMap((u) => addTeamMember(team.id, u)),
          Effect.map((m) => m.id),
        ),
      ),
      Effect.bind('bobMemberId', ({ team }) =>
        createUser('bob').pipe(
          Effect.flatMap((u) => addTeamMember(team.id, u)),
          Effect.map((m) => m.id),
        ),
      ),
      Effect.bind('carolMemberId', ({ team }) =>
        createUser('carol').pipe(
          Effect.flatMap((u) => addTeamMember(team.id, u)),
          Effect.map((m) => m.id),
        ),
      ),
      Effect.tap(({ carolMemberId }) =>
        SqlClient.SqlClient.asEffect().pipe(
          Effect.flatMap(
            (sql) => sql`UPDATE team_members SET active = false WHERE id = ${carolMemberId}`,
          ),
        ),
      ),
      Effect.bind('roleId', ({ team }) =>
        createRoleWithPermissions(team.id, 'Treasurer role', ['finance:manage_fees']),
      ),
      Effect.tap(({ treasurerMemberId, roleId }) => assignRoleDirect(treasurerMemberId, roleId)),
    ),
  );

const DUE = '2026-09-30T12:00:00.000Z';

const importRow = (line: number, member: string, feeName: string, amountMinor: number) => ({
  line,
  member,
  feeName,
  amountMinor,
  currency: 'CZK',
  dueAt: DUE,
});

const VALID_ROWS = [
  importRow(2, 'alice', 'Fee A', 500),
  importRow(3, 'bob', 'Fee A', 700),
  importRow(4, 'alice', 'Fee B', 300),
];

const postImport = (teamId: string, token: string, rows: ReadonlyArray<unknown>) =>
  handler(
    new Request(`http://localhost/teams/${teamId}/fees/import`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rows }),
    }),
  );

const query = <Row extends object>(
  run: (sql: SqlClient.SqlClient) => Effect.Effect<ReadonlyArray<object>, unknown>,
) =>
  runSeeded(SqlClient.SqlClient.asEffect().pipe(Effect.flatMap(run))) as Promise<
    ReadonlyArray<Row>
  >;

const counts = async (teamId: string) => {
  const rows = await query<{ fees: string; assignments: string }>(
    (sql) => sql`
      SELECT (SELECT count(*) FROM fees WHERE team_id = ${teamId})::text AS fees,
             (SELECT count(*) FROM fee_assignments fa JOIN fees f ON f.id = fa.fee_id
               WHERE f.team_id = ${teamId})::text AS assignments
    `,
  );
  return { fees: Number(rows[0]?.fees), assignments: Number(rows[0]?.assignments) };
};

describe('POST /teams/:teamId/fees/import', () => {
  it('creates manual custom fees with per-member amounts', async () => {
    const f = await seedFixture();
    sessionsStore.set('treasurer-token', f.treasurerUserId);

    const response = await postImport(f.team.id, 'treasurer-token', VALID_ROWS);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ feeCount: 2, assignmentCount: 3 });

    const fees = await query<{
      name: string;
      kind: string;
      target_scope: string;
      amount_minor: number;
    }>(
      (sql) => sql`
        SELECT name, kind, target_scope, amount_minor::int AS amount_minor FROM fees
         WHERE team_id = ${f.team.id} ORDER BY name
      `,
    );
    expect(fees).toEqual([
      { name: 'Fee A', kind: 'manual', target_scope: 'custom', amount_minor: 500 },
      { name: 'Fee B', kind: 'manual', target_scope: 'custom', amount_minor: 300 },
    ]);

    const assignments = await query<{ fee: string; member: string; amount_minor: number }>(
      (sql) => sql`
        SELECT f.name AS fee, fa.team_member_id::text AS member, fa.amount_minor::int AS amount_minor
          FROM fee_assignments fa JOIN fees f ON f.id = fa.fee_id
         WHERE f.team_id = ${f.team.id}
      `,
    );
    expect(assignments).toHaveLength(3);
    expect(assignments).toEqual(
      expect.arrayContaining([
        { fee: 'Fee A', member: f.aliceMemberId, amount_minor: 500 },
        { fee: 'Fee A', member: f.bobMemberId, amount_minor: 700 },
        { fee: 'Fee B', member: f.aliceMemberId, amount_minor: 300 },
      ]),
    );
  });

  it('one bad row (inactive member) gives 400 FeeImportInvalid and writes nothing', async () => {
    const f = await seedFixture();
    sessionsStore.set('treasurer-token', f.treasurerUserId);

    const response = await postImport(f.team.id, 'treasurer-token', [
      importRow(2, 'alice', 'Fee A', 500),
      importRow(3, 'bob', 'Fee A', 700),
      importRow(4, 'carol', 'Fee A', 500),
    ]);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body._tag).toBe('FeeImportInvalid');
    expect(body.errors).toEqual([{ line: 4, code: 'member_not_found' }]);
    expect(await counts(f.team.id)).toEqual({ fees: 0, assignments: 0 });
  });

  it('a database error on a later fee rolls back the earlier fees', async () => {
    const f = await seedFixture();
    sessionsStore.set('treasurer-token', f.treasurerUserId);

    // 1e19 passes AmountMinor (it is an integer) but overflows Postgres bigint,
    // so "Fee A" is inserted before the "Fee B" insert fails.
    const response = await postImport(f.team.id, 'treasurer-token', [
      importRow(2, 'alice', 'Fee A', 500),
      importRow(3, 'bob', 'Fee B', 10_000_000_000_000_000_000),
    ]);

    expect(response.status).toBe(500);
    expect(await counts(f.team.id)).toEqual({ fees: 0, assignments: 0 });
  });

  it('a re-upload is blocked by fee_exists until the fees are archived', async () => {
    const f = await seedFixture();
    sessionsStore.set('treasurer-token', f.treasurerUserId);

    expect((await postImport(f.team.id, 'treasurer-token', VALID_ROWS)).status).toBe(201);

    const again = await postImport(f.team.id, 'treasurer-token', VALID_ROWS);
    expect(again.status).toBe(400);
    expect((await again.json()).errors).toEqual([
      { line: 2, code: 'fee_exists' },
      { line: 3, code: 'fee_exists' },
      { line: 4, code: 'fee_exists' },
    ]);
    expect(await counts(f.team.id)).toEqual({ fees: 2, assignments: 3 });

    const feeIds = await query<{ id: Fee.FeeId }>(
      (sql) => sql`SELECT id FROM fees WHERE team_id = ${f.team.id}`,
    );
    await runSeeded(
      FeesRepository.asEffect().pipe(
        Effect.flatMap((fees) => Effect.forEach(feeIds, ({ id }) => fees.archive(id))),
      ),
    );

    expect((await postImport(f.team.id, 'treasurer-token', VALID_ROWS)).status).toBe(201);
  });

  it('a member without finance:manage_fees gets 403 and nothing is written', async () => {
    const f = await seedFixture();
    sessionsStore.set('plain-token', f.plainUserId);

    const response = await postImport(f.team.id, 'plain-token', VALID_ROWS);

    expect(response.status).toBe(403);
    expect((await response.json())._tag).toBe('FinanceForbidden');
    expect((await counts(f.team.id)).fees).toBe(0);
  });

  it('imports 1000 rows into 1000 fees', { timeout: 60_000 }, async () => {
    const f = await seedFixture();
    sessionsStore.set('treasurer-token', f.treasurerUserId);
    const rows = Array.from({ length: 1000 }, (_, i) =>
      importRow(i + 2, i % 2 === 0 ? 'alice' : 'bob', `Fee ${i}`, 100),
    );

    const started = Date.now();
    const response = await postImport(f.team.id, 'treasurer-token', rows);
    console.log(`importFees 1000 rows: ${Date.now() - started} ms`);

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ feeCount: 1000, assignmentCount: 1000 });
  });
});
