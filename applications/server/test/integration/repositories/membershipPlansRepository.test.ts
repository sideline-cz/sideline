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
import type { MembershipPlan, Team, TeamMember } from '@sideline/domain';
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  MembershipPlansRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
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

// ---------------------------------------------------------------------------
// Slice 2 ("Setup memberships") — findMemberSelection, selectMembershipPlan,
// setSelectionDeadline
// ---------------------------------------------------------------------------

const findMemberSelection = (memberId: TeamMember.TeamMemberId, teamId: Team.TeamId) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findMemberSelection(memberId, teamId)),
  );

const selectMembershipPlan = (input: {
  member_id: TeamMember.TeamMemberId;
  team_id: Team.TeamId;
  plan_id: MembershipPlan.MembershipPlanId;
}) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.selectMembershipPlan(input)),
  );

const setSelectionDeadline = (teamId: Team.TeamId, deadline: Option.Option<DateTime.Utc>) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.setSelectionDeadline(teamId, deadline)),
  );

const addMember = (teamId: Team.TeamId, suffix: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(`membership-selection-${suffix}`);
    return yield* createTeamMember(teamId, user.id);
  });

const getMemberColumn = (memberId: TeamMember.TeamMemberId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          membership_plan_id: string | null;
        }>`SELECT membership_plan_id FROM team_members WHERE id = ${memberId}`,
    ),
    Effect.map((rows) => rows[0]?.membership_plan_id ?? null),
  );

const setMemberActive = (memberId: TeamMember.TeamMemberId, active: boolean) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) => sql`UPDATE team_members SET active = ${active} WHERE id = ${memberId}`),
  );

const countTeamSettings = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) =>
        sql<{
          count: string;
        }>`SELECT count(*) FROM team_settings WHERE team_id = ${teamId}`,
    ),
    Effect.map((rows) => Number(rows[0]?.count ?? '0')),
  );

