// Slice 1 ("Setup memberships") — MembershipPlansRepository against real Postgres.
// Pattern: `defaultRole.test.ts` (RolesRepository.setDefaultRole's own suite), which this
// repository's `setDefaultMembershipPlan` was modeled on — same transaction shape, same
// `FOR UPDATE` lock, same two-UPDATE dance to dodge the partial unique index.
//
// The first three describe blocks below are regression tests for a real hole in the pattern
// this code was copied from: `RolesRepository.setDefaultRole`'s `markDefaultQuery` has no
// `archived_at` guard at all (roles don't archive the same way), so a naive copy-paste onto
// membership plans would let an archived plan steal the default flag. See
// `MembershipPlansRepository.ts`'s own comments on `markDefaultQuery` and `archiveQuery`.

import { describe, expect, it } from '@effect/vitest';
import type { MembershipPlan, Team } from '@sideline/domain';
import { Deferred, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  MembershipPlansRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = (suffix: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`membership-plans-${suffix}`);
    return yield* createTeam(nextDiscordId(), user.id);
  });

type PlanRow = {
  id: string;
  team_id: string;
  name: string | null;
  is_default: boolean;
  archived_at: Date | null;
};

const getPlan = (id: MembershipPlan.MembershipPlanId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<PlanRow>`SELECT id, team_id, name, is_default, archived_at
        FROM membership_plans WHERE id = ${id}`,
    ),
    Effect.map((rows) => rows[0]),
  );

const getActiveDefaults = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          id: string;
        }>`SELECT id FROM membership_plans WHERE team_id = ${teamId} AND is_default = true AND archived_at IS NULL`,
    ),
  );

const getSeededDefault = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<PlanRow>`SELECT id, team_id, name, is_default, archived_at
        FROM membership_plans WHERE team_id = ${teamId} ORDER BY created_at ASC LIMIT 1`,
    ),
    Effect.map((rows) => rows[0]),
  );

const insertPlan = (
  teamId: Team.TeamId,
  name: string,
  overrides: Partial<{
    price_minor: number;
    price_per_training_minor: number;
    currency: string;
  }> = {},
) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertMembershipPlan({
        team_id: teamId,
        name: Option.some(name as MembershipPlan.MembershipPlanName),
        price_minor: (overrides.price_minor ?? 1000) as never,
        currency: (overrides.currency ?? 'CZK') as never,
        price_per_training_minor: (overrides.price_per_training_minor ?? 0) as never,
        expires_at: Option.none(),
      }),
    ),
  );

const setDefault = (id: MembershipPlan.MembershipPlanId, teamId: Team.TeamId) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.setDefaultMembershipPlan(id, teamId)),
  );

const archivePlan = (id: MembershipPlan.MembershipPlanId, teamId: Team.TeamId) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.archiveMembershipPlan(id, teamId)),
  );

