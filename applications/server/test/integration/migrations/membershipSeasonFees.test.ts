// Migration test for `1794000000_membership_season_fees.ts` ("Bill the membership plan price once
// per season"). Pattern: `trainingPeriodFees.test.ts` (DDL assertions) + `seasons.test.ts`
// (information_schema shapes, fixed instants, `setSeasons` for anything season-sensitive).
//
// TDD: written BEFORE the implementation. Every case here fails until the migration lands AND
// `packages/migrations` is rebuilt — `globalSetup.ts` imports the COMPILED migrations from
// `packages/migrations/dist`, with no vitest alias to `src`.
//
// Two blocks:
//   SCHEMA (A1-A14)            — what the DDL leaves behind, plus the one measurement the plan
//                                reused from another migration without re-taking it (A14).
//   membership_season_charges  — (A15-A25) the derived number, called DIRECTLY. No cron, no
//                                writer: this function is where every sign error lives, and a
//                                test that routes through `recompute_membership_season_fees`
//                                cannot tell a wrong delta from a write gate that swallowed it.
//
// THE FLOOR IS THE POINT OF THE SECOND BLOCK. `GREATEST(raw, -floor)` replaced a boolean
// "settled -> GREATEST(raw, 0)" clamp that ratchets (a member left owing 2100 on a 900 plan) and,
// before that, a drop-gate that removed cancelled members from billing entirely. A21-A25 are
// written so that each rejected shape fails at least one of them; A25 is the only case that
// fails against BOTH.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';
import { daysFromNow, readSeasons, setSeasons } from '../seasonFixtures.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const isFailure23514 = (result: { readonly _tag: string }) => {
  expect(result._tag).toBe('Failure');
  expect(JSON.stringify(result).toLowerCase()).toContain('23514');
};

const isFailure23505 = (result: { readonly _tag: string }) => {
  expect(result._tag).toBe('Failure');
  expect(JSON.stringify(result).toLowerCase()).toContain('23505');
};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Owner user + team. `seed_default_membership_plan_trg` gives the team a default plan
 *  (name NULL, CZK, price 0) and `seed_first_season_trg` a season at `now()` — both are part of
 *  the arrangement every case below starts from. */
const seedTeam = Effect.Do.pipe(
  Effect.bind('owner', () => createUser('membership-season-fees-owner')),
  Effect.bind('team', ({ owner }) => createTeam(nextDiscordId(), owner.id)),
  Effect.map(({ owner, team }) => ({ team, ownerId: owner.id })),
);

/** The season billing resolves — the latest one that has actually STARTED. Deliberately NOT
 *  `governing_season_id`: billing asks "which season is running", selection asks "which season is
 *  the member picking for", and the two give different answers for months at a time (§6). */
const runningSeasonId = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        SELECT s.id::text AS id FROM seasons s
         WHERE s.team_id = ${teamId}::uuid AND s.starts_at <= now()
         ORDER BY s.starts_at DESC LIMIT 1
      `,
    ),
    Effect.map((rows) => {
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('no started season for team');
      return id;
    }),
  );

const insertPlan = (
  teamId: string,
  opts: { name: string; priceMinor: number; currency?: string; archived?: boolean },
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO membership_plans (team_id, name, currency, price_minor, archived_at)
        VALUES (${teamId}::uuid, ${opts.name}, ${opts.currency ?? 'CZK'}, ${opts.priceMinor},
                ${opts.archived === true ? new Date() : null})
        RETURNING id::text AS id
      `,
    ),
    Effect.map((rows) => {
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('plan insert returned no row');
      return id;
    }),
  );

/** The team's SEEDED default plan (the trigger's row). Re-priced rather than replaced:
 *  `idx_membership_plans_team_default` allows exactly one. */
const defaultPlanOf = (teamId: string, priceMinor: number, currency = 'CZK') =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        UPDATE membership_plans
           SET price_minor = ${priceMinor}, currency = ${currency}
         WHERE team_id = ${teamId}::uuid AND is_default AND archived_at IS NULL
        RETURNING id::text AS id
      `,
    ),
    Effect.map((rows) => {
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('team has no seeded default plan');
      return id;
    }),
  );

const putOnPlan = (memberId: string, planId: string | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE team_members SET membership_plan_id = ${planId} WHERE id = ${memberId}::uuid
      `,
    ),
  );

