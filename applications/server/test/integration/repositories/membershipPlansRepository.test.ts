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
import { daysFromNow, readSeasons, setSeasons } from '../seasonFixtures.js';

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
    free_trainings_included: number;
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
        free_trainings_included: Option.some((overrides.free_trainings_included ?? 0) as never),
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

  // The SOURCE of this value moved: it is the GOVERNING season's raw `selection_deadline` now,
  // not `teams.membership_selection_deadline`. Reseeded explicitly through a season so the case
  // cannot pass merely because the legacy column happens to be NULL too.
  it.effect('a team with no deadline reads back membership_selection_deadline as None', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('sel-find3');
      const member = yield* addMember(team.id, 'find3');
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(-30) }]);

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
  // TWO reads, and that is the point. `teams.membership_selection_deadline` is now the LEGACY
  // MIRROR (Release-A rollback safety, deleted in Release B); the season's column is where the
  // value actually lives. Asserting only the mirror would stay green with the season write
  // dropped outright, which would silently break the gate the mirror cannot answer.
  it.effect('writes the CURRENT season and mirrors it into the legacy teams column', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('deadline1');
      const deadline = DateTime.add(DateTime.nowUnsafe(), { days: 3 });

      yield* setSelectionDeadline(team.id, Option.some(deadline));

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{
        membership_selection_deadline: Date | null;
      }>`SELECT membership_selection_deadline FROM teams WHERE id = ${team.id}`;
      expect(rows[0]?.membership_selection_deadline).not.toBeNull();
      expect(rows[0]?.membership_selection_deadline?.getTime()).toBe(
        Number(DateTime.toEpochMillis(deadline)),
      );

      const seasons = yield* readSeasons(team.id);
      expect(seasons, 'the seeded season is written in place, not duplicated').toHaveLength(1);
      expect(seasons[0]?.selection_deadline?.getTime()).toBe(
        Number(DateTime.toEpochMillis(deadline)),
      );
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
        // Sibling read: the SEASON is what the gate consults. A clear that only reached the legacy
        // mirror would leave selection shut while this column said otherwise.
        const seasons = yield* readSeasons(team.id);
        expect(seasons[0]?.selection_deadline).toBeNull();

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

// ---------------------------------------------------------------------------
// Slice 3 ("Add CRUD for managing membership assigned members") — `assignMembershipPlan`,
// `reassignMembershipPlan` and `findPlanAssignments` (plan Task 2).
//
// The helpers below are deliberately explicit about the input shape: they are the only place
// this suite pins the repository signatures, so a rename (`plan_id` → `planId`) or a widening
// (`from_plan_id` off `Option`) has to go red here.
// ---------------------------------------------------------------------------

const assignMembershipPlan = (input: {
  member_id: TeamMember.TeamMemberId;
  team_id: Team.TeamId;
  plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
}) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.assignMembershipPlan(input)),
  );

const reassignMembershipPlan = (input: {
  team_id: Team.TeamId;
  from_plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
  to_plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
}) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.reassignMembershipPlan(input)),
  );

const findPlanAssignments = (teamId: Team.TeamId) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findPlanAssignments(teamId)),
  );

