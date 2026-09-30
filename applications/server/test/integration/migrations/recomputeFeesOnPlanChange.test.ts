// Migration test for `1793600000_recompute_fees_on_plan_change.ts`. Same split as its siblings:
// this file asserts the DDL the migration leaves behind — that the new trigger is STATEMENT-level
// and has BOTH transition tables, and that its function filters on the plan column. The
// BEHAVIOUR (a plan change re-pricing the open period, a bulk move doing it once, a past period
// staying frozen) lives in `test/integration/repositories/trainingPeriodCharges.test.ts`, where
// real members, real trainings and real attendance exist to bill.
//
// The widened `membership_plans_pricing_recompute_trg` WHEN clause is asserted in
// `membershipPlanFreeTrainings.test.ts`, next to the rest of that trigger's cases.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const triggerDef = (table: string, name: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ definition: string }>`
        SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = ${table} AND t.tgname = ${name}
      `,
    ),
  );

describe('team_members_plan_recompute_trg', () => {
  // DISCRIMINATOR between the two implementations of this fix. A per-row trigger would pass an
  // "it recomputes on a plan change" behaviour test just as well — and then run one full
  // `recompute_training_period_fees` per member of a bulk move, each of them three
  // `training_period_charges` calls, all inside one transaction holding the team-wide fees mutex.
  // FOR EACH STATEMENT is the whole reason this migration exists in the shape it does, so it is
  // asserted on the definition, not inferred from behaviour.
  it.effect('is an AFTER UPDATE STATEMENT trigger on team_members', () =>
    Effect.gen(function* () {
      const rows = yield* triggerDef('team_members', 'team_members_plan_recompute_trg');
      expect(rows).toHaveLength(1);
      const definition = rows[0]?.definition ?? '';
      expect(definition).toContain('AFTER UPDATE');
      expect(definition).toContain('FOR EACH STATEMENT');
      expect(definition).not.toContain('FOR EACH ROW');
    }).pipe(Effect.provide(TestLayer)),
  );

  // BOTH transition tables, not just NEW. Without OLD there is nothing to compare against, and
  // the only filter available becomes "did any team_members UPDATE happen" — which would take the
  // team-wide fees mutex on every Discord sync, every `active` toggle and every variable_symbol
  // edit. The `IS DISTINCT FROM` join that stands in for the WHEN clause a statement-level
  // trigger cannot have needs both sides.
  it.effect('references OLD TABLE and NEW TABLE', () =>
    Effect.gen(function* () {
      const definition =
        (yield* triggerDef('team_members', 'team_members_plan_recompute_trg'))[0]?.definition ?? '';
      expect(definition).toContain('OLD TABLE');
      expect(definition).toContain('NEW TABLE');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Only UPDATE. INSERT cannot owe anything (a new member has no attendance yet) and DELETE
  // cascades into `event_attendance`, whose own trigger already recomputes — so widening this to
  // INSERT OR DELETE would buy nothing and put the fees mutex on the member-delete path.
  it.effect('does not fire on INSERT or DELETE', () =>
    Effect.gen(function* () {
      const rows = yield* triggerDef('team_members', 'team_members_plan_recompute_trg');
      // Asserted BEFORE the exclusions — two `not.toContain`s pass vacuously against the empty
      // string a missing trigger yields, which is exactly the regression this file must catch.
      expect(rows).toHaveLength(1);
      const definition = rows[0]?.definition ?? '';
      expect(definition).not.toContain('INSERT');
      expect(definition).not.toContain('DELETE');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The function body carries the filter and the lock order, and neither is visible in the
  // trigger definition. `IS DISTINCT FROM` on the plan column is what keeps an unrelated
  // `team_members` write free; `ORDER BY` is the total order that stops two cross-team statements
  // deadlocking (40P01) on the fees mutex — see AGENTS.md invariant 2.
  it.effect('filters on membership_plan_id and takes the teams in a fixed order', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ prosrc: string }>`
        SELECT prosrc FROM pg_proc WHERE proname = 'team_members_plan_recompute'
      `;
      expect(rows).toHaveLength(1);
      const prosrc = rows[0]?.prosrc ?? '';
      expect(prosrc).toContain('membership_plan_id IS DISTINCT FROM');
      expect(prosrc).toContain('ORDER BY');
      expect(prosrc).toContain('recompute_training_period_fees');
      // CURRENT period only, exactly like `membership_plans_pricing_recompute`. A past period is
      // frozen by `recompute_training_period_fees`' own early return — this call site must not
      // try to name one.
      expect(prosrc).toContain('training_period_start(now()');
    }).pipe(Effect.provide(TestLayer)),
  );
});
