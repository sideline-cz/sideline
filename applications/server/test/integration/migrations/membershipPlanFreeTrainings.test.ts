// Migration test for `1793400000_membership_plan_free_trainings.ts` as amended by the ALL-TIME
// allowance migration. Same split as `trainingPeriodFees.test.ts`: this file asserts the DDL the
// migrations leave behind — the renamed column's shape, its CHECK, the anchor column, the two
// triggers' shapes and WHEN clauses, and the re-stamp rule. The CHARGE behaviour (allowance
// consumed in an earlier period, carried forward, never refreshed) lives in
// `test/integration/repositories/trainingPeriodCharges.test.ts`, where a real member, a real
// training and real attendance exist to bill.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('plan-free-trainings-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ team }) => team),
);

// A plainly-past instant. Every anchor assertion below compares against THIS value, never against
// `now()` minus a window, so a slow CI box cannot make the test flap.
const OLD_ANCHOR = new Date(Date.UTC(2020, 0, 1, 0, 0, 0));

/** Seeds a team and returns its seeded default plan's id. */
const seedPlan = Effect.gen(function* () {
  const team = yield* seedTeam;
  const sql = yield* SqlClient.SqlClient.asEffect();
  const rows = yield* sql<{ id: string }>`
    SELECT id::text AS id FROM membership_plans WHERE team_id = ${team.id}
  `;
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('expected a seeded default plan');
  return { team, planId: id };
});

/** Writes `free_trainings_anchor_at` directly. Raw SQL on purpose: the column has no application
 * writer at all, which is exactly why it was chosen as the anchor. Fires NEITHER trigger — the
 * BEFORE one watches `free_trainings_included`, the AFTER one watches the two pricing columns. */
const setPlanAnchor = (planId: string, at: Date) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`UPDATE membership_plans SET free_trainings_anchor_at = ${at} WHERE id = ${planId}`,
    ),
  );

const readAnchor = (planId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<{ free_trainings_anchor_at: Date }>`
        SELECT free_trainings_anchor_at FROM membership_plans WHERE id = ${planId}
      `,
    ),
    Effect.map((rows) => {
      const at = rows[0]?.free_trainings_anchor_at;
      if (at === undefined) throw new Error('expected a plan row');
      return new Date(at).getTime();
    }),
  );

const setAllowance = (planId: string, value: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`UPDATE membership_plans SET free_trainings_included = ${value} WHERE id = ${planId}`,
    ),
  );