// ---------------------------------------------------------------------------
// 1. Archived plan cannot become default (regression test)
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.setDefaultMembershipPlan — archived plan cannot become default', () => {
  it.effect(
    'refuses to promote an archived plan: 0 rows affected, the live default is untouched, ' +
      'exactly one active default remains. FAILS if `AND archived_at IS NULL` is removed from ' +
      "the mark statement — the clear-step would wipe A's flag and leave the team with ZERO " +
      'active defaults.',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('regr1');
        const planA = yield* getSeededDefault(team.id);
        const planB = yield* insertPlan(team.id, 'Plan B');
        yield* archivePlan(planB.id, team.id);

        const rowsAffected = yield* setDefault(planB.id, team.id);

        expect(rowsAffected).toBe(0);

        const rowA = yield* getPlan(planA?.id as MembershipPlan.MembershipPlanId);
        expect(rowA?.is_default).toBe(true);

        const activeDefaults = yield* getActiveDefaults(team.id);
        expect(activeDefaults).toHaveLength(1);
        expect(activeDefaults[0]?.id).toBe(planA?.id);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 2. Archive refuses the default plan, following the CURRENT flag
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.archiveMembershipPlan — refuses the default plan', () => {
  it.effect(
    'refuses to archive the current default: 0 rows affected, plan stays active and default',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('regr2a');
        const planA = yield* getSeededDefault(team.id);

        const rowsAffected = yield* archivePlan(
          planA?.id as MembershipPlan.MembershipPlanId,
          team.id,
        );

        expect(rowsAffected).toBe(0);
        const rowA = yield* getPlan(planA?.id as MembershipPlan.MembershipPlanId);
        expect(rowA?.archived_at).toBeNull();
        expect(rowA?.is_default).toBe(true);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'follows the CURRENT default flag, not the row history: once B is promoted, A (formerly ' +
      'default) archives fine',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('regr2b');
        const planA = yield* getSeededDefault(team.id);
        const planB = yield* insertPlan(team.id, 'Plan B');

        yield* setDefault(planB.id, team.id);
        const rowsAffected = yield* archivePlan(
          planA?.id as MembershipPlan.MembershipPlanId,
          team.id,
        );

        expect(rowsAffected).toBe(1);
        const rowA = yield* getPlan(planA?.id as MembershipPlan.MembershipPlanId);
        expect(rowA?.archived_at).not.toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 3. Concurrent setDefault serializes
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.setDefaultMembershipPlan — concurrency', () => {
  it.effect(
    'two CONCURRENT setDefaultMembershipPlan calls on the same team both succeed — exactly ' +
      'one active default row remains. FAILS with a 23505 unique violation if the FOR UPDATE ' +
      'lock is dropped from `setDefaultMembershipPlan` (the transaction alone does not ' +
      'serialize under READ COMMITTED).',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const team = yield* seedTeam('conc1');
            const planB = yield* insertPlan(team.id, 'Plan B');
            const planC = yield* insertPlan(team.id, 'Plan C');

            const repoA = yield* MembershipPlansRepository.asEffect();
            const sql2 = yield* secondTestPgClient;
            const repoB = yield* MembershipPlansRepository.asEffect().pipe(
              Effect.provide(MembershipPlansRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );

            // A third, independent connection grabs a `FOR UPDATE` lock across every plan row
            // of the team — the exact row set `lockTeamPlansQuery` itself locks — and holds it
            // via a `Deferred` barrier, so both calls below genuinely queue up behind it and are
            // released together, forcing real overlap rather than a lucky non-overlapping pair
            // of transactions. Same technique as `defaultRole.test.ts`'s test 7.
            const sql3 = yield* secondTestPgClient;
            const holding = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const barrierFiber = yield* Effect.forkChild(
              sql3.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(
                    () =>
                      sql3`SELECT id FROM membership_plans WHERE team_id = ${team.id} FOR UPDATE`,
                  ),
                  Effect.tap(() => Deferred.succeed(holding, undefined)),
                  Effect.tap(() => Deferred.await(release)),
                  Effect.asVoid,
                ),
              ),
            );
            yield* Deferred.await(holding);

            const fiberA = yield* Effect.forkChild(
              Effect.exit(repoA.setDefaultMembershipPlan(planB.id, team.id)),
            );
            const fiberB = yield* Effect.forkChild(
              Effect.exit(repoB.setDefaultMembershipPlan(planC.id, team.id)),
            );
            yield* Effect.sleep('100 millis');
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(barrierFiber);

            const exitA = yield* Fiber.join(fiberA);
            const exitB = yield* Fiber.join(fiberB);

            expect(exitA._tag).toBe('Success');
            expect(exitB._tag).toBe('Success');

            const activeDefaults = yield* getActiveDefaults(team.id);
            expect(activeDefaults).toHaveLength(1);
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 4/5. insertMembershipPlan self-healing vs. non-stealing
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.insertMembershipPlan — default self-healing', () => {
  it.effect('self-heals a defaultless team: the new plan comes back is_default true', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('heal1');
      const seeded = yield* getSeededDefault(team.id);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE membership_plans SET archived_at = now() WHERE id = ${seeded?.id}`;

      const created = yield* insertPlan(team.id, 'Plan B');

      expect(created.is_default).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('does NOT steal the default on a healthy team: the new plan is_default false', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('heal2');
      const created = yield* insertPlan(team.id, 'Plan B');

      expect(created.is_default).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 6. Duplicate name handling
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.insertMembershipPlan — name uniqueness', () => {
  it.effect(
    'a duplicate name differing only in case is rejected as MembershipPlanNameAlreadyTakenError',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('name1');
        yield* insertPlan(team.id, 'Adult membership');

        const result = yield* insertPlan(team.id, 'ADULT MEMBERSHIP').pipe(Effect.result);

        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as { _tag: string })._tag).toBe(
            'MembershipPlanNameAlreadyTakenError',
          );
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("an archived plan's name CAN be reused by a new active plan", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('name2');
      const planB = yield* insertPlan(team.id, 'Adult membership');
      yield* archivePlan(planB.id, team.id);

      const result = yield* insertPlan(team.id, 'Adult membership').pipe(Effect.result);

      expect(result._tag).toBe('Success');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 7. Cross-tenant scoping
// ---------------------------------------------------------------------------

describe('MembershipPlansRepository.findMembershipPlanByIdScoped — cross-tenant scoping', () => {
  it.effect("returns None for another team's plan id", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('scope1a');
      const teamB = yield* seedTeam('scope1b');
      const planA = yield* getSeededDefault(teamA.id);

      const found = yield* MembershipPlansRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.findMembershipPlanByIdScoped(planA?.id as MembershipPlan.MembershipPlanId, teamB.id),
        ),
      );

      expect(Option.isNone(found)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});