describe('MembershipPlansRepository.assignMembershipPlan', () => {
  it.effect('assigns a plan to ANOTHER member: 1 row, the column holds that plan id', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('assign1');
      const member = yield* addMember(team.id, 'a1');
      const planB = yield* insertPlan(team.id, 'Plan B');

      const rowsAffected = yield* assignMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: Option.some(planB.id),
      });

      expect(rowsAffected).toBe(1);
      expect(yield* getMemberColumn(member.id)).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('plan_id None clears the column back to NULL: 1 row, column null', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('assign2');
      const member = yield* addMember(team.id, 'a2');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });

      const rowsAffected = yield* assignMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: Option.none(),
      });

      expect(rowsAffected).toBe(1);
      expect(yield* getMemberColumn(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // §B.2 — THE divergence. The deadline binds MEMBERS, not the treasurer. Both calls live in
  // one test on purpose: asserting only the 1 would stay green if the deadline clause were
  // copied into the manager UPDATE and the self-service one silently dropped.
  it.effect(
    'BYPASSES a passed deadline: the manager assign writes 1 row while selectMembershipPlan ' +
      'under the same deadline writes 0',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('assign3');
        const member = yield* addMember(team.id, 'a3');
        const planB = yield* insertPlan(team.id, 'Plan B');
        yield* setSelectionDeadline(
          team.id,
          Option.some(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 })),
        );

        const selfService = yield* selectMembershipPlan({
          member_id: member.id,
          team_id: team.id,
          plan_id: planB.id,
        });
        expect(selfService, 'the member themselves is still locked out').toBe(0);

        const rowsAffected = yield* assignMembershipPlan({
          member_id: member.id,
          team_id: team.id,
          plan_id: Option.some(planB.id),
        });

        expect(rowsAffected, 'the manager is not').toBe(1);
        expect(yield* getMemberColumn(member.id)).toBe(planB.id);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('refuses an ARCHIVED plan: 0 rows, column unchanged (§B.7)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('assign4');
      const member = yield* addMember(team.id, 'a4');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* archivePlan(planB.id, team.id);

      const rowsAffected = yield* assignMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: Option.some(planB.id),
      });

      expect(rowsAffected).toBe(0);
      expect(yield* getMemberColumn(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('refuses an INACTIVE member: 0 rows', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('assign5');
      const member = yield* addMember(team.id, 'a5');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* setMemberActive(member.id, false);

      const rowsAffected = yield* assignMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: Option.some(planB.id),
      });

      expect(rowsAffected).toBe(0);
      expect(yield* getMemberColumn(member.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("refuses a member of ANOTHER team: 0 rows, that member's column unchanged", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('assign6a');
      const teamB = yield* seedTeam('assign6b');
      const memberB = yield* addMember(teamB.id, 'a6');
      const planA = yield* insertPlan(teamA.id, 'Plan A');

      const rowsAffected = yield* assignMembershipPlan({
        member_id: memberB.id,
        team_id: teamA.id,
        plan_id: Option.some(planA.id),
      });

      expect(rowsAffected).toBe(0);
      expect(yield* getMemberColumn(memberB.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // The case the `plan_id === null` short-circuit gets wrong: an implementation that writes
  // `(${input.plan_id === null} OR EXISTS (...))` correctly still needs the `tm.active` and
  // `tm.team_id` guards OUTSIDE that disjunct, or a clear becomes unguarded.
  it.effect('clearing to NULL still requires an ACTIVE, in-team member: 0 rows', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('assign7');
      const member = yield* addMember(team.id, 'a7');
      const planB = yield* insertPlan(team.id, 'Plan B');
      yield* selectMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: planB.id,
      });
      yield* setMemberActive(member.id, false);

      const rowsAffected = yield* assignMembershipPlan({
        member_id: member.id,
        team_id: team.id,
        plan_id: Option.none(),
      });

      expect(rowsAffected).toBe(0);
      expect(
        yield* getMemberColumn(member.id),
        "the inactive member's stale selection must survive",
      ).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipPlansRepository.reassignMembershipPlan', () => {
  it.effect('moves every member on A onto B and leaves everyone else alone', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk1');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');
      const onA1 = yield* addMember(team.id, 'b1-a1');
      const onA2 = yield* addMember(team.id, 'b1-a2');
      const onA3 = yield* addMember(team.id, 'b1-a3');
      const onB = yield* addMember(team.id, 'b1-b');
      const neverPicked = yield* addMember(team.id, 'b1-none');
      for (const m of [onA1, onA2, onA3]) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }
      yield* selectMembershipPlan({ member_id: onB.id, team_id: team.id, plan_id: planB.id });

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      });

      expect(moved).toBe(3);
      expect(yield* getMemberColumn(onA1.id)).toBe(planB.id);
      expect(yield* getMemberColumn(onA2.id)).toBe(planB.id);
      expect(yield* getMemberColumn(onA3.id)).toBe(planB.id);
      expect(yield* getMemberColumn(onB.id)).toBe(planB.id);
      expect(yield* getMemberColumn(neverPicked.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // §B.5 — THE MOST IMPORTANT TEST IN THIS BLOCK. Written with `=` instead of
  // `IS NOT DISTINCT FROM`, the implementation matches ZERO rows here and returns a cheerful
  // `0`, which the handler reports as a legitimate no-op success (§B.8). Nothing else — not
  // the API tests' status codes, not the UI — catches that.
  it.effect(
    'NULL source: from None sweeps the members who NEVER picked onto B. FAILS if the SQL ' +
      'compares the source with `=` instead of `IS NOT DISTINCT FROM`',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('bulk2');
        const planB = yield* insertPlan(team.id, 'Plan B');
        const neverPicked1 = yield* addMember(team.id, 'b2-n1');
        const neverPicked2 = yield* addMember(team.id, 'b2-n2');

        const moved = yield* reassignMembershipPlan({
          team_id: team.id,
          from_plan_id: Option.none(),
          to_plan_id: Option.some(planB.id),
        });

        expect(moved).toBe(2);
        expect(yield* getMemberColumn(neverPicked1.id)).toBe(planB.id);
        expect(yield* getMemberColumn(neverPicked2.id)).toBe(planB.id);
      }).pipe(Effect.provide(TestLayer)),
  );

  // §B.5 "three source populations, not two". Guards against a later "helpful"
  // `COALESCE(tm.membership_plan_id, (SELECT id ... WHERE is_default))`, which would double
  // every default-sourced move's blast radius.
  it.effect(
    "the DEFAULT plan's own id as source does NOT sweep the never-picked (NULL) members",
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('bulk3');
        const seededDefault = yield* getSeededDefault(team.id);
        const defaultId = seededDefault?.id as MembershipPlan.MembershipPlanId;
        const planB = yield* insertPlan(team.id, 'Plan B');
        const onDefault1 = yield* addMember(team.id, 'b3-d1');
        const onDefault2 = yield* addMember(team.id, 'b3-d2');
        const neverPicked1 = yield* addMember(team.id, 'b3-n1');
        const neverPicked2 = yield* addMember(team.id, 'b3-n2');
        for (const m of [onDefault1, onDefault2]) {
          yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: defaultId });
        }

        const moved = yield* reassignMembershipPlan({
          team_id: team.id,
          from_plan_id: Option.some(defaultId),
          to_plan_id: Option.some(planB.id),
        });

        expect(moved, 'only the two EXPLICIT picks of the default plan move').toBe(2);
        expect(yield* getMemberColumn(onDefault1.id)).toBe(planB.id);
        expect(yield* getMemberColumn(onDefault2.id)).toBe(planB.id);
        expect(yield* getMemberColumn(neverPicked1.id)).toBeNull();
        expect(yield* getMemberColumn(neverPicked2.id)).toBeNull();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('to None clears every member on A back to the team default (NULL)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk4');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const onA1 = yield* addMember(team.id, 'b4-a1');
      const onA2 = yield* addMember(team.id, 'b4-a2');
      for (const m of [onA1, onA2]) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.none(),
      });

      expect(moved).toBe(2);
      expect(yield* getMemberColumn(onA1.id)).toBeNull();
      expect(yield* getMemberColumn(onA2.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // Pins `IS DISTINCT FROM ${to}`. Postgres counts a same-value UPDATE as an affected row, so
  // without that guard this returns 3 and the UI toasts a phantom move.
  it.effect('source == target returns 0 and changes nothing', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk5');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const members = [
        yield* addMember(team.id, 'b5-1'),
        yield* addMember(team.id, 'b5-2'),
        yield* addMember(team.id, 'b5-3'),
      ];
      for (const m of members) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planA.id),
      });

      expect(moved).toBe(0);
      for (const m of members) {
        expect(yield* getMemberColumn(m.id)).toBe(planA.id);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  // None == None is the same guard on the other side of the NULL boundary: `IS DISTINCT FROM
  // NULL` must be false for a NULL column, so a "default -> default" sweep is also 0.
  it.effect('source None == target None returns 0', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk5b');
      const neverPicked = yield* addMember(team.id, 'b5b-n');

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.none(),
        to_plan_id: Option.none(),
      });

      expect(moved).toBe(0);
      expect(yield* getMemberColumn(neverPicked.id)).toBeNull();
    }).pipe(Effect.provide(TestLayer)),
  );

  // §B.5 — an ARCHIVED SOURCE is the whole point: those members silently fall back to the
  // default when billed, and sweeping them onto a real plan is the most valuable bulk case.
  // The SQL therefore carries NO predicate on the source plan at all.
  it.effect('an ARCHIVED source plan is allowed: its members still move onto B', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk6');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');
      const onA1 = yield* addMember(team.id, 'b6-1');
      const onA2 = yield* addMember(team.id, 'b6-2');
      for (const m of [onA1, onA2]) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }
      yield* archivePlan(planA.id, team.id);

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      });

      expect(moved).toBe(2);
      expect(yield* getMemberColumn(onA1.id)).toBe(planB.id);
      expect(yield* getMemberColumn(onA2.id)).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an ARCHIVED TARGET is refused: 0 rows, every column unchanged (§B.7)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk7');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');
      const onA1 = yield* addMember(team.id, 'b7-1');
      const onA2 = yield* addMember(team.id, 'b7-2');
      for (const m of [onA1, onA2]) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }
      yield* archivePlan(planB.id, team.id);

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      });

      expect(moved).toBe(0);
      expect(yield* getMemberColumn(onA1.id)).toBe(planA.id);
      expect(yield* getMemberColumn(onA2.id)).toBe(planA.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("a FOREIGN team's plan as TARGET is refused: 0 rows, columns unchanged", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('bulk8a');
      const teamB = yield* seedTeam('bulk8b');
      const planA = yield* insertPlan(teamA.id, 'Plan A');
      const foreignPlan = yield* insertPlan(teamB.id, 'Foreign plan');
      const member = yield* addMember(teamA.id, 'b8');
      yield* selectMembershipPlan({ member_id: member.id, team_id: teamA.id, plan_id: planA.id });

      const moved = yield* reassignMembershipPlan({
        team_id: teamA.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(foreignPlan.id),
      });

      expect(moved).toBe(0);
      expect(yield* getMemberColumn(member.id)).toBe(planA.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect("TENANCY: another team's members on the same-named plans are never touched", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('bulk9a');
      const teamB = yield* seedTeam('bulk9b');
      const planA1 = yield* insertPlan(teamA.id, 'Plan A');
      const planA2 = yield* insertPlan(teamA.id, 'Plan B');
      const planB1 = yield* insertPlan(teamB.id, 'Plan A');
      const memberA = yield* addMember(teamA.id, 'b9-a');
      const memberB = yield* addMember(teamB.id, 'b9-b');
      yield* selectMembershipPlan({ member_id: memberA.id, team_id: teamA.id, plan_id: planA1.id });
      yield* selectMembershipPlan({ member_id: memberB.id, team_id: teamB.id, plan_id: planB1.id });

      const moved = yield* reassignMembershipPlan({
        team_id: teamA.id,
        from_plan_id: Option.some(planA1.id),
        to_plan_id: Option.some(planA2.id),
      });

      expect(moved).toBe(1);
      expect(yield* getMemberColumn(memberA.id)).toBe(planA2.id);
      expect(yield* getMemberColumn(memberB.id)).toBe(planB1.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The source is deliberately unvalidated (§B.5). That is safe only because `tm.team_id`
  // scopes every counted row — a foreign uuid must therefore move nobody, never leak a count.
  it.effect("a FOREIGN team's plan id as SOURCE moves nobody: 0 rows", () =>
    Effect.gen(function* () {
      const teamA = yield* seedTeam('bulk10a');
      const teamB = yield* seedTeam('bulk10b');
      const planTarget = yield* insertPlan(teamA.id, 'Target');
      const foreignPlan = yield* insertPlan(teamB.id, 'Foreign plan');
      const memberB = yield* addMember(teamB.id, 'b10-b');
      yield* selectMembershipPlan({
        member_id: memberB.id,
        team_id: teamB.id,
        plan_id: foreignPlan.id,
      });

      const moved = yield* reassignMembershipPlan({
        team_id: teamA.id,
        from_plan_id: Option.some(foreignPlan.id),
        to_plan_id: Option.some(planTarget.id),
      });

      expect(moved).toBe(0);
      expect(yield* getMemberColumn(memberB.id)).toBe(foreignPlan.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('INACTIVE members on the source plan are not moved: 1 of 2 moves', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk11');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');
      const active = yield* addMember(team.id, 'b11-active');
      const inactive = yield* addMember(team.id, 'b11-inactive');
      for (const m of [active, inactive]) {
        yield* selectMembershipPlan({ member_id: m.id, team_id: team.id, plan_id: planA.id });
      }
      yield* setMemberActive(inactive.id, false);

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      });

      expect(moved).toBe(1);
      expect(yield* getMemberColumn(active.id)).toBe(planB.id);
      expect(yield* getMemberColumn(inactive.id)).toBe(planA.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('no match returns 0, never a failure (§B.8 — a no-op sweep is a success)', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk12');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');

      const result = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      }).pipe(Effect.result);

      expect(result._tag).toBe('Success');
      if (result._tag === 'Success') {
        expect(result.success).toBe(0);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('BYPASSES a passed deadline (§B.2): the bulk move still lands', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam('bulk13');
      const planA = yield* insertPlan(team.id, 'Plan A');
      const planB = yield* insertPlan(team.id, 'Plan B');
      const member = yield* addMember(team.id, 'b13');
      yield* selectMembershipPlan({ member_id: member.id, team_id: team.id, plan_id: planA.id });
      yield* setSelectionDeadline(
        team.id,
        Option.some(DateTime.subtract(DateTime.nowUnsafe(), { days: 1 })),
      );

      const moved = yield* reassignMembershipPlan({
        team_id: team.id,
        from_plan_id: Option.some(planA.id),
        to_plan_id: Option.some(planB.id),
      });

      expect(moved).toBe(1);
      expect(yield* getMemberColumn(member.id)).toBe(planB.id);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipPlansRepository.findPlanAssignments', () => {
  // One query, one shape — active members of THIS team only, with the raw FK as an Option.
  it.effect(
    'returns every ACTIVE member of the team and only that team; a never-picked member reads ' +
      'back None, a member on B reads back Some(B) and a member on an ARCHIVED plan still ' +
      'reads back that plan id',
    () =>
      Effect.gen(function* () {
        const team = yield* seedTeam('assignments1');
        const otherTeam = yield* seedTeam('assignments2');
        const planB = yield* insertPlan(team.id, 'Plan B');
        const planC = yield* insertPlan(team.id, 'Plan C');
        const neverPicked = yield* addMember(team.id, 'pa-none');
        const onB = yield* addMember(team.id, 'pa-b');
        const onArchived = yield* addMember(team.id, 'pa-archived');
        const inactive = yield* addMember(team.id, 'pa-inactive');
        const foreign = yield* addMember(otherTeam.id, 'pa-foreign');
        yield* selectMembershipPlan({ member_id: onB.id, team_id: team.id, plan_id: planB.id });
        yield* selectMembershipPlan({
          member_id: onArchived.id,
          team_id: team.id,
          plan_id: planC.id,
        });
        // The archived-plan row is the ONLY input to the dialog's "sweep everyone off the plan we
        // retired" option. A `LEFT JOIN membership_plans ... AND archived_at IS NULL` added here
        // later would make that option unreachable and nothing else in the stack would go red.
        yield* archivePlan(planC.id, team.id);
        yield* setMemberActive(inactive.id, false);

        const rows = yield* findPlanAssignments(team.id);

        const ids = rows.map((r) => r.member_id);
        expect(ids).toContain(neverPicked.id);
        expect(ids).toContain(onB.id);
        expect(ids, 'a member on an archived plan is still rostered').toContain(onArchived.id);
        expect(ids, 'inactive members are excluded').not.toContain(inactive.id);
        expect(ids, "another team's members are never returned").not.toContain(foreign.id);

        const planIdOf = (memberId: TeamMember.TeamMemberId) =>
          rows.find((r) => r.member_id === memberId)?.membership_plan_id;
        expect(planIdOf(neverPicked.id)).toEqual(Option.none());
        expect(planIdOf(onB.id)).toEqual(Option.some(planB.id));
        expect(planIdOf(onArchived.id)).toEqual(Option.some(planC.id));
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 13. Concurrent upsertNextSeason serializes — "Give a season real dates", case 44
// ---------------------------------------------------------------------------
//
// TDD: written BEFORE `upsertNextSeason` exists. Fails to compile until the repository exports it.

// `upsertNextSeason({ team_id, starts_at, deadline, expires_at })` is called on the repository
// directly below — each fiber needs its OWN repository instance over its OWN connection, so there
// is no shared helper to route through. `starts_at` must be in the future: that is a REQUEST
// validation enforced at the API layer (400 `SeasonStartNotInFuture`), not a DB constraint,
// because the DB cannot express "future relative to the request".

const futureSeasonCount = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ count: string }>`
        SELECT count(*)::text AS count FROM seasons
        WHERE team_id = ${teamId} AND starts_at > now()
      `,
    ),
    Effect.map((rows) => Number(rows[0]?.count)),
  );

describe('MembershipPlansRepository.upsertNextSeason — concurrency', () => {
  // THE RACE, stated: `upsertNextSeason` is a read-the-slot-then-write. Two concurrent calls with
  // DIFFERENT `startsAt` both find the slot empty and both INSERT — and `UNIQUE (team_id,
  // starts_at)` CANNOT fire, because the keys differ. The result is a second queued season that
  // the slot can never address again: invisible to `governing_season_id` (which only ever takes
  // the EARLIEST future season) and hidden by the UI (the "Start new season" trigger disappears
  // once one exists). A live row, wrong, and unreachable from every surface.
  //
  // THE FIX is three words — `SELECT 1 FROM teams WHERE id = $1 FOR UPDATE` as the transaction's
  // FIRST statement — which is the same team-row lock idiom this repository already uses.
  //
  // PROVE IT CAN FAIL (mandatory; a concurrency test that has never been watched failing is
  // theatre):
  //   1. delete that `FOR UPDATE` line from `upsertNextSeasonQuery`;
  //   2. re-run THIS FILE — the final assertion must go RED with a count of 2;
  //   3. restore the line and watch it go green.
  // Record both outputs. `api/finance.test.ts` cannot host this: it is a mock harness with no DB.
  it.effect(
    'two CONCURRENT upsertNextSeason calls with DIFFERENT startsAt leave exactly ONE future ' +
      'season. FAILS with two rows if the `SELECT 1 FROM teams ... FOR UPDATE` slot lock is ' +
      'dropped — the unique index cannot catch this one, because the keys differ.',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const team = yield* seedTeam('season-slot-conc');

            const repoA = yield* MembershipPlansRepository.asEffect();
            const sql2 = yield* secondTestPgClient;
            const repoB = yield* MembershipPlansRepository.asEffect().pipe(
              Effect.provide(MembershipPlansRepository.Default),
              Effect.provideService(SqlClient.SqlClient, sql2),
            );

            // A third connection holds the EXACT row the fix locks — the team row — behind a
            // `Deferred` barrier, so both calls genuinely queue up and are released together.
            // Without this they can simply not overlap and the test proves nothing. Same
            // technique as the `setDefaultMembershipPlan` case above.
            const sql3 = yield* secondTestPgClient;
            const holding = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const barrierFiber = yield* Effect.forkChild(
              sql3.withTransaction(
                Effect.Do.pipe(
                  Effect.tap(() => sql3`SELECT id FROM teams WHERE id = ${team.id} FOR UPDATE`),
                  Effect.tap(() => Deferred.succeed(holding, undefined)),
                  Effect.tap(() => Deferred.await(release)),
                  Effect.asVoid,
                ),
              ),
            );
            yield* Deferred.await(holding);

            const startsA = DateTime.add(DateTime.nowUnsafe(), { days: 30 });
            const startsB = DateTime.add(DateTime.nowUnsafe(), { days: 60 });
            const fiberA = yield* Effect.forkChild(
              Effect.exit(
                repoA.upsertNextSeason({
                  team_id: team.id,
                  starts_at: startsA,
                  deadline: Option.none(),
                  expires_at: Option.none(),
                }),
              ),
            );
            const fiberB = yield* Effect.forkChild(
              Effect.exit(
                repoB.upsertNextSeason({
                  team_id: team.id,
                  starts_at: startsB,
                  deadline: Option.none(),
                  expires_at: Option.none(),
                }),
              ),
            );
            yield* Effect.sleep('100 millis');
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(barrierFiber);

            const exitA = yield* Fiber.join(fiberA);
            const exitB = yield* Fiber.join(fiberB);

            // BOTH succeed — the slot is idempotent, so the loser is an UPDATE, not a 409.
            expect(exitA._tag).toBe('Success');
            expect(exitB._tag).toBe('Success');

            expect(
              yield* futureSeasonCount(team.id),
              'one slot, one row — a second queued season would be unreachable forever',
            ).toBe(1);
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});