describe('membership_plans.free_trainings_included', () => {
  // DISCRIMINATOR: a rename, not an add-a-second-column implementation. An implementation that
  // added `free_trainings_included` alongside the old column would pass every other case here.
  it.effect('the old free_trainings_per_period column is gone', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_per_period'
      `;
      expect(cols).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('free_trainings_included is NOT NULL and defaults to 0', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ is_nullable: string; column_default: string | null }>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_included'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.is_nullable).toBe('NO');
      expect(cols[0]?.column_default).toContain('0');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The seed trigger `seed_default_membership_plan_trg` (1792800000) does not mention the
  // column, so a team created after this migration exercises the DEFAULT — the same value a
  // pre-existing row was backfilled with. Zero is the only safe backfill: any other value would
  // silently discount every already-priced plan the moment this migration ran.
  it.effect('a plan created without the column lands on 0', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ free_trainings_included: number }>`
        SELECT free_trainings_included FROM membership_plans WHERE team_id = ${team.id}
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.free_trainings_included)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a negative allowance raises 23514', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          UPDATE membership_plans SET free_trainings_included = -1 WHERE team_id = ${team.id}
        `,
      );
      expect(result._tag).toBe('Failure');
      expect(JSON.stringify(result).toLowerCase()).toContain('23514');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The allowance is deliberately allowed on a plan that charges nothing per training: the
  // `price_per_training_minor > 0` gate in `training_period_charges` already makes it a no-op
  // there, and a constraint would reject the legitimate "set the allowance, then set the price"
  // edit order.
  it.effect('an allowance on a plan with no per-training price is accepted', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* sql`
        UPDATE membership_plans
        SET free_trainings_included = 4, price_per_training_minor = 0
        WHERE team_id = ${team.id}
      `;
      const rows = yield* sql<{ free_trainings_included: number }>`
        SELECT free_trainings_included FROM membership_plans WHERE team_id = ${team.id}
      `;
      expect(Number(rows[0]?.free_trainings_included)).toBe(4);
    }).pipe(Effect.provide(TestLayer)),
  );

  // Only the DEFAULT is asserted, deliberately. A "a pre-existing plan is backfilled to its
  // created_at" case is unwritable here: any row a test can create is inserted AFTER the
  // migration ran, so it takes `DEFAULT now()` while `created_at` defaults to the same
  // transaction's `now()` — the assertion would be `now() = now()` and would stay green with the
  // backfill UPDATE deleted outright.
  it.effect('free_trainings_anchor_at is NOT NULL and defaults to now()', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ is_nullable: string; column_default: string | null }>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_anchor_at'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.is_nullable).toBe('NO');
      expect(cols[0]?.column_default).toContain('now()');
    }).pipe(Effect.provide(TestLayer)),
  );

  // `CREATE OR REPLACE FUNCTION` with a different argument count creates a SECOND function and
  // silently leaves the old body live for the old arity. Nothing else in this suite would notice.
  it.effect('training_period_charges is not overloaded', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  // `prosrc` is stored as TEXT, so unlike the CHECK expression and the trigger's WHEN clause it
  // does NOT follow the column rename — the migration has to replace the whole body. This is the
  // assertion that it did.
  it.effect('training_period_charges reads the renamed column and the anchor', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ prosrc: string }>`
        SELECT prosrc FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      const prosrc = rows[0]?.prosrc ?? '';
      expect(prosrc).toContain('free_trainings_included');
      expect(prosrc).toContain('free_trainings_anchor_at');
      expect(prosrc).not.toContain('free_trainings_per_period');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('membership_plans_pricing_recompute_trg', () => {
  it.effect('exists as an AFTER UPDATE row trigger on membership_plans', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ tgname: string; definition: string }>`
        SELECT t.tgname, pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'membership_plans'
          AND t.tgname = 'membership_plans_pricing_recompute_trg'
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.definition).toContain('AFTER UPDATE');
      expect(rows[0]?.definition).toContain('FOR EACH ROW');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The WHEN clause is the whole safety argument for this trigger: it must fire on the two
  // columns `training_period_charges` reads and on NOTHING else, or renaming a plan or moving
  // its expiry would take the team-wide `fees` lock that `recompute_training_period_fees` takes.
  //
  // DISCRIMINATOR, twice over. `pg_trigger.tgqual` is a node tree, so the WHEN clause is supposed
  // to FOLLOW the column rename with no re-issue; if it did not, this assertion is what catches
  // it and the migration must re-issue the trigger. And the `free_trainings_anchor_at` exclusion
  // pins the "the AFTER trigger must not watch the anchor" argument: watching it would make a
  // non-money column take the team-wide fees mutex, and would fire off a value the BEFORE trigger
  // just wrote in the same statement.
  it.effect('fires only on the two columns that feed the charge', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ definition: string }>`
        SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'membership_plans'
          AND t.tgname = 'membership_plans_pricing_recompute_trg'
      `;
      const definition = rows[0]?.definition ?? '';
      expect(definition).toContain('price_per_training_minor');
      expect(definition).toContain('free_trainings_included');
      expect(definition).not.toContain('free_trainings_per_period');
      expect(definition).not.toContain('free_trainings_anchor_at');
      expect(definition).not.toContain('expires_at');
      expect(definition).not.toContain('archived_at');
    }).pipe(Effect.provide(TestLayer)),
  );

  // A plan rename must not reach the money path at all. Asserted through `fees` rather than the
  // trigger definition: this is the behaviour the WHEN clause exists to produce.
  it.effect('a rename creates no training fee', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* sql`UPDATE membership_plans SET name = 'Renamed' WHERE team_id = ${team.id}`;
      const fees = yield* sql<{ id: string }>`
        SELECT id FROM fees WHERE team_id = ${team.id} AND kind = 'training'
      `;
      expect(fees).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// The anchor is what makes the allowance all-time WITHOUT a consumption ledger: everything the
// member burned since the anchor's PERIOD counts against them, forever. Which edits re-stamp it is
// therefore the whole leak surface, and every case below is about one transition.
describe('membership_plans_stamp_free_trainings_anchor_trg', () => {
  it.effect('is a BEFORE UPDATE row trigger', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ definition: string }>`
        SELECT pg_get_triggerdef(t.oid) AS definition
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'membership_plans'
          AND t.tgname = 'membership_plans_stamp_free_trainings_anchor_trg'
      `;
      expect(rows).toHaveLength(1);
      // BEFORE, not AFTER: an AFTER trigger cannot assign NEW.*.
      expect(rows[0]?.definition).toContain('BEFORE UPDATE');
      expect(rows[0]?.definition).toContain('FOR EACH ROW');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The motivating flow: a club that has been training for months prices its seeded default plan
  // and sets an allowance. Without the re-stamp every member's prior consumption is already above
  // N and nobody ever gets the allowance.
  it.effect('setting an allowance from 0 re-stamps the anchor', () =>
    Effect.gen(function* () {
      const { planId } = yield* seedPlan;
      yield* setPlanAnchor(planId, OLD_ANCHOR);

      yield* setAllowance(planId, 4);

      const anchor = yield* readAnchor(planId);
      expect(anchor).toBeGreaterThan(OLD_ANCHOR.getTime());
      // Within a generous window of "now" — the point is that it moved to the EDIT, not that the
      // clock is precise.
      expect(Math.abs(anchor - Date.now())).toBeLessThan(60_000);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The PO's explicit carve-out, with a stated reason: lowering 5 -> 3 must not hand a fresh 3 to
  // members who already burned all 5.
  it.effect('LOWERING the allowance does NOT re-stamp', () =>
    Effect.gen(function* () {
      const { planId } = yield* seedPlan;
      yield* setAllowance(planId, 4);
      yield* setPlanAnchor(planId, OLD_ANCHOR);

      yield* setAllowance(planId, 2);

      expect(yield* readAnchor(planId)).toBe(OLD_ANCHOR.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR between the two readings of the re-stamp rule. The chosen condition is the
  // CLOSED one — `WHEN (OLD.free_trainings_included = 0 AND NEW.free_trainings_included > 0)` — so
  // 2 -> 5 does NOT re-stamp: the member's budget rises to 5, the 2 they already burned still
  // count, free_left = 3. This is the ONE case that inverts if the rule is ever re-read as "any
  // change ending non-zero".
  it.effect('RAISING a non-zero allowance does NOT re-stamp', () =>
    Effect.gen(function* () {
      const { planId } = yield* seedPlan;
      yield* setAllowance(planId, 2);
      yield* setPlanAnchor(planId, OLD_ANCHOR);

      yield* setAllowance(planId, 5);

      expect(yield* readAnchor(planId)).toBe(OLD_ANCHOR.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('clearing the allowance to 0 does NOT re-stamp', () =>
    Effect.gen(function* () {
      const { planId } = yield* seedPlan;
      yield* setAllowance(planId, 4);
      yield* setPlanAnchor(planId, OLD_ANCHOR);

      yield* setAllowance(planId, 0);

      expect(yield* readAnchor(planId)).toBe(OLD_ANCHOR.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // Accepted leak, stated for the record: `4 -> 0 -> 4` DOES re-anchor everyone. Two deliberate,
  // manager-only, visible edits — same class as archive-and-recreate. This case only pins that no
  // OTHER edit moves the anchor.
  it.effect('a rename or price-only edit does NOT re-stamp', () =>
    Effect.gen(function* () {
      const { planId } = yield* seedPlan;
      yield* setAllowance(planId, 4);
      yield* setPlanAnchor(planId, OLD_ANCHOR);
      const sql = yield* SqlClient.SqlClient.asEffect();

      yield* sql`UPDATE membership_plans SET name = 'Renamed' WHERE id = ${planId}`;
      expect(yield* readAnchor(planId)).toBe(OLD_ANCHOR.getTime());

      yield* sql`
        UPDATE membership_plans SET price_per_training_minor = 100 WHERE id = ${planId}
      `;
      expect(yield* readAnchor(planId)).toBe(OLD_ANCHOR.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );
});