describe('MembershipPlansRepository.findMemberSelection', () => {
  it.effect('a member who never chose a plan reads back membership_plan_id as None', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel-find1');
      const member = yield* addMember(team.id, 'find1');

      const found = yield* findMemberSelection(member.id, team.id);

      expect(Option.isSome(found)).toBe(true);
      if (Option.isSome(found)) {
        expect(Option.isNone(found.value.membership_plan_id)).toBe(true);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a member who chose plan B reads back Some(B)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel-find2');
      const member = yield* addMember(team.id, 'find2');
      const planB = yield* insertPlan(team.id, 'Plan B');

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });
      expect(rowsAffected).toBe(1);

      const found = yield* findMemberSelection(member.id, team.id);

      expect(Option.isSome(found)).toBe(true);
      if (Option.isSome(found)) {
        expect(Option.isSome(found.value.membership_plan_id)).toBe(true);
        if (Option.isSome(found.value.membership_plan_id)) {
          expect(found.value.membership_plan_id.value).toBe(planB.id);
        }
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a team with no deadline reads back membership_selection_deadline as None', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel-find3');
      const member = yield* addMember(team.id, 'find3');

      const found = yield* findMemberSelection(member.id, team.id);

      expect(Option.isSome(found)).toBe(true);
      if (Option.isSome(found)) {
        expect(Option.isNone(found.value.membership_selection_deadline)).toBe(true);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'a team with a deadline reads it back as Some(DateTime) — guards the ' +
      'DateTimeFromDate vs DateTimeFromIsoString decode mismatch',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('sel-find4');
        const member = yield* addMember(team.id, 'find4');
        const deadline = DateTime.add(DateTime.nowUnsafe(), { days: 7 });
        yield* setSelectionDeadline(team.id, Option.some(deadline));

        const found = yield* findMemberSelection(member.id, team.id);

        expect(Option.isSome(found)).toBe(true);
        if (Option.isSome(found)) {
          const decoded = found.value.membership_selection_deadline;
          expect(Option.isSome(decoded)).toBe(true);
          if (Option.isSome(decoded)) {
            expect(DateTime.toEpochMillis(decoded.value)).toBe(DateTime.toEpochMillis(deadline));
          }
        }
      }).pipe(Effect.provide(TestLayer)),
  );

  // Regression test for the review fix: `findMemberSelectionQuery` used to scope by
  // `tm.id` alone with no `team_id` — safe only because both call sites happened to pass
  // the caller's own team id. A foreign team id must read back None, same as
  // `findMembershipPlanByIdScoped`'s cross-tenant test above.
  it.effect("a foreign team's id reads back None even for a real member id", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('sel-scope-a');
      const teamB = yield* seedTeam('sel-scope-b');
      const member = yield* addMember(teamA.id, 'scope');

      const found = yield* findMemberSelection(member.id, teamB.id);

      expect(Option.isNone(found)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Regression test for the review fix: the query now requires `tm.active` too, so a
  // deactivated member reads back None instead of their stale selection.
  it.effect('a deactivated member reads back None', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel-inactive');
      const member = yield* addMember(team.id, 'inactive');
      yield* setMemberActive(member.id, false);

      const found = yield* findMemberSelection(member.id, team.id);

      expect(Option.isNone(found)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipPlansRepository.selectMembershipPlan', () => {
  it.effect('no deadline, active same-team plan -> 1 row, column written', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel1');
      const member = yield* addMember(team.id, 's1');
      const planB = yield* insertPlan(team.id, 'Plan B');

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(1);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a deadline in the future -> 1 row', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel2');
      const member = yield* addMember(team.id, 's2');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* setSelectionDeadline(
        team.id,
        Option.some(DateTime.add(DateTime.nowUnsafe(), { days: 1 })),
      );

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(1);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a deadline in the PAST -> 0 rows, column unchanged', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel3');
      const member = yield* addMember(team.id, 's3');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* setSelectionDeadline(
        team.id,
        Option.some(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 })),
      );

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(0);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a plan belonging to ANOTHER team -> 0 rows, column unchanged (tenancy)', () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('sel4a');
      const teamB = yield* seedTeam('sel4b');
      const member = yield* addMember(teamA.id, 's4');
      const planB = yield* insertPlan(teamB.id, 'Plan B');

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: teamA.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(0);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an ARCHIVED plan -> 0 rows', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel5');
      const member = yield* addMember(team.id, 's5');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* archivePlan(planB.id, team.id);

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(0);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an unknown random UUID plan id -> 0 rows, and no foreign-key error', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel6');
      const member = yield* addMember(team.id, 's6');

      const result = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: '00000000-0000-0000-0000-000000000000' as MembershipPlan.MembershipPlanId,
      }).pipe(Effect.result);

      expect(result._tag).toBe('Success');
      if (result._tag === 'Success') {
        expect(result.success).toBe(0);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a DIFFERENT member's id in the same team -> only that member's row changes", () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel7');
      const memberA = yield* addMember(team.id, 's7a');
      const memberB = yield* addMember(team.id, 's7b');
      const planB = yield* insertPlan(team.id, 'Plan B');

      const rowsAffected = yield* selectMembershipPlan({
        member_id: memberA.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(1);
      const columnA = yield* getMemberColumn(memberA.id);
      const columnB = yield* getMemberColumn(memberB.id);
      expect(columnA).toBe(planB.id);
      expect(columnB).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an INACTIVE member -> 0 rows', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel8');
      const member = yield* addMember(team.id, 's8');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* setMemberActive(member.id, false);

      const rowsAffected = yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      expect(rowsAffected).toBe(0);
      const column = yield* getMemberColumn(member.id);
      expect(column).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipPlansRepository.setSelectionDeadline', () => {
  it.effect('sets the deadline on teams', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('deadline1');
      const deadline = DateTime.add(DateTime.nowUnsafe(), { days: 3 });

      yield* setSelectionDeadline(team.id, Option.some(deadline));

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{
        membership_selection_deadline: Date | null;
      }>`SELECT membership_selection_deadline FROM teams WHERE id = ${team.id}`;

      expect(rows[0]?.membership_selection_deadline).not.toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'Option.none() clears the deadline back to NULL, reopening selection — a select that ' +
      'returned 0 rows now returns 1',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('deadline2');
        const member = yield* addMember(team.id, 'd2');
        const planB = yield* insertPlan(team.id, 'Plan B');
        yield* setSelectionDeadline(
          team.id,
          Option.some(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 })),
        );

        const closedAttempt = yield* selectMembershipPlan({
          member_id: member.id,
          team_id: team.id,
          plan_id: planB.id,
        });
        expect(closedAttempt).toBe(0);

        yield* setSelectionDeadline(team.id, Option.none());

        const sql = yield* SqlClient.SqlClient.asEffect();
        const rows = yield* sql<{
          membership_selection_deadline: Date | null;
        }>`SELECT membership_selection_deadline FROM teams WHERE id = ${team.id}`;
        expect(rows[0]?.membership_selection_deadline).toBeNull();

        const reopenedAttempt = yield* selectMembershipPlan({
          member_id: member.id,
          team_id: team.id,
          plan_id: planB.id,
        });
        expect(reopenedAttempt).toBe(1);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('setting the deadline does NOT create a team_settings row', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('deadline3');

      yield* setSelectionDeadline(
        team.id,
        Option.some(DateTime.add(DateTime.nowUnsafe(), { days: 1 })),
      );

      const count = yield* countTeamSettings(team.id);
      expect(count).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});