const insertMembershipFee = (
  teamId: string,
  seasonId: string,
  planId: string,
  opts: { currency?: string; name?: string; archived?: boolean } = {},
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        INSERT INTO fees (team_id, kind, season_id, membership_plan_id, name, amount_minor,
                          currency, target_scope, archived_at)
        VALUES (${teamId}::uuid, 'membership', ${seasonId}::uuid, ${planId}::uuid,
                ${opts.name ?? 'membership shell'}, 0, ${opts.currency ?? 'CZK'}, 'custom',
                ${opts.archived === true ? new Date() : null})
        RETURNING id::text AS id
      `,
    ),
    Effect.map((rows) => {
      const id = rows[0]?.id;
      if (id === undefined) throw new Error('membership fee insert returned no row');
      return id;
    }),
  );

const assign = (feeId: string, memberId: string, amountMinor: number, waived = false) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor, stored_status)
        VALUES (${feeId}::uuid, ${memberId}::uuid, ${amountMinor},
                ${waived ? 'waived' : 'active'})
      `,
    ),
  );

/** A `member_credit_deposits` row, with the account row its composite FK needs. `voided` stamps
 *  the void triple (`voided_at`/`voided_by_user_id`/`void_reason` are CHECK-paired) and leaves the
 *  balance at zero — which is what `voidDeposit` leaves behind, and what the floor's
 *  `voided_minor` term is computed from. */
const depositRow = (
  memberId: string,
  byUserId: string,
  opts: {
    amountMinor: number;
    currency?: string;
    seasonId?: string | null;
    voided?: boolean;
  },
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient.asEffect();
    const currency = opts.currency ?? 'CZK';
    const voided = opts.voided === true;
    yield* sql`
      INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
      VALUES (${memberId}::uuid, ${currency}, ${voided ? 0 : opts.amountMinor})
      ON CONFLICT (team_member_id, currency) DO UPDATE
        SET balance_minor = member_credit_accounts.balance_minor
                            + ${voided ? 0 : opts.amountMinor}
    `;
    yield* sql`
      INSERT INTO member_credit_deposits
        (team_member_id, currency, amount_minor, method, paid_at, recorded_by_user_id, source,
         season_id, voided_at, voided_by_user_id, void_reason)
      VALUES (${memberId}::uuid, ${currency}, ${opts.amountMinor}, 'bank_transfer', now(),
              ${byUserId}::uuid, 'auto', ${opts.seasonId ?? null},
              ${voided ? new Date() : null}, ${voided ? byUserId : null},
              ${voided ? 'test void' : null})
    `;
  });

interface ChargeRow {
  readonly team_member_id: string;
  readonly membership_plan_id: string;
  readonly currency: string;
  readonly delta_minor: string;
}

/** `membership_season_charges` called directly — the whole point of the second block. */
const charges = (teamId: string, seasonId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<ChargeRow>`
        SELECT c.team_member_id::text    AS team_member_id,
               c.membership_plan_id::text AS membership_plan_id,
               c.currency,
               c.delta_minor::text        AS delta_minor
          FROM membership_season_charges(${teamId}::uuid, ${seasonId}::uuid) c
         ORDER BY c.team_member_id
      `,
    ),
  );

/** The single row the one-member fixtures expect, with a readable failure when the member was
 *  DROPPED from the result set instead of having their delta bounded — the exact difference
 *  between the floor and the drop-gate it replaced. */
const onlyCharge = (rows: ReadonlyArray<ChargeRow>) => {
  expect(rows, 'expected exactly one charge row — a bounded member is never dropped').toHaveLength(
    1,
  );
  const row = rows[0];
  if (row === undefined) throw new Error('unreachable');
  return row;
};

// ---------------------------------------------------------------------------
// A1-A14 — SCHEMA
// ---------------------------------------------------------------------------

