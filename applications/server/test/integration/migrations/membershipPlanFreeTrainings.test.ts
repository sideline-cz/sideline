// Migration test for `1793400000_membership_plan_free_trainings.ts` as amended first by the
// ALL-TIME allowance migration and then by `1793900000_create_seasons.ts`. Same split as
// `trainingPeriodFees.test.ts`: this file asserts the DDL the migrations leave behind — the
// renamed column's shape, its CHECK, and the pricing trigger's WHEN clause. The CHARGE behaviour
// lives in `test/integration/repositories/trainingPeriodCharges.test.ts`, where a real member, a
// real training and real attendance exist to bill.
//
// WHAT 1793900000 REMOVED FROM THIS FILE, and why there is nothing left here to replace it with:
// `membership_plans.free_trainings_anchor_at`, `membership_plans_stamp_free_trainings_anchor()`
// and its BEFORE UPDATE trigger are all GONE. The allowance is anchored to the TEAM'S SEASON now
// and RESETS at every rollover, so there is no per-plan stamp and no re-stamp RULE — the five
// transition cases that used to live at the bottom of this file described a trigger that no
// longer exists, and their per-season successors are behavioural, in `trainingPeriodCharges`.
// The one assertion kept here is the INVERTED column check: a reader of this file has to be able
// to see that the column went, not merely fail to find it.

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

  // INVERTED by `1793900000_create_seasons.ts`. This used to assert the column was NOT NULL with
  // a `now()` default; the per-plan anchor is gone and `seasons.starts_at` replaced it. Dropping
  // the assertion outright instead of inverting it would leave a reader of this file believing the
  // column still exists, which is the one thing this file is for.
  it.effect('free_trainings_anchor_at no longer exists — the SEASON is the anchor now', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ column_name: string }>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'membership_plans'
          AND column_name = 'free_trainings_anchor_at'
      `;
      expect(cols).toEqual([]);
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
  it.effect('training_period_charges reads the renamed column and NOT the dropped anchor', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ prosrc: string }>`
        SELECT prosrc FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      const prosrc = rows[0]?.prosrc ?? '';
      expect(prosrc).toContain('free_trainings_included');
      // INVERTED by 1793900000: the body resolves the anchor from `seasons` now, and SQL still
      // naming the dropped column would not even plan. `--` comments are stripped first — the new
      // body deliberately names the column in its docblock to say what replaced it, and a raw
      // substring check cannot tell a read from an explanation.
      const code = prosrc
        .split('\n')
        .map((line) => line.replace(/--.*$/, ''))
        .join('\n');
      expect(code).not.toContain('free_trainings_anchor_at');
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

  // The WHEN clause is the whole safety argument for this trigger: it must fire on every column
  // that changes what a member is charged and on NOTHING else, or renaming a plan or moving its
  // expiry would take the team-wide `fees` lock that `recompute_training_period_fees` takes.
  //
  // 1793600000 widened it from two columns to five. `currency` keys the fees shell; an ARCHIVED
  // plan resolves to the team default, so archiving re-prices everyone on it; and a member with
  // `membership_plan_id IS NULL` is billed by whichever plan carries `is_default`, so moving that
  // flag re-prices all of them at once.
  //
  // DISCRIMINATOR: `pg_trigger.tgqual` is a node tree, so the WHEN clause is supposed to FOLLOW
  // the column rename with no re-issue; if it did not, this assertion is what catches it.
  //
  // The `free_trainings_anchor_at` exclusion that used to sit here is GONE with the column
  // (1793900000) — there is nothing left to exclude, and the clause is unchanged by that
  // migration because research recorded that it deliberately never watched the anchor.
  it.effect('fires on every column that feeds the charge, and no other', () =>
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
      expect(definition).toContain('currency');
      expect(definition).toContain('archived_at');
      expect(definition).toContain('is_default');
      expect(definition).not.toContain('free_trainings_per_period');
      // Expiry enforcement is a separate concern that must end the WHOLE plan at once, never just
      // its billing — so it stays out of the money path.
      expect(definition).not.toContain('expires_at');
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

// DELETED by `1793900000_create_seasons.ts`: `describe('membership_plans_stamp_free_trainings_anchor_trg')`
// and its six cases (the BEFORE UPDATE shape, and the five allowance-transition re-stamp rules
// 0->N / lower / raise / clear / rename-or-price-only).
//
// They are not ported. The trigger and the column they described no longer exist, and the rule
// they encoded — "an edit to the allowance can move the anchor" — is the exact rule the per-season
// reversal removes: ONLY a season moves the anchor now. The one surviving statement, that a plan
// edit re-anchors NOTHING, is behavioural and lives in `trainingPeriodCharges.test.ts`
// ("setting an allowance does NOT re-anchor — only the season does"). The shape of the trigger
// that replaced it (`seasons_recompute_trg`) is pinned in `migrations/seasons.test.ts`.
//
// `membership_plans.free_trainings_anchor_at`'s absence is asserted above, deliberately, so this
// deletion reads as a decision rather than an omission.
