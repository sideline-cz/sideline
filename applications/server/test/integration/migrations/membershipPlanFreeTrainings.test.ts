// Migration test for `1793400000_membership_plan_free_trainings.ts`. Same split as
// `trainingPeriodFees.test.ts`: this file asserts the DDL the migration leaves behind — the
// column's shape, its CHECK, the backfill value on rows that predate it, and the existence and
// WHEN clause of the recompute trigger. The CHARGE behaviour (allowance consumed, partially
// consumed, fully covering) lives in
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

describe('membership_plans.free_trainings_per_period', () => {
  it.effect('is NOT NULL and defaults to 0', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ is_nullable: string; column_default: string | null }>`
        SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_per_period'
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
      const rows = yield* sql<{ free_trainings_per_period: number }>`
        SELECT free_trainings_per_period FROM membership_plans WHERE team_id = ${team.id}
      `;
      expect(rows).toHaveLength(1);
      expect(Number(rows[0]?.free_trainings_per_period)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a negative allowance raises 23514', () =>
    Effect.gen(function* () {
      const team = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();

      const result = yield* Effect.result(
        sql`
          UPDATE membership_plans SET free_trainings_per_period = -1 WHERE team_id = ${team.id}
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
        SET free_trainings_per_period = 4, price_per_training_minor = 0
        WHERE team_id = ${team.id}
      `;
      const rows = yield* sql<{ free_trainings_per_period: number }>`
        SELECT free_trainings_per_period FROM membership_plans WHERE team_id = ${team.id}
      `;
      expect(Number(rows[0]?.free_trainings_per_period)).toBe(4);
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
      expect(definition).toContain('free_trainings_per_period');
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