describe('fees — season_id / membership_plan_id columns', () => {
  // A1.
  it.effect('both new columns exist as nullable uuid', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ column_name: string; data_type: string; is_nullable: string }>`
        SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'fees'
           AND column_name IN ('season_id', 'membership_plan_id')
         ORDER BY column_name
      `;
      expect(cols.map((c) => c.column_name)).toEqual(['membership_plan_id', 'season_id']);
      for (const col of cols) {
        expect(col.data_type).toBe('uuid');
        expect(col.is_nullable).toBe('YES');
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  // A2. `toBe('RESTRICT')` and never a `'RESTRICT' || 'NO ACTION'` disjunction: Postgres reports
  // 'NO ACTION' for the DEFAULT, so accepting both would pass a regression to no clause at all.
  it.effect("both foreign keys' delete rule is RESTRICT", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      for (const column of ['season_id', 'membership_plan_id']) {
        const rules = yield* sql<{ delete_rule: string }>`
          SELECT rc.delete_rule
            FROM information_schema.referential_constraints rc
            JOIN information_schema.key_column_usage kcu
              ON kcu.constraint_name = rc.constraint_name
           WHERE kcu.table_schema = 'public' AND kcu.table_name = 'fees'
             AND kcu.column_name = ${column}
        `;
        expect(rules, `expected one FK on fees.${column}`).toHaveLength(1);
        expect(rules[0]?.delete_rule).toBe('RESTRICT');
      }
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('fees — the widened kind CHECK', () => {
  // A3.
  it.effect("accepts 'manual', 'training' and 'membership'", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const seasonId = yield* runningSeasonId(team.id);
      const planId = yield* defaultPlanOf(team.id, 0);

      yield* sql`
        INSERT INTO fees (team_id, name, amount_minor, currency, kind)
        VALUES (${team.id}, 'manual one', 100, 'CZK', 'manual')
      `;
      yield* sql`
        INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
        VALUES (${team.id}, 'training one', 0, 'CZK', 'training', '2026-09-01')
      `;
      yield* sql`
        INSERT INTO fees (team_id, name, amount_minor, currency, kind, season_id,
                          membership_plan_id)
        VALUES (${team.id}, 'membership one', 0, 'CZK', 'membership', ${seasonId}::uuid,
                ${planId}::uuid)
      `;

      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM fees WHERE team_id = ${team.id}
      `;
      expect(Number(rows[0]?.count)).toBe(3);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A4. Widening must stay a CHECK over three literals, not a drop to free TEXT.
  it.effect('still rejects a fourth value with 23514', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind)
          VALUES (${team.id}, 'Bad kind', 100, 'CZK', 'bogus')
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('fees — the two paired CHECKs', () => {
  // A5, first half.
  it.effect("kind='membership' with a NULL season_id raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const planId = yield* defaultPlanOf(team.id, 0);
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, season_id,
                            membership_plan_id)
          VALUES (${team.id}, 'no season', 0, 'CZK', 'membership', NULL, ${planId}::uuid)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A5, second half. The other direction is what keeps a manual fee out of the membership
  // partition of `idx_fees_team_season_plan_currency`.
  it.effect("kind='manual' with a season_id set raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const seasonId = yield* runningSeasonId(team.id);
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, season_id)
          VALUES (${team.id}, 'manual with season', 100, 'CZK', 'manual', ${seasonId}::uuid)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A6, first half.
  it.effect("kind='membership' with a NULL membership_plan_id raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const seasonId = yield* runningSeasonId(team.id);
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, season_id,
                            membership_plan_id)
          VALUES (${team.id}, 'no plan', 0, 'CZK', 'membership', ${seasonId}::uuid, NULL)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A6, second half.
  it.effect("kind='manual' with a membership_plan_id set raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const planId = yield* defaultPlanOf(team.id, 0);
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, membership_plan_id)
          VALUES (${team.id}, 'manual with plan', 100, 'CZK', 'manual', ${planId}::uuid)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A7. `fees_kind_period_start_check` is already correct for the new kind (both sides FALSE) and
  // must NOT be "completed" into a three-way CASE — a membership charge has no calendar period,
  // or `idx_fees_team_period_currency` and `recompute_training_period_fees` both start seeing it.
  it.effect("kind='membership' with a period_start raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const seasonId = yield* runningSeasonId(team.id);
      const planId = yield* defaultPlanOf(team.id, 0);
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, season_id,
                            membership_plan_id, period_start)
          VALUES (${team.id}, 'with period', 0, 'CZK', 'membership', ${seasonId}::uuid,
                  ${planId}::uuid, '2026-09-01')
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A7, the untouched half.
  it.effect("kind='training' with a NULL period_start still raises 23514", () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(
        sql`
          INSERT INTO fees (team_id, name, amount_minor, currency, kind, period_start)
          VALUES (${team.id}, 'Training shell', 0, 'CZK', 'training', NULL)
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('idx_fees_team_season_plan_currency', () => {
  // A8, the definition half. BOTH terms of the predicate are pinned: `archived_at IS NULL` is
  // what lets S1 create a replacement shell after a treasurer archives one, and dropping it is a
  // permanent, silent under-bill of every later member of that plan — A26 is the behavioural
  // half of this assertion.
  it.effect('is UNIQUE and partial on kind = membership AND not archived', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ indexdef: string }>`
        SELECT indexdef FROM pg_indexes
         WHERE schemaname = 'public' AND indexname = 'idx_fees_team_season_plan_currency'
      `;
      expect(rows).toHaveLength(1);
      const def = rows[0]?.indexdef ?? '';
      expect(def).toMatch(/CREATE UNIQUE INDEX/);
      expect(def).toContain("kind = 'membership'::text");
      expect(def).toContain('archived_at IS NULL');
      expect(def).toContain('team_id');
      expect(def).toContain('season_id');
      expect(def).toContain('membership_plan_id');
      expect(def).toContain('currency');
    }).pipe(Effect.provide(TestLayer)),
  );

  // A8, the enforcement half: one shell per (team, season, plan, currency) is what composes with
  // `fee_assignments UNIQUE (fee_id, team_member_id)` into "charged once per (member, season)".
  it.effect('rejects a second shell for the same (team, season, plan, currency)', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const seasonId = yield* runningSeasonId(team.id);
      const planId = yield* defaultPlanOf(team.id, 0);
      yield* insertMembershipFee(team.id, seasonId, planId);

      const result = yield* Effect.result(
        insertMembershipFee(team.id, seasonId, planId, { name: 'duplicate' }),
      );
      isFailure23505(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A8, the discriminating half: `season_id` must be IN the key, or the next season's shell
  // collides with this one's and the rollover never bills (B12's DB-level cause).
  it.effect('accepts the same (team, plan, currency) under a DIFFERENT season', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(-200) }, { startsAt: daysFromNow(-10) }]);
      const seasons = yield* readSeasons(team.id);
      const planId = yield* defaultPlanOf(team.id, 0);

      yield* insertMembershipFee(team.id, String(seasons[0]?.id), planId, { name: 'season one' });
      yield* insertMembershipFee(team.id, String(seasons[1]?.id), planId, { name: 'season two' });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM fees
         WHERE team_id = ${team.id} AND kind = 'membership'
      `;
      expect(Number(rows[0]?.count)).toBe(2);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('member_credit_deposits — season_id and the widened source pair', () => {
  // A9.
  it.effect('season_id exists as a nullable uuid', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'member_credit_deposits'
           AND column_name = 'season_id'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.data_type).toBe('uuid');
      expect(cols[0]?.is_nullable).toBe('YES');
    }).pipe(Effect.provide(TestLayer)),
  );

  // A10, the half that is NEW: before this migration an 'auto' deposit REQUIRED a bank
  // transaction, and the downgrade refund has none.
  it.effect("source='auto' with no bank transaction now succeeds", () =>
    Effect.gen(function* () {
      const { team, ownerId } = yield* seedTeam;
      const memberUser = yield* createUser('deposit-member');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const seasonId = yield* runningSeasonId(team.id);

      yield* depositRow(member.id, ownerId, { amountMinor: 600, seasonId });

      const sql = yield* SqlClient.SqlClient.asEffect();
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM member_credit_deposits
         WHERE team_member_id = ${member.id}::uuid AND source = 'auto'
           AND bank_transaction_id IS NULL
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A10, the half that must NOT be lost: `/unmatch` depends on "a row carrying a transaction is
  // 'auto'", so it can find and undo every deposit a transfer created.
  it.effect("source='manual' with a bank_transaction_id still raises 23514", () =>
    Effect.gen(function* () {
      const { team, ownerId } = yield* seedTeam;
      const memberUser = yield* createUser('deposit-member-manual');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
        VALUES (${member.id}::uuid, 'CZK', 0)
      `;

      // A synthetic transaction id: the CHECK is evaluated while the tuple is formed, the FK
      // trigger only at end of statement, so the CHECK is what fires. If the CHECK were dropped
      // this would surface as 23503 instead — still a failure of this assertion, which is the
      // point.
      const result = yield* Effect.result(
        sql`
          INSERT INTO member_credit_deposits
            (team_member_id, currency, amount_minor, method, paid_at, recorded_by_user_id,
             source, bank_transaction_id)
          VALUES (${member.id}::uuid, 'CZK', 100, 'cash', now(), ${ownerId}::uuid, 'manual',
                  gen_random_uuid())
        `,
      );
      isFailure23514(result);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A10, the unchanged half.
  it.effect("source='manual' with no bank transaction still succeeds", () =>
    Effect.gen(function* () {
      const { team, ownerId } = yield* seedTeam;
      const memberUser = yield* createUser('deposit-member-plain');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
        VALUES (${member.id}::uuid, 'CZK', 100)
      `;
      yield* sql`
        INSERT INTO member_credit_deposits
          (team_member_id, currency, amount_minor, method, paid_at, recorded_by_user_id, source)
        VALUES (${member.id}::uuid, 'CZK', 100, 'cash', now(), ${ownerId}::uuid, 'manual')
      `;
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM member_credit_deposits
         WHERE team_member_id = ${member.id}::uuid
      `;
      expect(Number(rows[0]?.count)).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('team_settings.membership_billing_by_user_id', () => {
  // A11.
  it.effect('exists as a nullable uuid with ON DELETE SET NULL', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const cols = yield* sql<{ data_type: string; is_nullable: string }>`
        SELECT data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = 'team_settings'
           AND column_name = 'membership_billing_by_user_id'
      `;
      expect(cols).toHaveLength(1);
      expect(cols[0]?.data_type).toBe('uuid');
      expect(cols[0]?.is_nullable).toBe('YES');

      const rules = yield* sql<{ delete_rule: string }>`
        SELECT rc.delete_rule
          FROM information_schema.referential_constraints rc
          JOIN information_schema.key_column_usage kcu
            ON kcu.constraint_name = rc.constraint_name
         WHERE kcu.table_schema = 'public' AND kcu.table_name = 'team_settings'
           AND kcu.column_name = 'membership_billing_by_user_id'
      `;
      expect(rules).toHaveLength(1);
      // Deliberate: losing the admin who enabled billing switches billing OFF rather than leaving
      // it on with nobody to attribute `recorded_by_user_id` to. The cron warns about it (B22).
      expect(rules[0]?.delete_rule).toBe('SET NULL');
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('function arity pins', () => {
  // A12. Mirrors `membershipPlanFreeTrainings.test.ts`'s pin on `training_period_charges`: a
  // changed argument count CREATES A SECOND FUNCTION and leaves the old body live, arming a
  // silent 42883 inside a money writer.
  it.effect('each new function exists exactly once', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      for (const name of ['membership_season_charges', 'recompute_membership_season_fees']) {
        const rows = yield* sql<{ count: string }>`
          SELECT count(*)::text AS count FROM pg_proc WHERE proname = ${name}
        `;
        expect(Number(rows[0]?.count), `expected exactly one ${name}`).toBe(1);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  // A13. The migration must take NOTHING from training.
  it.effect('training_period_charges is untouched and still has exactly one overload', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const count = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM pg_proc WHERE proname = 'training_period_charges'
      `;
      expect(Number(count[0]?.count)).toBe(1);

      const def = yield* sql<{ def: string }>`
        SELECT pg_get_functiondef(oid) AS def FROM pg_proc
         WHERE proname = 'recompute_training_period_fees'
      `;
      expect(def).toHaveLength(1);
      expect(def[0]?.def ?? '').toContain("kind = 'training'");
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('team delete with a membership fee on the books', () => {
  // A14. The plan REUSES `1792900000`'s measured cascade-vs-RESTRICT result for a different table
  // pair rather than re-measuring it. This is the measurement. If it fails, the plan is wrong and
  // `fees.season_id` must become CASCADE before anything else is written.
  it.effect('deleting a team still works and takes the fee with it', () =>
    Effect.gen(function* () {
      const { team } = yield* seedTeam;
      const seasonId = yield* runningSeasonId(team.id);
      const planId = yield* defaultPlanOf(team.id, 1500);
      const feeId = yield* insertMembershipFee(team.id, seasonId, planId);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const result = yield* Effect.result(sql`DELETE FROM teams WHERE id = ${team.id}`);

      expect(
        result._tag,
        `ON DELETE RESTRICT blocked the team cascade: ${JSON.stringify(result)}`,
      ).toBe('Success');
      const rows = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM fees WHERE id = ${feeId}::uuid
      `;
      expect(Number(rows[0]?.count)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// A15-A25 — membership_season_charges, called directly
// ---------------------------------------------------------------------------

/** Team + one active member + the running season id, with the default plan re-priced to
 *  `defaultPrice` (0 unless a case needs the fallback to be visible). */
const seedMember = (defaultPrice = 0) =>
  Effect.gen(function* () {
    const { team, ownerId } = yield* seedTeam;
    const defaultPlanId = yield* defaultPlanOf(team.id, defaultPrice);
    const memberUser = yield* createUser('membership-charges-member');
    const member = yield* createTeamMember(team.id, memberUser.id);
    const seasonId = yield* runningSeasonId(team.id);
    return { team, ownerId, defaultPlanId, member, seasonId };
  });

describe('membership_season_charges — the base derivation', () => {
  // A15.
  it.effect('a member on a 1500 plan with nothing charged owes 1500', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const planId = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putOnPlan(member.id, planId);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(1500);
      expect(row.currency).toBe('CZK');
      expect(row.membership_plan_id).toBe(planId);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A16. The function EMITS the zero row; the write sites (`delta > 0`) are what refuse to create
  // a shell for it. Keeping the row is what lets a member who moves ONTO a free plan produce a
  // NEGATIVE delta later instead of vanishing.
  it.effect('a member on a 0 plan yields a row with delta 0', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const planId = yield* insertPlan(team.id, { name: 'Free', priceMinor: 0 });
      yield* putOnPlan(member.id, planId);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A17. Decision 4 — not choosing is still a membership.
  it.effect('a member with no plan is billed the team DEFAULT', () =>
    Effect.gen(function* () {
      const { team, defaultPlanId, member, seasonId } = yield* seedMember(1200);
      yield* putOnPlan(member.id, null);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(1200);
      expect(row.membership_plan_id).toBe(defaultPlanId);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A18. Nothing in the schema stops a `team_members` row from naming ANOTHER team's plan
  // (1792900000's own comment). Without `mp.team_id = tm.team_id` the member is billed another
  // club's price in another club's CURRENCY.
  it.effect("a member pointing at ANOTHER team's plan falls back to their own default", () =>
    Effect.gen(function* () {
      const { team, defaultPlanId, member, seasonId } = yield* seedMember(1000);
      const otherOwner = yield* createUser('other-team-owner');
      const otherTeam = yield* createTeam(nextDiscordId(), otherOwner.id);
      const foreignPlanId = yield* insertPlan(otherTeam.id, {
        name: 'Foreign EUR',
        priceMinor: 9900,
        currency: 'EUR',
      });
      yield* putOnPlan(member.id, foreignPlanId);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(row.currency).toBe('CZK');
      expect(row.membership_plan_id).toBe(defaultPlanId);
      expect(Number(row.delta_minor)).toBe(1000);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A19.
  it.effect('a member on an ARCHIVED plan falls back to the default', () =>
    Effect.gen(function* () {
      const { team, defaultPlanId, member, seasonId } = yield* seedMember(1000);
      const archivedId = yield* insertPlan(team.id, {
        name: 'Archived',
        priceMinor: 1500,
        archived: true,
      });
      yield* putOnPlan(member.id, archivedId);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(row.membership_plan_id).toBe(defaultPlanId);
      expect(Number(row.delta_minor)).toBe(1000);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A20. A membership price is owed by EXISTING, so unlike `training_period_charges` the active
  // filter is load-bearing here: a deactivated member would otherwise be billed a season fee
  // nobody will ever tell them about.
  it.effect('an inactive member produces no row at all', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const planId = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putOnPlan(member.id, planId);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE team_members SET active = false WHERE id = ${member.id}::uuid`;

      expect(yield* charges(team.id, seasonId)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('membership_season_charges — the refund floor', () => {
  // A21. floor = GREATEST(collectable 0 - refunded 0 - voided 0 - price 900, 0) = 0, so
  // GREATEST(-600, -0) = 0. The member's PRESENCE in the result set is itself the assertion that
  // the earlier drop-gate is gone.
  it.effect('a WAIVED charge is not refundable, and the member is still returned', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500, true);
      yield* putOnPlan(member.id, plan900);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A22. Same arithmetic through the other cancellation route.
  it.effect('an ARCHIVED charge is not refundable either', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE id = ${shell}::uuid`;
      yield* putOnPlan(member.id, plan900);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A22b. The floor bounds a NEGATIVE delta and nothing else. raw = 2100 - 1500 + 0 = +600, and
  // it passes untouched — an archived cohort can still be billed. Red against the drop-gate.
  it.effect('the floor never touches a CHARGE: archived, then upgraded, still owes the gap', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan2100 = yield* insertPlan(team.id, { name: 'Pro', priceMinor: 2100 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE id = ${shell}::uuid`;
      yield* putOnPlan(member.id, plan2100);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(600);
      expect(row.membership_plan_id).toBe(plan2100);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A22c. Risk 1's documented mitigation for a currency change is "archive the old fee". Under
  // the drop-gate that archived the member out of billing and the club collected nothing.
  it.effect('the floor does not block the currency mitigation', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const planCzk = yield* insertPlan(team.id, { name: 'Standard CZK', priceMinor: 1500 });
      const planEur = yield* insertPlan(team.id, {
        name: 'Standard EUR',
        priceMinor: 9900,
        currency: 'EUR',
      });
      const shell = yield* insertMembershipFee(team.id, seasonId, planCzk);
      yield* assign(shell, member.id, 1500);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE id = ${shell}::uuid`;
      yield* putOnPlan(member.id, planEur);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(row.currency).toBe('EUR');
      expect(Number(row.delta_minor)).toBe(9900);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A23. The case a per-row `LEAST(fa.amount_minor, plan.price_minor)` clamp gets wrong:
  // LEAST(1500,900) + LEAST(600,900) = 1500, delta -600, and 600 of credit is minted against
  // money the club already cancelled. The floor AGGREGATES the non-collectable rows rather than
  // clamping them one by one, so it is correct for ANY number of them.
  it.effect('two non-collectable assignments still refund nothing', () =>
    Effect.gen(function* () {
      const { team, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan2100 = yield* insertPlan(team.id, { name: 'Pro', priceMinor: 2100 });
      const plan900 = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const shellA = yield* insertMembershipFee(team.id, seasonId, plan1500);
      const shellB = yield* insertMembershipFee(team.id, seasonId, plan2100);
      yield* assign(shellA, member.id, 1500);
      yield* assign(shellB, member.id, 600);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE kind = 'membership'`;
      yield* putOnPlan(member.id, plan900);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A24. floor = GREATEST(1500 - 0 - 600 - 900, 0) = 0. Red when
  // `- COALESCE(refunded.voided_minor, 0)` is dropped from the floor (floor becomes 600, delta
  // -600, and the next tick re-mints the refund a treasurer just took back — every 60 seconds,
  // forever).
  it.effect('a VOIDED refund settles the member: no second refund', () =>
    Effect.gen(function* () {
      const { team, ownerId, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500);
      yield* depositRow(member.id, ownerId, { amountMinor: 600, seasonId, voided: true });
      yield* putOnPlan(member.id, plan900);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A24b. THE OTHER HALF, and it is not covered by A24. Red when `voided_at IS NULL` is dropped
  // from `refunded.sum_minor`'s FILTER: raw becomes 1500 - 1500 + 600 = +600, which S4's
  // DO UPDATE would add onto the live assignment to make 2100 on a 1500 plan.
  //
  // Revert BOTH halves at once and A24 goes GREEN (raw -600 -> floor 0 -> 0, the expected value)
  // while this one stays red. Do not delete it on the strength of A24 "covering" it.
  it.effect('a VOIDED refund does not inflate `refunded` on the way back up', () =>
    Effect.gen(function* () {
      const { team, ownerId, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500);
      yield* depositRow(member.id, ownerId, { amountMinor: 600, seasonId, voided: true });
      yield* putOnPlan(member.id, plan1500);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A24c. The manual-deposit escape hatch: a treasurer's own deposit carries `season_id IS NULL`
  // and lands in NEITHER sum, so voiding one settles nobody and the downgrade refund still fires.
  it.effect('voiding an ORDINARY treasurer deposit settles nobody', () =>
    Effect.gen(function* () {
      const { team, ownerId, member, seasonId } = yield* seedMember();
      const plan1500 = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const shell = yield* insertMembershipFee(team.id, seasonId, plan1500);
      yield* assign(shell, member.id, 1500);
      yield* depositRow(member.id, ownerId, { amountMinor: 600, seasonId: null, voided: true });
      yield* putOnPlan(member.id, plan900);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(-600);
    }).pipe(Effect.provide(TestLayer)),
  );

  // A25. THE RATCHET. charged 2100, collectable 2100, refunded 0, voided 600, price 900.
  //   raw   = 900 - 2100 + 0            = -1200
  //   floor = GREATEST(2100 - 0 - 600 - 900, 0) = 600
  //   delta = GREATEST(-1200, -600)     = -600
  // The ONLY case that discriminates the numeric floor from the boolean clamp it replaced: under
  // `CASE WHEN settled THEN GREATEST(raw, 0)` the answer is 0 and the member is left owing 2100 on
  // a 900 plan, with `updateAssignment` 409ing so the treasurer cannot fix it by hand. Also red
  // against dropping the floor entirely, which gives -1200.
  it.effect('a cancelled member who upgrades then downgrades is still refunded, bounded', () =>
    Effect.gen(function* () {
      const { team, ownerId, member, seasonId } = yield* seedMember();
      const basic = yield* insertPlan(team.id, { name: 'Basic', priceMinor: 900 });
      const standard = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });
      const pro = yield* insertPlan(team.id, { name: 'Pro', priceMinor: 2100 });

      const shellStandard = yield* insertMembershipFee(team.id, seasonId, standard);
      yield* assign(shellStandard, member.id, 1500);
      yield* depositRow(member.id, ownerId, { amountMinor: 600, seasonId, voided: true });
      const shellPro = yield* insertMembershipFee(team.id, seasonId, pro);
      yield* assign(shellPro, member.id, 600);
      yield* putOnPlan(member.id, basic);

      const row = onlyCharge(yield* charges(team.id, seasonId));
      expect(Number(row.delta_minor)).toBe(-600);
      expect(row.membership_plan_id).toBe(basic);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// A26 — recompute_membership_season_fees, the WRITER
// ---------------------------------------------------------------------------
// The only case in this file that runs the writer. It has to: `membership_season_charges`
// reported the late joiner's `delta_minor = 1500` CORRECTLY even while the writer silently
// dropped it, so no amount of derivation testing can see this bug.

/** The opt-in gate AND the credit recorder — one nullable column, and the writer returns
 *  immediately while it is NULL. `team_settings` may or may not already have a row for the team,
 *  hence the upsert. */
const optInBilling = (teamId: string, userId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO team_settings (team_id, membership_billing_by_user_id)
        VALUES (${teamId}::uuid, ${userId}::uuid)
        ON CONFLICT (team_id) DO UPDATE SET membership_billing_by_user_id = ${userId}::uuid
      `,
    ),
  );

const tick = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`SELECT recompute_membership_season_fees(${teamId}::uuid)`),
  );

interface WrittenRow {
  readonly team_member_id: string;
  readonly fee_id: string;
  readonly live: boolean;
  readonly amount_minor: string;
}

/** Every membership assignment the writer has produced for the team, with the archived state of
 *  the shell it hangs under. */
const written = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<WrittenRow>`
        SELECT fa.team_member_id::text AS team_member_id,
               f.id::text              AS fee_id,
               (f.archived_at IS NULL) AS live,
               fa.amount_minor::text   AS amount_minor
          FROM fee_assignments fa
          JOIN fees f ON f.id = fa.fee_id
         WHERE f.team_id = ${teamId}::uuid AND f.kind = 'membership'
         ORDER BY fa.team_member_id
      `,
    ),
  );

describe('recompute_membership_season_fees — an archived shell must not block later members', () => {
  // A26. THE REGRESSION, measured on a real postgres:17 before it was fixed:
  //   fees 1 / live 0 / assignments 1, and member 2's delta stuck at 1500 on every subsequent
  //   tick, forever — `archiveFee` is one-way, there is no un-archive endpoint, and nothing
  //   logs. Cause: `idx_fees_team_season_plan_currency` was not archived-filtered, so S1's
  //   `ON CONFLICT DO NOTHING` matched the DEAD shell and created no replacement, while S4's
  //   join requires `archived_at IS NULL` and therefore found nothing to hang the charge on.
  //
  // RED against reverting EITHER half of the fix on its own:
  //   * drop `AND archived_at IS NULL` from the index only -> 42P10, the writer raises;
  //   * drop it from S1's `ON CONFLICT` only -> 42P10, same;
  //   * drop it from both (the pre-fix shape) -> no error at all, `live_fees` is 0 and member 2
  //     is never billed. That third one is why this case asserts counts rather than just an
  //     absence of failure.
  //
  // The zero-deposit assertion is the other direction: `charged.sum_minor` counts ARCHIVED rows,
  // which is what keeps member 1 at delta 0 under the replacement shell. "Fix" the block by
  // excluding archived rows from that sum instead and member 1 is re-billed from scratch, or
  // handed credit against money the club already cancelled.
  it.effect('a member who joins after the shell is archived is billed exactly once', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();
      const { team, ownerId } = yield* seedTeam;
      // Seasons FIRST: `setSeasons` leads with `DELETE FROM seasons`, and `fees.season_id` is
      // ON DELETE RESTRICT, so it raises 23503 once the writer has produced a shell.
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(-10) }]);
      yield* optInBilling(team.id, ownerId);
      const standard = yield* insertPlan(team.id, { name: 'Standard', priceMinor: 1500 });

      const user1 = yield* createUser('membership-writer-member-1');
      const member1 = yield* createTeamMember(team.id, user1.id);
      yield* putOnPlan(member1.id, standard);
      yield* tick(team.id);

      const first = yield* written(team.id);
      expect(first).toHaveLength(1);
      expect(first[0]?.team_member_id).toBe(member1.id);
      expect(Number(first[0]?.amount_minor)).toBe(1500);
      expect(first[0]?.live).toBe(true);
      const archivedShellId = first[0]?.fee_id;

      // The treasurer archives the shell — a supported action, and Risk 1's own mitigation for a
      // mid-season currency change.
      yield* sql`UPDATE fees SET archived_at = now() WHERE id = ${String(archivedShellId)}::uuid`;

      // A late joiner lands on the SAME plan.
      const user2 = yield* createUser('membership-writer-member-2');
      const member2 = yield* createTeamMember(team.id, user2.id);
      yield* putOnPlan(member2.id, standard);
      yield* tick(team.id);
      // Second tick: the charge must not accumulate through S4's DO UPDATE.
      yield* tick(team.id);

      const after = yield* written(team.id);
      expect(
        after,
        'the late joiner got no assignment at all — the archived shell blocked the replacement',
      ).toHaveLength(2);
      const forMember1 = after.find((row) => row.team_member_id === member1.id);
      const forMember2 = after.find((row) => row.team_member_id === member2.id);

      // Member 1's cancelled charge is left exactly as the treasurer left it.
      expect(Number(forMember1?.amount_minor)).toBe(1500);
      expect(forMember1?.live).toBe(false);
      expect(forMember1?.fee_id).toBe(archivedShellId);

      // Member 2 is billed once, under a FRESH live shell — not under the dead one.
      expect(Number(forMember2?.amount_minor), 'the late joiner was never billed').toBe(1500);
      expect(forMember2?.live).toBe(true);
      expect(forMember2?.fee_id).not.toBe(archivedShellId);

      const liveShells = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM fees
         WHERE team_id = ${team.id} AND kind = 'membership' AND archived_at IS NULL
      `;
      expect(Number(liveShells[0]?.count)).toBe(1);

      // No credit was minted against anything. A refund here would mean money handed back for a
      // charge the club cancelled.
      const deposits = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM member_credit_deposits d
          JOIN team_members tm ON tm.id = d.team_member_id
         WHERE tm.team_id = ${team.id}
      `;
      expect(Number(deposits[0]?.count)).toBe(0);

      // And the derivation has CONVERGED. Pre-fix it never did, so the pre-check at the top of
      // the writer stayed true and the `seasons` row lock plus the team-wide `fees` mutex were
      // taken 1440 times a day to write nothing.
      const seasonId = yield* runningSeasonId(team.id);
      const deltas = yield* charges(team.id, seasonId);
      expect(deltas.map((row) => Number(row.delta_minor))).toEqual([0, 0]);
    }).pipe(Effect.provide(TestLayer)),
  );
});
