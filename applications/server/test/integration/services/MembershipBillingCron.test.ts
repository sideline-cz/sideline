// `MembershipBillingCron` — billing `membership_plans.price_minor` once per season.
//
// Precedent: `AutoApplyCreditCron.test.ts`, down to the `seed(optIn)` helper shape. Like that
// cron, this file contains no money arithmetic of its own: the cron is a candidate query plus
// `recompute_membership_season_fees`. What is pinned HERE is everything the end-to-end path adds
// on top of `migrations/membershipSeasonFees.test.ts` (which calls `membership_season_charges`
// directly): which teams get visited, which season a row is keyed on, that a second tick writes
// nothing, and that the three write sites (shell, refund, assignment) move the money the
// derivation says they should.
//
// TWO RULES THIS FILE FOLLOWS, both learned from cases that passed against broken code:
//
//  1. **Season assertions use `runningSeasonId`, never `governingSeasonId`.** Billing deliberately
//     does NOT use `governing_season_id` (§6) — that function answers "which season is the member
//     PICKING for" and returns a QUEUED season the moment the live one's window closes. The two
//     agree in a single-season fixture, which is exactly why asserting against the wrong one
//     passes today and inverts the moment anyone adds a queued season (B4d proves that is a legal
//     shape). B4d's own `governingSeasonId` assertion is the one exception: it exists precisely to
//     show the two functions disagreeing.
//  2. **A gate is tested where it lives.** B4a and B4c call the function directly and B4b/B22 call
//     the candidate query directly, because a cron-level "zero rows were written" assertion is
//     satisfied by whichever gate happens to fire first — including, with both gates deleted, a
//     `23514` that `Effect.exit` swallows.
//
// `setSeasons` REPLACES a team's season set, and every season-sensitive case must use it:
// `seed_first_season_trg` gives every team an always-open season at `now()` that otherwise
// answers the gate. Arrange seasons BEFORE anything writes a fee — `fees.season_id` is
// ON DELETE RESTRICT and `setSeasons` begins with a DELETE.

import { describe, expect, it } from '@effect/vitest';
import type { MemberCredit, Team, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { MemberCreditsRepository } from '~/repositories/MemberCreditsRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { autoApplyCreditCronEffect } from '~/services/AutoApplyCreditCron.js';
import { membershipBillingCronEffect } from '~/services/MembershipBillingCron.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  nextDiscordId,
} from '../bankSyncFixtures.js';
import { assertCreditReconciles } from '../creditReconciliation.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';
import { daysFromNow, governingSeasonId, setSeasons } from '../seasonFixtures.js';

const TestLayer = Layer.mergeAll(
  MembershipPlansRepository.Default,
  MemberCreditsRepository.Default,
  PaymentsRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

/** The un-scheduled effect. One "tick" is one full sweep over every candidate team. */
const tick = membershipBillingCronEffect;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Team + one active member + a `team_settings` row. `optIn` writes the treasurer's user id into
 *  `membership_billing_by_user_id`, which is simultaneously the flag and the recorder every
 *  credit deposit the sweep writes is attributed to. */
const seed = (optIn: boolean) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const treasurer = yield* createUser('membership-billing-treasurer');
    const team = yield* createTeam(nextDiscordId(), treasurer.id);
    const memberUser = yield* createUser('membership-billing-member');
    const member = yield* createTeamMember(team.id, memberUser.id);

    yield* sql`
      INSERT INTO team_settings (team_id, membership_billing_by_user_id)
      VALUES (${team.id}, ${optIn ? treasurer.id : null})
      ON CONFLICT (team_id) DO UPDATE
        SET membership_billing_by_user_id = EXCLUDED.membership_billing_by_user_id
    `;

    return { team, member, treasurerId: treasurer.id };
  });

/** A priced plan. `isDefault` re-prices the SEEDED default (the one
 *  `seed_default_membership_plan_trg` created) rather than inserting a second one —
 *  `idx_membership_plans_team_default` allows exactly one per team. */
const setPlanPrice = (
  teamId: string,
  opts: { name: string; priceMinor: number; currency?: string; isDefault?: boolean },
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      opts.isDefault === true
        ? sql<{ id: string }>`
            UPDATE membership_plans
               SET price_minor = ${opts.priceMinor}, currency = ${opts.currency ?? 'CZK'},
                   name = ${opts.name}
             WHERE team_id = ${teamId}::uuid AND is_default AND archived_at IS NULL
            RETURNING id::text AS id
          `
        : sql<{ id: string }>`
            INSERT INTO membership_plans (team_id, name, currency, price_minor)
            VALUES (${teamId}::uuid, ${opts.name}, ${opts.currency ?? 'CZK'}, ${opts.priceMinor})
            RETURNING id::text AS id
          `,
    ),
    Effect.map((rows) => {
      const id = rows[0]?.id;
      if (id === undefined) throw new Error(`no plan row for ${opts.name}`);
      return id;
    }),
  );

const putMemberOnPlan = (memberId: string, planId: string | null) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        UPDATE team_members SET membership_plan_id = ${planId} WHERE id = ${memberId}::uuid
      `,
    ),
  );

interface MembershipAssignmentRow {
  readonly assignment_id: string;
  readonly amount_minor: string;
  readonly due_at: Date | null;
  readonly updated_at: Date;
  readonly status: string;
  readonly stored_status: string;
  readonly paid_minor: string;
  readonly season_id: string;
  readonly membership_plan_id: string;
  readonly currency: string;
  readonly fee_id: string;
  readonly fee_archived: boolean;
}

/** Every assignment of this member that hangs off a `kind='membership'` fee. Ordered by
 *  insertion so "the original" is always first; tests that care about WHICH shell look the row up
 *  by plan id instead (`byPlan` below). */
const membershipAssignmentsOf = (teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<MembershipAssignmentRow>`
        SELECT fa.id::text                   AS assignment_id,
               fa.amount_minor::text         AS amount_minor,
               fa.due_at                     AS due_at,
               fa.updated_at                 AS updated_at,
               v.status                      AS status,
               fa.stored_status              AS stored_status,
               fa.paid_minor::text           AS paid_minor,
               f.season_id::text             AS season_id,
               f.membership_plan_id::text    AS membership_plan_id,
               f.currency                    AS currency,
               f.id::text                    AS fee_id,
               (f.archived_at IS NOT NULL)   AS fee_archived
          FROM fee_assignments fa
          JOIN fees f ON f.id = fa.fee_id
          JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
         WHERE fa.team_member_id = ${teamMemberId}::uuid AND f.kind = 'membership'
         ORDER BY fa.created_at ASC, fa.amount_minor ASC
      `,
    ),
  );

const byPlan = (rows: ReadonlyArray<MembershipAssignmentRow>, planId: string) => {
  const found = rows.filter((row) => row.membership_plan_id === planId);
  expect(found, `expected exactly one assignment under plan ${planId}`).toHaveLength(1);
  const row = found[0];
  if (row === undefined) throw new Error('unreachable');
  return row;
};

/** The NON-voided membership refunds (`season_id` set). B16d deliberately counts raw rows
 *  instead, because the voided one is the row under test there. */
const membershipRefundsOf = (teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{
        readonly id: string;
        readonly amount_minor: string;
        readonly currency: string;
        readonly source: string;
        readonly method: string;
        readonly season_id: string;
        readonly recorded_by_user_id: string;
        readonly bank_transaction_id: string | null;
      }>`
        SELECT d.id::text                    AS id,
               d.amount_minor::text          AS amount_minor,
               d.currency                    AS currency,
               d.source                      AS source,
               d.method                      AS method,
               d.season_id::text             AS season_id,
               d.recorded_by_user_id::text   AS recorded_by_user_id,
               d.bank_transaction_id::text   AS bank_transaction_id
          FROM member_credit_deposits d
         WHERE d.team_member_id = ${teamMemberId}::uuid
           AND d.season_id IS NOT NULL AND d.voided_at IS NULL
         ORDER BY d.created_at ASC
      `,
    ),
  );

/** Every season-keyed deposit, VOIDED ONES INCLUDED. */
const allSeasonDepositsOf = (teamMemberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{
        readonly id: string;
        readonly amount_minor: string;
        readonly voided: boolean;
      }>`
        SELECT d.id::text AS id, d.amount_minor::text AS amount_minor,
               (d.voided_at IS NOT NULL) AS voided
          FROM member_credit_deposits d
         WHERE d.team_member_id = ${teamMemberId}::uuid AND d.season_id IS NOT NULL
         ORDER BY d.created_at ASC
      `,
    ),
  );

const balanceOf = (teamMemberId: string, currency = 'CZK') =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ readonly balance_minor: string }>`
        SELECT balance_minor::text AS balance_minor FROM member_credit_accounts
         WHERE team_member_id = ${teamMemberId}::uuid AND currency = ${currency}
      `,
    ),
    Effect.map((rows) => Number(rows[0]?.balance_minor ?? 0)),
  );

const membershipFeesOf = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{
        readonly id: string;
        readonly name: string;
        readonly amount_minor: string;
        readonly currency: string;
        readonly season_id: string;
        readonly membership_plan_id: string;
        readonly period_start: string | null;
        readonly due_at: Date | null;
      }>`
        SELECT f.id::text                  AS id,
               f.name                      AS name,
               f.amount_minor::text        AS amount_minor,
               f.currency                  AS currency,
               f.season_id::text           AS season_id,
               f.membership_plan_id::text  AS membership_plan_id,
               f.period_start::text        AS period_start,
               f.due_at                    AS due_at
          FROM fees f
         WHERE f.team_id = ${teamId}::uuid AND f.kind = 'membership'
         ORDER BY f.created_at ASC, f.name ASC
      `,
    ),
  );

/**
 * THE season billing keys on: the latest one that has already STARTED. Every assertion about a
 * fee's or a deposit's `season_id` goes through this, never `governingSeasonId` — see the header.
 */
const runningSeasonId = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap(
      (sql) => sql<{ id: string }>`
        SELECT s.id::text AS id FROM seasons s
         WHERE s.team_id = ${teamId}::uuid AND s.starts_at <= now()
         ORDER BY s.starts_at DESC LIMIT 1
      `,
    ),
    Effect.map((rows) => rows[0]?.id ?? null),
  );

/** `recompute_membership_season_fees` called DIRECTLY, bypassing the cron and its candidate
 *  query — the only way to observe the function's own gates. */
const recomputeDirect = (teamId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`SELECT recompute_membership_season_fees(${teamId}::uuid)`),
  );

const countRows = (table: 'fees' | 'fee_assignments' | 'member_credit_deposits') =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.flatMap((sql) =>
      table === 'fees'
        ? sql<{ count: string }>`SELECT count(*)::text AS count FROM fees WHERE kind = 'membership'`
        : table === 'fee_assignments'
          ? sql<{ count: string }>`
              SELECT count(*)::text AS count FROM fee_assignments fa
                JOIN fees f ON f.id = fa.fee_id WHERE f.kind = 'membership'
            `
          : sql<{ count: string }>`SELECT count(*)::text AS count FROM member_credit_deposits`,
    ),
    Effect.map((rows) => Number(rows[0]?.count)),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MembershipBillingCron — the opt-in and the happy path', () => {
  // B1. Nobody is billed until a club ticks a box. Red when the
  // `membership_billing_by_user_id IS NOT NULL` gate is dropped from the function.
  it.effect('a team that has NOT opted in is untouched', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(false);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      yield* tick;

      expect(yield* countRows('fees')).toBe(0);
      expect(yield* countRows('fee_assignments')).toBe(0);
      expect(yield* countRows('member_credit_deposits')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B2.
  it.effect('bills the plan price once, on a shell keyed to the RUNNING season', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      yield* tick;

      const fees = yield* membershipFeesOf(team.id);
      expect(fees).toHaveLength(1);
      expect(fees[0]?.season_id).toBe(yield* runningSeasonId(team.id));
      expect(fees[0]?.membership_plan_id).toBe(plan);
      // The shell carries 0; the real figure is on the assignment, exactly like a training fee.
      expect(Number(fees[0]?.amount_minor)).toBe(0);
      expect(fees[0]?.currency).toBe('CZK');
      // A membership charge is not anchored on a calendar month and must never acquire one, or
      // `idx_fees_team_period_currency` and `recompute_training_period_fees` start seeing it.
      expect(fees[0]?.period_start).toBeNull();

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B3. THE acceptance criterion. Idempotence by DERIVATION: the second tick recomputes
  // delta = 0 and writes nothing. Both tables are counted — "the happy path again" would pass
  // against a second shell being minted.
  it.effect('a DOUBLE tick writes exactly one fee and one assignment', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      yield* tick;
      yield* tick;

      expect(yield* countRows('fees')).toBe(1);
      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      expect(yield* countRows('member_credit_deposits')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B5. A plan at price 0 produces NO fee at all, not a zero-amount one. Shells are never
  // deleted, so an unneeded one is permanent clutter. Red when S1's `delta_minor > 0` becomes
  // `>= 0`.
  it.effect('a zero-price plan produces no fee at all', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan = yield* setPlanPrice(team.id, { name: 'Free', priceMinor: 0 });
      yield* putMemberOnPlan(member.id, plan);

      yield* tick;

      expect(yield* countRows('fees')).toBe(0);
      expect(yield* countRows('fee_assignments')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B6. Decision 4, end to end: not choosing is still a membership.
  it.effect('a member who never selected is billed the team DEFAULT plan', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const defaultPlan = yield* setPlanPrice(team.id, {
        name: 'Default',
        priceMinor: 1200,
        isDefault: true,
      });
      yield* putMemberOnPlan(member.id, null);

      yield* tick;

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1200);
      expect(assignments[0]?.membership_plan_id).toBe(defaultPlan);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B14.
  it.effect('a deactivated member is not billed', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE team_members SET active = false WHERE id = ${member.id}::uuid`;

      yield* tick;

      expect(yield* countRows('fees')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B15. A `team_members` row may legally name another team's plan. Without
  // `mp.team_id = tm.team_id` the member is billed another club's price in another club's
  // currency — and the fee lands on THIS club's books in EUR.
  it.effect("a member pointing at another team's EUR plan is billed their own CZK default", () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const defaultPlan = yield* setPlanPrice(team.id, {
        name: 'Default',
        priceMinor: 1000,
        isDefault: true,
      });
      const otherOwner = yield* createUser('membership-billing-other-owner');
      const otherTeam = yield* createTeam(nextDiscordId(), otherOwner.id);
      const foreignPlan = yield* setPlanPrice(otherTeam.id, {
        name: 'Foreign EUR',
        priceMinor: 9900,
        currency: 'EUR',
      });
      yield* putMemberOnPlan(member.id, foreignPlan);

      yield* tick;

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]?.currency).toBe('CZK');
      expect(assignments[0]?.membership_plan_id).toBe(defaultPlan);
      expect(Number(assignments[0]?.amount_minor)).toBe(1000);

      const fees = yield* membershipFeesOf(team.id);
      expect(fees.filter((f) => f.currency === 'EUR')).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipBillingCron — the season gates', () => {
  // B4a. THE FUNCTION'S OWN gate, and it must bypass the cron to be observable: routed through
  // the cron this passes against a broken implementation three ways (the candidate query already
  // skipped the team; with BOTH gates deleted the fee INSERT raises 23514 on
  // `fees_kind_season_check`, which `Effect.exit` swallows, so "zero fees" still holds).
  //
  // The assertion the cron-level version could not make is that the call RESOLVES.
  it.effect(
    'calling the function for a team with NO seasons writes nothing and does not raise',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seed(true);
        const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
        yield* putMemberOnPlan(member.id, plan);
        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`DELETE FROM seasons WHERE team_id = ${team.id}`;
        expect(yield* governingSeasonId(team.id)).toBeNull();

        const result = yield* Effect.result(recomputeDirect(team.id));

        expect(result._tag, `the function raised: ${JSON.stringify(result)}`).toBe('Success');
        expect(yield* countRows('fees')).toBe(0);
        expect(yield* countRows('fee_assignments')).toBe(0);
        expect(yield* countRows('member_credit_deposits')).toBe(0);
      }).pipe(Effect.provide(TestLayer)),
  );

  // B4b. The candidate query's OWN gate, asserted on the candidate set directly. "Zero rows
  // written after the cron" is red against nothing here — delete this gate and the function's
  // `IF v_season_id IS NULL` still fires.
  it.effect('a team with no seasons is absent from the candidate set', () =>
    Effect.gen(function* () {
      const { team } = yield* seed(true);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`DELETE FROM seasons WHERE team_id = ${team.id}`;

      const repo = yield* MembershipPlansRepository.asEffect();
      const candidates = yield* repo.findMembershipBillingTeams();

      expect(candidates.map((c) => String(c.teamId))).not.toContain(String(team.id));
    }).pipe(Effect.provide(TestLayer)),
  );

  // B4c. The advance-billing half of Gate 2: a season that has not started is never billable, so
  // no non-selector is ever charged the default plan's price months early. Red when the season
  // lookup loses `AND s.starts_at <= now()`.
  it.effect('a team whose only season is in the FUTURE is not billed', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(5) }]);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      yield* recomputeDirect(team.id);
      expect(yield* countRows('fees')).toBe(0);

      yield* tick;
      expect(yield* countRows('fees')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B4d. The pass-2 Blocker, now defended BY a test instead of defended by prose. An OPEN queued
  // season beats a CLOSED live one in `governing_season_id` (1793900000:208-229 orders
  // `is_open DESC`), so a draft that billed on the governing season switched billing OFF for the
  // live season for as long as the queue stood — months, silently, on a money feature.
  it.effect('a queued OPEN season does not freeze billing for the live one', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      yield* setSeasons(team.id, [
        { startsAt: daysFromNow(-200), expiresAt: daysFromNow(-10) },
        { startsAt: daysFromNow(120) },
      ]);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      // The premise, pinned so the case documents why it exists: the two functions DISAGREE here.
      const governing = yield* governingSeasonId(team.id);
      const running = yield* runningSeasonId(team.id);
      expect(governing).not.toBe(running);

      yield* tick;

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      expect(assignments[0]?.season_id).toBe(running);
      expect(assignments[0]?.season_id).not.toBe(governing);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B12. ROLLOVER. An UPDATE, never `setSeasons`, because `fees.season_id` is ON DELETE RESTRICT
  // and `setSeasons` begins with a DELETE. Red when `season_id` leaves the unique index: the new
  // season's shell then conflicts with the old one's and the rollover never bills.
  it.effect('a season rollover bills the member again, leaving the first charge alone', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(-30) }, { startsAt: daysFromNow(5) }]);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);

      yield* tick;
      const firstSeason = yield* runningSeasonId(team.id);
      const afterFirst = yield* membershipAssignmentsOf(member.id);
      expect(afterFirst).toHaveLength(1);
      const firstRow = afterFirst[0];

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE seasons SET starts_at = now() - INTERVAL '1 hour'
         WHERE team_id = ${team.id} AND starts_at > now()
      `;
      const secondSeason = yield* runningSeasonId(team.id);
      expect(secondSeason).not.toBe(firstSeason);

      yield* tick;

      const fees = yield* membershipFeesOf(team.id);
      expect(fees).toHaveLength(2);
      expect(new Set(fees.map((f) => f.membership_plan_id))).toEqual(new Set([plan]));
      expect(new Set(fees.map((f) => f.season_id))).toEqual(
        new Set([String(firstSeason), String(secondSeason)]),
      );

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(2);
      for (const row of assignments) expect(Number(row.amount_minor)).toBe(1500);
      const stillFirst = assignments.find((row) => row.assignment_id === firstRow?.assignment_id);
      expect(Number(stillFirst?.amount_minor)).toBe(1500);
      expect(stillFirst?.updated_at.getTime()).toBe(firstRow?.updated_at.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // B22. The NULL-recorder warning must survive a rollover. Scoping the warning's EXISTS to the
  // running season makes it SELF-EXTINGUISH on exactly the day the outage becomes total: the team
  // has no fees for the NEW season precisely BECAUSE billing has been off.
  //
  // Asserted on the candidate set rather than on a log line: the cron rate-limits the warning to
  // minute 0, and `TestClock` moves Effect's virtual clock, never Postgres `now()`.
  it.effect('a team whose recorder was removed stays a candidate across a rollover', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      yield* setSeasons(team.id, [{ startsAt: daysFromNow(-30) }, { startsAt: daysFromNow(5) }]);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);
      yield* tick;
      expect(yield* countRows('fees')).toBe(1);

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE team_settings SET membership_billing_by_user_id = NULL WHERE team_id = ${team.id}
      `;
      yield* sql`
        UPDATE seasons SET starts_at = now() - INTERVAL '1 hour'
         WHERE team_id = ${team.id} AND starts_at > now()
      `;

      const repo = yield* MembershipPlansRepository.asEffect();
      const candidates = yield* repo.findMembershipBillingTeams();
      const mine = candidates.filter((c) => String(c.teamId) === String(team.id));

      expect(mine, 'the team left the candidate set, so the warning went quiet').toHaveLength(1);
      expect(Option.isNone(mine[0]?.recordedByUserId ?? Option.none())).toBe(true);

      // And it is a WARNING, not a resumption: nothing new was billed for the new season.
      yield* tick;
      expect(yield* countRows('fees')).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipBillingCron — reassignment', () => {
  // B7. An upgrade writes a SECOND fee for the gap and NEVER rewrites the first — which is only
  // structurally possible because `membership_plan_id` is part of the shell key.
  it.effect('an UPGRADE writes a second fee for the gap and leaves the original alone', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;

      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      const fees = yield* membershipFeesOf(team.id);
      expect(fees).toHaveLength(2);
      const season = yield* runningSeasonId(team.id);
      for (const fee of fees) {
        expect(fee.season_id).toBe(season);
        expect(fee.currency).toBe('CZK');
      }

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(2);
      expect(Number(byPlan(assignments, plan900).amount_minor)).toBe(900);
      expect(Number(byPlan(assignments, plan1500).amount_minor)).toBe(600);
      expect(assignments.reduce((sum, r) => sum + Number(r.amount_minor), 0)).toBe(1500);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B8. A downgrade hands the difference back as member credit, under the user named by the
  // opt-in column. The original 1500 is never rewritten.
  it.effect('a DOWNGRADE issues the difference as credit', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);

      const refunds = yield* membershipRefundsOf(member.id);
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0]?.amount_minor)).toBe(600);
      // `source = 'auto'` rather than a new literal: `MemberCreditSource` is on the wire, and
      // `listDepositsByMember` already maps 'auto' to a NULL recorder name so no treasurer is
      // credited with a deposit they never made.
      expect(refunds[0]?.source).toBe('auto');
      expect(refunds[0]?.bank_transaction_id).toBeNull();
      expect(refunds[0]?.season_id).toBe(yield* runningSeasonId(team.id));
      expect(refunds[0]?.recorded_by_user_id).toBe(treasurerId);

      expect(yield* balanceOf(member.id)).toBe(600);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // B9. The refund is derived, not stateful: the next tick reads the deposit it already wrote and
  // computes 0. Red when `refunded` is dropped — the sweep would then re-mint 600 every minute.
  it.effect('a downgrade refund is idempotent across further ticks', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;
      yield* tick;

      expect(yield* membershipRefundsOf(member.id)).toHaveLength(1);
      expect(yield* balanceOf(member.id)).toBe(600);
      expect(yield* membershipAssignmentsOf(member.id)).toHaveLength(1);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // B10.
  it.effect('a downgrade to the FREE plan refunds in full', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const planFree = yield* setPlanPrice(team.id, { name: 'Free', priceMinor: 0 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;
      yield* putMemberOnPlan(member.id, planFree);
      yield* tick;

      const refunds = yield* membershipRefundsOf(member.id);
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0]?.amount_minor)).toBe(1500);
      expect(yield* balanceOf(member.id)).toBe(1500);

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      expect(yield* countRows('fees')).toBe(1);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // B11. 1500 -> 900 (refund 600) -> 2100. Net 2100, and NO shell exists for the 900 plan: that
  // move produced a NEGATIVE delta and S1 only ever mints a shell for `delta > 0`. The second
  // half is the only assertion in the file that pins §8's no-empty-shell rule on a REFUND path.
  it.effect('an upgrade after a downgrade nets correctly and mints no empty shell', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      const plan2100 = yield* setPlanPrice(team.id, { name: 'Pro', priceMinor: 2100 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;
      yield* putMemberOnPlan(member.id, plan2100);
      yield* tick;

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(2);
      expect(Number(byPlan(assignments, plan1500).amount_minor)).toBe(1500);
      expect(Number(byPlan(assignments, plan2100).amount_minor)).toBe(1200);

      const refunds = yield* membershipRefundsOf(member.id);
      expect(refunds).toHaveLength(1);
      expect(Number(refunds[0]?.amount_minor)).toBe(600);
      // net = 2700 charged - 600 refunded = 2100, the Pro price.
      expect(
        assignments.reduce((sum, r) => sum + Number(r.amount_minor), 0) -
          refunds.reduce((sum, r) => sum + Number(r.amount_minor), 0),
      ).toBe(2100);

      const fees = yield* membershipFeesOf(team.id);
      expect(fees).toHaveLength(2);
      expect(fees.filter((f) => f.membership_plan_id === plan900)).toHaveLength(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipBillingCron — human corrections', () => {
  // B16. Replaces a weaker case that passed either way. "Archiving stops collection" holds
  // whatever `charged` counts (the archived shell still occupies the unique index and S4 requires
  // `archived_at IS NULL`), so it discriminated nothing. THIS asserts the refund side: zero
  // credit is minted against money the club already cancelled. Red against the pass-1 plan, which
  // deposited 600.
  it.effect('ARCHIVING the shell does not mint credit on a later downgrade', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE kind = 'membership'`;
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;

      expect(yield* countRows('member_credit_deposits')).toBe(0);
      expect(yield* balanceOf(member.id)).toBe(0);
      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      expect(yield* countRows('fees')).toBe(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B16b. The other cancellation route. The waive is applied as raw SQL rather than through the
  // HTTP API: `fee_assignments.stored_status` is the ONLY input the floor reads
  // (`collectable_minor`'s FILTER), the API guard that keeps waiving legal on a membership
  // assignment is pinned in `api/financeMembershipFee.test.ts` C4, and standing an HTTP harness up
  // here would duplicate it. Same bypass `AutoApplyCreditCron.test.ts` uses for its waive case.
  it.effect('WAIVING the assignment does not mint credit on a later downgrade', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE fee_assignments SET stored_status = 'waived', waived_reason = 'hardship'
         WHERE team_member_id = ${member.id}::uuid
      `;
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;

      expect(yield* countRows('member_credit_deposits')).toBe(0);
      expect(yield* balanceOf(member.id)).toBe(0);
      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(1);
      expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      expect(assignments[0]?.stored_status).toBe('waived');
    }).pipe(Effect.provide(TestLayer)),
  );

  // B16c. EXPECTATION INVERTED from the pass-1 draft, and that inversion is the visible
  // consequence of bounding instead of dropping. The floor only bounds a negative delta; a
  // positive one passes untouched, so a waived member can still be billed an upgrade gap.
  it.effect('a WAIVE does not stop a later upgrade', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE fee_assignments SET stored_status = 'waived', waived_reason = 'hardship'
         WHERE team_member_id = ${member.id}::uuid
      `;
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      const fees = yield* membershipFeesOf(team.id);
      expect(fees).toHaveLength(2);
      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(assignments).toHaveLength(2);
      expect(Number(byPlan(assignments, plan1500).amount_minor)).toBe(600);
      expect(yield* countRows('member_credit_deposits')).toBe(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // B16e. BLAST RADIUS. A shell is team-wide, so the drop-gate took the whole cohort out of
  // billing for the season — with no un-archive endpoint to recover. Archiving must stop
  // COLLECTION, not membership in the billing set.
  it.effect('ARCHIVING a shell is not a cohort kill switch', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const secondUser = yield* createUser('membership-billing-member-2');
      const member2 = yield* createTeamMember(team.id, secondUser.id);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan2100 = yield* setPlanPrice(team.id, { name: 'Pro', priceMinor: 2100 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* putMemberOnPlan(member2.id, plan1500);
      yield* tick;
      expect(yield* countRows('fees')).toBe(1);

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`UPDATE fees SET archived_at = now() WHERE kind = 'membership'`;
      yield* putMemberOnPlan(member.id, plan2100);
      yield* tick;

      const first = yield* membershipAssignmentsOf(member.id);
      expect(first).toHaveLength(2);
      expect(Number(byPlan(first, plan2100).amount_minor)).toBe(600);

      const second = yield* membershipAssignmentsOf(member2.id);
      expect(second).toHaveLength(1);
      expect(Number(second[0]?.amount_minor)).toBe(1500);
      expect(second[0]?.membership_plan_id).toBe(plan1500);

      expect(yield* countRows('member_credit_deposits')).toBe(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // B16d. Walks BOTH halves of the void fix in one case.
  //   * after the void and two more ticks: the refund is NOT re-minted (red against pass 1, which
  //     minted a fresh 600 every tick, forever);
  //   * after moving back UP to the original plan: the assignment stays at 1500, not 2100 (red
  //     against the first half of the pass-2 fix taken alone).
  // `membershipRefundsOf` is the NON-voided set and returns 0 here, so it cannot discriminate —
  // this case counts raw rows instead.
  it.effect('VOIDING a refund neither re-mints it nor over-charges on the way back', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;
      yield* putMemberOnPlan(member.id, plan900);
      yield* tick;
      expect(yield* balanceOf(member.id)).toBe(600);

      const deposits = yield* allSeasonDepositsOf(member.id);
      expect(deposits).toHaveLength(1);
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* credits.voidDeposit({
        teamId: team.id as Team.TeamId,
        memberId: member.id as TeamMember.TeamMemberId,
        depositId: String(deposits[0]?.id) as MemberCredit.MemberCreditDepositId,
        voidedByUserId: treasurerId,
        reason: 'treasurer reversed the refund',
      });

      yield* tick;
      yield* tick;

      const afterVoid = yield* allSeasonDepositsOf(member.id);
      expect(afterVoid, 'the voided refund was re-minted').toHaveLength(1);
      expect(afterVoid[0]?.voided).toBe(true);
      expect(yield* balanceOf(member.id)).toBe(0);
      const held = yield* membershipAssignmentsOf(member.id);
      expect(held).toHaveLength(1);
      expect(Number(held[0]?.amount_minor)).toBe(1500);

      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;

      const back = yield* membershipAssignmentsOf(member.id);
      expect(back).toHaveLength(1);
      expect(Number(back[0]?.amount_minor), 'the DO UPDATE re-added the voided 600').toBe(1500);
      expect(yield* balanceOf(member.id)).toBe(0);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  // B21. THE RATCHET, end to end — A25's arrangement driven entirely through the cron.
  // Standard -> Basic (refund 600) -> VOID -> tick -> Pro -> Basic.
  // Under the boolean `GREATEST(raw, 0)` clamp the last move refunds nothing and the member is
  // left owing 2100 on a 900 plan, with `updateAssignment` 409ing so nobody can fix it by hand.
  // Under the numeric floor they are refunded exactly 600, leaving them over by exactly the 600
  // the treasurer took back: bounded and attributable.
  it.effect('a voided refund bounds, but does not freeze, a later downgrade', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const basic = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      const standard = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const pro = yield* setPlanPrice(team.id, { name: 'Pro', priceMinor: 2100 });

      yield* putMemberOnPlan(member.id, standard);
      yield* tick;
      yield* putMemberOnPlan(member.id, basic);
      yield* tick;

      const deposits = yield* allSeasonDepositsOf(member.id);
      expect(deposits).toHaveLength(1);
      const credits = yield* MemberCreditsRepository.asEffect();
      yield* credits.voidDeposit({
        teamId: team.id as Team.TeamId,
        memberId: member.id as TeamMember.TeamMemberId,
        depositId: String(deposits[0]?.id) as MemberCredit.MemberCreditDepositId,
        voidedByUserId: treasurerId,
        reason: 'treasurer reversed the refund',
      });
      yield* tick;

      yield* putMemberOnPlan(member.id, pro);
      yield* tick;
      yield* putMemberOnPlan(member.id, basic);
      yield* tick;

      const live = yield* membershipRefundsOf(member.id);
      expect(live, 'the floor froze the member instead of bounding them').toHaveLength(1);
      expect(Number(live[0]?.amount_minor)).toBe(600);
      expect(yield* balanceOf(member.id)).toBe(600);

      const assignments = yield* membershipAssignmentsOf(member.id);
      const collectable = assignments
        .filter((row) => row.stored_status !== 'waived' && !row.fee_archived)
        .reduce((sum, row) => sum + Number(row.amount_minor), 0);
      expect(collectable).toBe(2100);
      // net = their 900 plan price + exactly the 600 the treasurer took back. Under the boolean
      // clamp this is 2100 — over by 1200, and growing on every further down-move.
      expect(collectable - (yield* balanceOf(member.id))).toBe(1500);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipBillingCron — due dates and downstream', () => {
  // B18. `fee_assignment_status_v.effective_due_at` is `COALESCE(fa.due_at, f.due_at)`, so a late
  // joiner landing on an old shell would be overdue the instant they are billed — and would never
  // be REMINDED of it, because the reminder ladder matches `day_diff` on EXACT EQUALITY
  // (-3, 0, 3, 10, 21). A fee born 47 days overdue matches no rung and fires nothing, ever.
  // Red when `due_at` leaves S4's INSERT column list.
  it.effect('a LATE joiner gets a future due date, not the shell’s back-dated one', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      yield* putMemberOnPlan(member.id, plan);
      yield* tick;
      const firstRow = (yield* membershipAssignmentsOf(member.id))[0];

      const sql = yield* SqlClient.SqlClient.asEffect();
      // Stands in for a shell created months ago — Postgres `now()` cannot be moved, and
      // `TestClock` only moves Effect's virtual clock.
      yield* sql`
        UPDATE fees SET due_at = now() - INTERVAL '47 days' WHERE kind = 'membership'
      `;

      const lateUser = yield* createUser('membership-billing-late-joiner');
      const late = yield* createTeamMember(team.id, lateUser.id);
      yield* putMemberOnPlan(late.id, plan);
      yield* tick;

      const lateRows = yield* membershipAssignmentsOf(late.id);
      expect(lateRows).toHaveLength(1);
      const lateDueAt = lateRows[0]?.due_at ?? null;
      expect(lateDueAt).not.toBeNull();
      expect(lateDueAt === null ? 0 : lateDueAt.getTime()).toBeGreaterThan(Date.now());
      expect(lateRows[0]?.status).toBe('pending');

      const firstAgain = (yield* membershipAssignmentsOf(member.id))[0];
      expect(Number(firstAgain?.amount_minor)).toBe(1500);
      expect(firstAgain?.updated_at.getTime()).toBe(firstRow?.updated_at.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // B19. MUST be built on B20's arrangement. The naive shape (tick -> edit dueAt -> tick) cannot
  // fail: after the first tick the delta is 0, the pre-check returns before S0, and the second
  // tick touches nothing. Even with a second member forcing the pre-check open, the edited member
  // is filtered out by S4's `WHERE c.delta_minor > 0`. The ONLY path on which S4 touches an
  // existing assignment row is the accumulating `DO UPDATE` branch — so the edit has to sit on a
  // row that branch is about to hit.
  //
  // The edit is raw SQL for the same reason as B16b: C4 pins that `updateAssignment` allows a
  // `dueAt` change on a membership assignment, and `fa.due_at` is the only column S4's DO UPDATE
  // could clobber.
  it.effect('a treasurer’s due-date edit survives the accumulating DO UPDATE', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const planA = yield* setPlanPrice(team.id, { name: 'A 1500', priceMinor: 1500 });
      const planB = yield* setPlanPrice(team.id, { name: 'B 900', priceMinor: 900 });
      const planC = yield* setPlanPrice(team.id, { name: 'C 1200', priceMinor: 1200 });

      yield* putMemberOnPlan(member.id, planA);
      yield* tick;
      yield* putMemberOnPlan(member.id, planB);
      yield* tick;
      yield* putMemberOnPlan(member.id, planC);
      yield* tick;
      yield* putMemberOnPlan(member.id, planA);

      const sql = yield* SqlClient.SqlClient.asEffect();
      const edited = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const target = byPlan(yield* membershipAssignmentsOf(member.id), planA);
      yield* sql`
        UPDATE fee_assignments SET due_at = ${edited} WHERE id = ${target.assignment_id}::uuid
      `;

      yield* tick;

      const after = byPlan(yield* membershipAssignmentsOf(member.id), planA);
      // The DO UPDATE fired — without this the due-date assertion below proves nothing.
      expect(Number(after.amount_minor)).toBe(1800);
      expect(after.due_at?.getTime() ?? null).toBe(edited.getTime());
    }).pipe(Effect.provide(TestLayer)),
  );

  // B17. Decision 7 — a membership refund becomes auto-apply's problem, not this cron's. Red if
  // membership fees are excluded from `findAutoApplyCandidates` (§1's decision reversed).
  //
  // `findAutoApplyCandidates` groups per (member, currency) and sums EVERY unpaid active
  // assignment, so outstanding is 1500 + 400 = 1900 and `amountMinor: 0` applies
  // min(600, 1900) = 600, DRAINING the balance. "Balance 200" is arithmetically impossible here.
  // The manual fee's explicit earlier `dueAt` is load-bearing: `settle` allocates
  // `effectiveDueAt ASC, NULLs last`, so a NULL due date would send the whole 600 to the
  // membership fee.
  it.effect('a downgrade refund is spent by AutoApplyCreditCron on the next pass', () =>
    Effect.gen(function* () {
      const { team, member, treasurerId } = yield* seed(true);
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        UPDATE team_settings SET auto_apply_credit_by_user_id = ${treasurerId}
         WHERE team_id = ${team.id}
      `;
      const plan1500 = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
      const plan900 = yield* setPlanPrice(team.id, { name: 'Basic', priceMinor: 900 });
      yield* putMemberOnPlan(member.id, plan1500);
      yield* tick;
      yield* putMemberOnPlan(member.id, plan900);

      const manual = yield* createFeeAndAssignment(team.id, member.id, 400, {
        name: 'Kit fee',
        dueAt: DateTime.add(DateTime.nowUnsafe(), { days: 2 }),
      });

      yield* tick;
      expect(yield* balanceOf(member.id)).toBe(600);

      yield* autoApplyCreditCronEffect;

      const manualRow = yield* sql<{ paid_minor: string; status: string }>`
        SELECT fa.paid_minor::text AS paid_minor, v.status AS status
          FROM fee_assignments fa JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
         WHERE fa.id = ${manual.assignment.id}::uuid
      `;
      expect(Number(manualRow[0]?.paid_minor)).toBe(400);
      expect(manualRow[0]?.status).toBe('paid');

      const membership = yield* membershipAssignmentsOf(member.id);
      expect(membership).toHaveLength(1);
      expect(Number(membership[0]?.paid_minor)).toBe(200);
      expect(membership[0]?.status).toBe('partial');

      expect(yield* balanceOf(member.id)).toBe(0);
      const payments = yield* sql<{ count: string }>`
        SELECT count(*)::text AS count FROM payments
         WHERE team_member_id = ${member.id}::uuid AND method = 'credit' AND voided_at IS NULL
      `;
      expect(Number(payments[0]?.count)).toBe(2);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

describe('MembershipBillingCron — one bad team never stops the sweep', () => {
  // B23. THE PER-TEAM `Effect.exit`. Every other case in this file seeds exactly one team, so
  // deleting `Effect.exit` from `MembershipBillingCron.ts` left all 30 of them green — and the
  // thing it protects is not a lost tick but a dead cron: the sweep is `{ concurrency: 1 }` over
  // `ORDER BY ts.team_id ASC`, so an escaping failure skips every team BEHIND the bad one, and
  // it escapes `withCronMetrics` too, which kills `Effect.repeat(Schedule.cron(...))` for the
  // pod's lifetime. Per the Gate-2 comment in the migration, a season missed is never recomputed.
  //
  // The failure arrives as a DEFECT, not a typed error: `recomputeMembershipSeasonFees` ends in
  // `catchSqlErrors`, which is `LogicError.withMessage`, which is `Effect.die`. That is why the
  // cron taps `Effect.tapDefect` and not `Effect.tapError` — the latter is unreachable here, by
  // type and at runtime, and this case is what would have caught it.
  //
  // The poison is a `CHECK` on `fees` scoped to ONE team's uuid, so S1's shell insert raises
  // `23514` for that team and only that team. It is DDL, and `cleanDatabase` only TRUNCATEs, so
  // it is dropped through `Effect.ensuring` — a leak would silently break every case after this
  // one. The poisoned team is the LOWEST uuid of the three, which is the one the candidate query
  // visits FIRST, which is the only arrangement where "the teams behind it" exist at all.
  //
  // NOT pinned here: `{ concurrency: 1 }` itself. Flipping it to `'unbounded'` leaves this case
  // green. That setting is a lock-contention choice (the function holds a seasons row lock and
  // the team-wide fees mutex for the duration), and contention is not observable through query
  // results — same honesty as `teamSettingsReanchor.test.ts`'s note on its own lock-avoidance
  // gate. What IS pinned is that the sweep completes and the other teams are billed.
  it.effect('a team whose recompute raises is skipped; the teams behind it are still billed', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient.asEffect();

      const seeded: Array<{ teamId: string; memberId: string }> = [];
      for (let i = 0; i < 3; i++) {
        const { team, member } = yield* seed(true);
        const plan = yield* setPlanPrice(team.id, { name: 'Standard', priceMinor: 1500 });
        yield* putMemberOnPlan(member.id, plan);
        seeded.push({ teamId: team.id, memberId: member.id });
      }

      const byTeamId = [...seeded].sort((a, b) => a.teamId.localeCompare(b.teamId));
      const poisoned = byTeamId[0];
      if (poisoned === undefined) throw new Error('unreachable');
      const healthy = byTeamId.slice(1);
      expect(healthy).toHaveLength(2);

      yield* sql
        .unsafe(
          `ALTER TABLE fees ADD CONSTRAINT membership_billing_b23_poison
             CHECK (team_id <> '${poisoned.teamId}'::uuid) NOT VALID`,
        )
        .pipe(Effect.asVoid);

      yield* tick.pipe(
        Effect.ensuring(
          sql
            .unsafe('ALTER TABLE fees DROP CONSTRAINT IF EXISTS membership_billing_b23_poison')
            .pipe(Effect.orDie, Effect.asVoid),
        ),
      );

      // The sweep completed. The bad team wrote nothing — not a partial charge, not a shell.
      const poisonedFees = yield* membershipFeesOf(poisoned.teamId);
      expect(poisonedFees).toHaveLength(0);
      expect(yield* membershipAssignmentsOf(poisoned.memberId)).toHaveLength(0);

      // ...and every team behind it was billed in full, on the same tick.
      for (const team of healthy) {
        const fees = yield* membershipFeesOf(team.teamId);
        expect(fees).toHaveLength(1);
        const assignments = yield* membershipAssignmentsOf(team.memberId);
        expect(assignments).toHaveLength(1);
        expect(Number(assignments[0]?.amount_minor)).toBe(1500);
      }

      // The next tick, with the poison gone, heals the bad team: the derivation is idempotent,
      // so nothing is lost beyond the ticks it was broken for.
      yield* tick;
      const healedAssignments = yield* membershipAssignmentsOf(poisoned.memberId);
      expect(healedAssignments).toHaveLength(1);
      expect(Number(healedAssignments[0]?.amount_minor)).toBe(1500);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// B20 — kept LAST in the file: it is the only case that needs two connections, so a hang here
// must not mask anything behind it.
// ---------------------------------------------------------------------------

describe('MembershipBillingCron — concurrency', () => {
  // B20. C MUST BE CHEAPER THAN A, or the final move is a REFUND and the accumulating DO UPDATE
  // is never reached at all (the pass-1 shape used C = 2100 and was green with and without the
  // S0 lock, and green against a genuine double refund — `assertCreditReconciles` cannot see a
  // duplicated deposit).
  //
  //   A 1500, tick            -> assign(A) = 1500
  //   -> B 900, tick          -> raw -600, floor 600 -> refund 600
  //   -> C 1200, tick         -> raw 1200 - 1500 + 600 = +300 -> assign(C) = 300, charged 1800
  //   -> back to A            -> raw 1500 - 1800 + 600 = +300, which CONFLICTS on assign(A)
  //
  // Two unserialised sessions both applying +300 give 2100. One gives 1800.
  //
  // NOT an isolation test for S0 — do not expect removing S0 alone to turn it red; Postgres
  // serialises these two sessions one layer down on S2's FOR UPDATE of the shell. This pins the
  // ACCUMULATE ARITHMETIC: it is also red when the DO UPDATE becomes DO NOTHING.
  it.effect('two concurrent ticks cannot double-apply the accumulating DO UPDATE', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seed(true);
      const planA = yield* setPlanPrice(team.id, { name: 'A 1500', priceMinor: 1500 });
      const planB = yield* setPlanPrice(team.id, { name: 'B 900', priceMinor: 900 });
      const planC = yield* setPlanPrice(team.id, { name: 'C 1200', priceMinor: 1200 });

      yield* putMemberOnPlan(member.id, planA);
      yield* tick;
      yield* putMemberOnPlan(member.id, planB);
      yield* tick;
      yield* putMemberOnPlan(member.id, planC);
      yield* tick;
      yield* putMemberOnPlan(member.id, planA);

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* Effect.scoped(
        Effect.gen(function* () {
          const sql2 = yield* secondTestPgClient;
          yield* Effect.all(
            [
              sql`SELECT recompute_membership_season_fees(${team.id}::uuid)`,
              sql2`SELECT recompute_membership_season_fees(${team.id}::uuid)`,
            ],
            { concurrency: 'unbounded' },
          );
        }),
      );

      const assignments = yield* membershipAssignmentsOf(member.id);
      expect(Number(byPlan(assignments, planA).amount_minor)).toBe(1800);
      expect(Number(byPlan(assignments, planC).amount_minor)).toBe(300);
      expect(yield* allSeasonDepositsOf(member.id)).toHaveLength(1);
      expect(yield* balanceOf(member.id)).toBe(600);
      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});
