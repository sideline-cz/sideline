// Slice 3b of "Setup memberships" — the PERIOD ACCUMULATION charge engine
// (`1793200000_training_period_fees.ts`'s three plpgsql functions and two triggers), exercised
// end-to-end through the real repositories: confirming attendance (`EventAttendanceRepository`),
// rescheduling/cancelling/retyping events (`EventsRepository`), and recording/voiding payments
// (`PaymentsRepository`) — every assertion reads the `fees`/`fee_assignments` rows the triggers
// left behind directly, via raw SQL.
//
// DATE FIXTURES: pinned ONCE at module load (`NOW`), never a second `new Date()` /
// `SELECT now()` call scattered through a test. Training events sit an hour or so before `NOW`
// so `EventAttendanceRepository.confirmAttendance`'s `start_at <= now()` guard always passes,
// and land in the SAME UTC calendar month as `NOW` — every team in this file has no
// `team_settings` row, so `training_period_start` falls back to UTC (pinned by
// `trainingPeriodFees.test.ts`'s own fallback test). The `PAST_MONTH_*` and `NEXT_MONTH_*`
// fixtures are the deliberate exceptions, for the period-close test and for the ALL-TIME
// allowance cases at the bottom of this file — every one of them is UTC-constructed and derived
// from `NOW`, never from a fresh `new Date()`.

import { describe, expect, it } from '@effect/vitest';
import type { Team, TeamMember } from '@sideline/domain';
import { DateTime, Deferred, Effect, Fiber, Layer, Option } from 'effect';
import * as TestClock from 'effect/testing/TestClock';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { EventAttendanceRepository } from '~/repositories/EventAttendanceRepository.js';
import { type EventRow, EventsRepository } from '~/repositories/EventsRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createTeam, createTeamMember, createUser, nextDiscordId } from '../bankSyncFixtures.js';
import { cleanDatabase, secondTestPgClient, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  EventAttendanceRepository.Default,
  EventsRepository.Default,
  FinanceOverviewRepository.Default,
  MembershipPlansRepository.Default,
  PaymentsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Date fixtures
// ---------------------------------------------------------------------------

const NOW = new Date();
const TRAINING_START = new Date(NOW.getTime() - 60 * 60 * 1000);
const TRAINING_START_2 = new Date(NOW.getTime() - 30 * 60 * 1000);
const PERIOD_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const NEXT_PERIOD_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 1));
const EXPECTED_DUE_AT = new Date(
  Date.UTC(NEXT_PERIOD_START.getUTCFullYear(), NEXT_PERIOD_START.getUTCMonth(), 10),
);
const EXPECTED_PERIOD_NAME = `${PERIOD_START.getUTCFullYear()}-${String(
  PERIOD_START.getUTCMonth() + 1,
).padStart(2, '0')}`;
// A date safely inside the PREVIOUS calendar month — used only by the period-close test.
const PAST_MONTH_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 12));
// Two more trainings in the PREVIOUS calendar month. Both sit on day 15, strictly BEFORE the
// day-16 anchor instant below, so the anchor-month regression case has room: the whole point of
// that case is past attendance in the SAME period as the anchor but EARLIER than the stamp.
const PAST_MONTH_START_2 = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 18));
const PAST_MONTH_START_3 = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 15, 20));
// The mid-past-month anchor INSTANT for the period-alignment regression case.
const PAST_MONTH_MID = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 1, 16, 0));
// Two months back — the ordinary "this plan has existed for a while" anchor.
const OLD_ANCHOR = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() - 2, 1));
// Inside the NEXT period, for the reschedule-into-the-future case.
const NEXT_MONTH_MID = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 10, 12));

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------

const seedTeam = (username: string) =>
  Effect.gen(function* () {
    const owner = yield* createUser(username);
    const team = yield* createTeam(nextDiscordId(), owner.id);
    const captainUser = yield* createUser(`${username}-captain`);
    const captain = yield* createTeamMember(team.id, captainUser.id);
    return { owner, team, captain };
  });

const addBilledMember = (teamId: Team.TeamId, username: string) =>
  Effect.gen(function* () {
    const user = yield* createUser(username);
    return yield* createTeamMember(teamId, user.id);
  });

const defaultPlan = (teamId: Team.TeamId) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findMembershipPlansByTeamId(teamId)),
    Effect.map((plans) => {
      const found = plans.find((p) => p.is_default);
      if (!found) throw new Error('expected a seeded default plan');
      return found;
    }),
  );

const setDefaultPlanPrice = (
  teamId: Team.TeamId,
  priceMinor: number,
  currency = 'CZK',
  freeTrainings = 0,
) =>
  Effect.gen(function* () {
    const plans = yield* MembershipPlansRepository.asEffect();
    const def = yield* defaultPlan(teamId);
    yield* plans.updateMembershipPlan({
      id: def.id,
      team_id: teamId,
      name: def.name,
      price_minor: def.price_minor,
      currency: currency as never,
      price_per_training_minor: priceMinor as never,
      free_trainings_included: Option.some(freeTrainings as never),
      expires_at: def.expires_at,
    });
  });

const createPlan = (
  teamId: Team.TeamId,
  priceMinor: number,
  currency: string,
  name: string,
  freeTrainings = 0,
) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertMembershipPlan({
        team_id: teamId,
        name: Option.some(name as never),
        price_minor: 0 as never,
        currency: currency as never,
        price_per_training_minor: priceMinor as never,
        free_trainings_included: Option.some(freeTrainings as never),
        expires_at: Option.none(),
      }),
    ),
  );

const selectPlanForMember = (
  memberId: TeamMember.TeamMemberId,
  teamId: Team.TeamId,
  planId: string,
) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.selectMembershipPlan({ member_id: memberId, team_id: teamId, plan_id: planId as never }),
    ),
  );

/** Bypasses `selectMembershipPlan`'s own-team scoping — the only way to point
 * `membership_plan_id` at ANOTHER team's plan, which nothing in the schema itself forbids
 * (see `1792900000_membership_selection.ts`'s own comment). */
const setMemberPlanRaw = (memberId: TeamMember.TeamMemberId, planId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`UPDATE team_members SET membership_plan_id = ${planId} WHERE id = ${memberId}`,
    ),
  );

/** Writes `membership_plans.free_trainings_anchor_at` directly. Takes an ABSOLUTE Date, never a
 * month count — the period-alignment case needs a mid-month instant. Raw SQL on purpose: the
 * column has no application writer at all, which is the point of choosing it. It does NOT touch
 * `created_at`; `created_at` is no longer the anchor.
 *
 * ORDERING TRAP, the single most likely way these tests silently lie:
 *  - `setDefaultPlanPrice(..., allowance)` moves the allowance 0 -> N, which fires the BEFORE
 *    trigger and stamps the anchor to `now()`. So ALWAYS call this AFTER setting the allowance.
 *  - this call fires NEITHER trigger (BEFORE watches `free_trainings_included`, AFTER watches the
 *    two pricing columns), so it performs NO recompute. Every anchor change must be followed by an
 *    attendance write, or an explicit `recomputePeriod`, before asserting. */
const setPlanAnchor = (planId: string, at: Date) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) =>
        sql`UPDATE membership_plans SET free_trainings_anchor_at = ${at} WHERE id = ${planId}`,
    ),
  );

/** Forces a recompute with no attendance write. */
const recomputePeriod = (teamId: Team.TeamId, periodStart: Date) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        SELECT recompute_training_period_fees(${teamId}, ${periodStart.toISOString().slice(0, 10)}::date)
      `,
    ),
  );

const createTraining = (teamId: Team.TeamId, createdBy: TeamMember.TeamMemberId, startAt: Date) =>
  EventsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertEvent({
        teamId,
        eventType: 'training',
        title: 'Charge engine fixture training',
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(startAt),
        endAt: Option.none(),
        location: Option.none(),
        createdBy,
        trainingTypeId: Option.none(),
      }),
    ),
  );

const confirm = (
  event: EventRow,
  teamId: Team.TeamId,
  confirmedBy: TeamMember.TeamMemberId,
  entries: ReadonlyArray<{
    readonly team_member_id: TeamMember.TeamMemberId;
    readonly present: boolean;
  }>,
) =>
  EventAttendanceRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.confirmAttendance({
        event_id: event.id,
        team_id: teamId,
        confirmed_by: confirmedBy,
        entries,
      }),
    ),
  );

interface TrainingFeeRow {
  readonly id: string;
  readonly name: string;
  readonly amount_minor: string;
  readonly currency: string;
  readonly period_start: string;
  readonly due_at: Date;
  readonly target_scope: string;
  readonly kind: string;
}

const trainingFees = (teamId: Team.TeamId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<TrainingFeeRow>`
        SELECT id::text AS id, name, amount_minor::text AS amount_minor, currency,
               period_start::text AS period_start, due_at, target_scope, kind
        FROM fees WHERE team_id = ${teamId} AND kind = 'training'
        ORDER BY currency
      `,
    ),
  );

/** `trainingFees` orders by `currency` ONLY, so the moment a case touches two periods the array
 * holds two same-currency rows in an unspecified order. Select by period, never by index — and in
 * a multi-period case never assert `toHaveLength(1)` either. */
const feeForPeriod = (fees: ReadonlyArray<TrainingFeeRow>, periodStart: Date) =>
  fees.find((f) => f.period_start === periodStart.toISOString().slice(0, 10));

interface AssignmentRow {
  readonly id: string;
  readonly amount_minor: string;
  readonly paid_minor: string;
  readonly stored_status: string;
  readonly waived_reason: string | null;
}

const assignmentFor = (feeId: string, memberId: string) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql<AssignmentRow>`
        SELECT id::text AS id, amount_minor::text AS amount_minor, paid_minor::text AS paid_minor,
               stored_status, waived_reason
        FROM fee_assignments WHERE fee_id = ${feeId} AND team_member_id = ${memberId}
      `,
    ),
    Effect.map((rows) => rows[0]),
  );

// ---------------------------------------------------------------------------
// 1. The opt-in gate
// ---------------------------------------------------------------------------

describe('training_period_charges — the opt-in gate', () => {
  it.effect('a free default plan (price 0) produces ZERO fees rows and ZERO assignments', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('free-plan');
      const member = yield* addBilledMember(team.id, 'free-plan-member');
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      expect(yield* trainingFees(team.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 2-3. Shape and accumulation
// ---------------------------------------------------------------------------

describe('training_period_charges — shape and accumulation', () => {
  it.effect('one training, one present member, price 100 -> one fees row and one assignment', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('single-training');
      const member = yield* addBilledMember(team.id, 'single-training-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect(fee.kind).toBe('training');
      expect(fee.period_start).toBe(PERIOD_START.toISOString().slice(0, 10));
      expect(fee.name).toBe(EXPECTED_PERIOD_NAME);
      expect(fee.amount_minor).toBe('0');
      expect(fee.target_scope).toBe('custom');
      expect(new Date(fee.due_at).toISOString()).toBe(EXPECTED_DUE_AT.toISOString());

      const assignment = yield* assignmentFor(fee.id, member.id);
      expect(assignment?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'confirming a 2nd training in the same month accumulates onto the SAME fee/assignment',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('accumulate');
        const member = yield* addBilledMember(team.id, 'accumulate-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(t1, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
        const feesAfter1 = yield* trainingFees(team.id);
        const fee1 = feesAfter1[0];
        if (fee1 === undefined) throw new Error('expected a fee row');
        const assignmentAfter1 = yield* assignmentFor(fee1.id, member.id);

        const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
        yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        const feesAfter2 = yield* trainingFees(team.id);
        expect(feesAfter2).toHaveLength(1);
        expect(feesAfter2[0]?.id).toBe(fee1.id);
        const assignmentAfter2 = yield* assignmentFor(fee1.id, member.id);
        expect(assignmentAfter2?.id).toBe(assignmentAfter1?.id);
        expect(assignmentAfter2?.amount_minor).toBe('200');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('present=false and never-confirmed rows are not counted', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('not-present');
      const memberA = yield* addBilledMember(team.id, 'not-present-a');
      yield* addBilledMember(team.id, 'not-present-b'); // never confirmed at all
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [
        { team_member_id: memberA.id, present: false },
      ]);

      expect(yield* trainingFees(team.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 5-7. Plan resolution
// ---------------------------------------------------------------------------

describe('training_period_charges — plan resolution', () => {
  it.effect("a member's own unarchived same-team plan beats the default", () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('own-plan');
      const member = yield* addBilledMember(team.id, 'own-plan-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const plan = yield* createPlan(team.id, 250, 'CZK', 'Premium');
      yield* selectPlanForMember(member.id, team.id, plan.id);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('250');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "CROSS-TEAM PLAN IGNORED: a membership_plan_id pointing at ANOTHER team's plan falls back " +
      "to THIS team's default, never that plan's price — regression guard",
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('cross-team');
        const member = yield* addBilledMember(team.id, 'cross-team-member');
        yield* setDefaultPlanPrice(team.id, 100);

        const { team: otherTeam } = yield* seedTeam('cross-team-other');
        const otherPlan = yield* createPlan(otherTeam.id, 999, 'CZK', 'Other club plan');
        yield* setMemberPlanRaw(member.id, otherPlan.id);

        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);

        const fees = yield* trainingFees(team.id);
        expect(fees).toHaveLength(1);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an archived own-team plan is ignored — falls back to the default', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('archived-plan');
      const member = yield* addBilledMember(team.id, 'archived-plan-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const plans = yield* MembershipPlansRepository.asEffect();
      const plan = yield* createPlan(team.id, 250, 'CZK', 'Soon archived');
      yield* selectPlanForMember(member.id, team.id, plan.id);
      yield* plans.archiveMembershipPlan(plan.id as never, team.id);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 8. THE GREATEST CLAMP
// ---------------------------------------------------------------------------

describe('training_period_charges — the GREATEST clamp', () => {
  it.effect(
    'paying 200 then un-ticking one training (computed charge drops to 100) leaves ' +
      'amount_minor at 200 (clamped to paid_minor), never 100 — and the overview never shows ' +
      'totalDueMinor < totalPaidMinor',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('clamp');
        const member = yield* addBilledMember(team.id, 'clamp-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
        const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
        yield* confirm(t1, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
        yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        const fees = yield* trainingFees(team.id);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('200');

        const payments = yield* PaymentsRepository.asEffect();
        const assignmentBefore = yield* assignmentFor(fee.id, member.id);
        if (assignmentBefore === undefined) throw new Error('expected an assignment');
        yield* payments.insert({
          feeAssignmentId: assignmentBefore.id as never,
          teamMemberId: member.id,
          amountMinor: 200,
          method: 'cash',
          paidAt: DateTime.fromDateUnsafe(NOW),
          note: Option.none(),
          recordedByUserId: captain.user_id as never,
        });

        // Un-tick t2: computed charge drops to 100 (only t1 still counts).
        yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: false }]);

        const afterClamp = yield* assignmentFor(fee.id, member.id);
        expect(
          afterClamp?.amount_minor,
          'clamped to paid_minor, never dropped to the raw 100',
        ).toBe('200');
        expect(afterClamp?.paid_minor).toBe('200');

        const overview = yield* FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        );
        const row = overview.find((r) => r.teamMemberId === member.id);
        expect(row, 'the member should still have an overview row').toBeDefined();
        if (row === undefined) throw new Error('expected an overview row');
        expect(row.totalDueMinor).toBeGreaterThanOrEqual(row.totalPaidMinor);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 9-11. Pruning rules
// ---------------------------------------------------------------------------

describe('training_period_charges — S4 pruning', () => {
  it.effect('dropping to zero, never paid -> the assignment row is DELETED', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('drop-to-zero');
      const member = yield* addBilledMember(team.id, 'drop-to-zero-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect(yield* assignmentFor(fee.id, member.id)).toBeDefined();

      yield* confirm(training, team.id, captain.id, [
        { team_member_id: member.id, present: false },
      ]);
      expect(yield* assignmentFor(fee.id, member.id)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'dropping to zero with a VOIDED payment survives — the row is NOT deleted, no 23503 ' +
      '(payments.fee_assignment_id is ON DELETE RESTRICT and the voided row still exists)',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('voided-survives');
        const member = yield* addBilledMember(team.id, 'voided-survives-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
        const fees = yield* trainingFees(team.id);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        const assignment = yield* assignmentFor(fee.id, member.id);
        if (assignment === undefined) throw new Error('expected an assignment');

        const payments = yield* PaymentsRepository.asEffect();
        const payment = yield* payments.insert({
          feeAssignmentId: assignment.id as never,
          teamMemberId: member.id,
          amountMinor: 100,
          method: 'cash',
          paidAt: DateTime.fromDateUnsafe(NOW),
          note: Option.none(),
          recordedByUserId: captain.user_id as never,
        });
        yield* payments.void_(payment.id, {
          voidedByUserId: captain.user_id as never,
          voidReason: 'test void',
          voidedAt: DateTime.fromDateUnsafe(NOW),
        });
        expect((yield* assignmentFor(fee.id, member.id))?.paid_minor).toBe('0');

        const result = yield* Effect.result(
          confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: false }]),
        );
        expect(result._tag).toBe('Success');

        const survivor = yield* assignmentFor(fee.id, member.id);
        expect(
          survivor,
          'S4 must not delete a row a voided payment still references',
        ).toBeDefined();
        expect(survivor?.amount_minor).toBe('0');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'WAIVE PRESERVED: a waived assignment survives dropping to zero, with its reason intact ' +
      "— regression guard for S4's stored_status filter",
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('waive-preserved');
        const member = yield* addBilledMember(team.id, 'waive-preserved-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
        const fees = yield* trainingFees(team.id);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        const assignment = yield* assignmentFor(fee.id, member.id);
        if (assignment === undefined) throw new Error('expected an assignment');

        const sql = yield* SqlClient.SqlClient.asEffect();
        yield* sql`
          UPDATE fee_assignments SET stored_status = 'waived', waived_reason = 'injury leave'
          WHERE id = ${assignment.id}
        `;

        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: false },
        ]);

        const survivor = yield* assignmentFor(fee.id, member.id);
        expect(survivor, 'a waive must survive S4').toBeDefined();
        expect(survivor?.amount_minor).toBe('0');
        expect(survivor?.stored_status).toBe('waived');
        expect(survivor?.waived_reason).toBe('injury leave');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 12-13. Currency
// ---------------------------------------------------------------------------

describe('training_period_charges — currency', () => {
  it.effect(
    'mixed currency: two members on CZK and EUR plans produce TWO fees rows, one assignment each',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('mixed-currency');
        const memberCzk = yield* addBilledMember(team.id, 'mixed-currency-czk');
        const memberEur = yield* addBilledMember(team.id, 'mixed-currency-eur');
        yield* setDefaultPlanPrice(team.id, 100, 'CZK');
        const eurPlan = yield* createPlan(team.id, 8, 'EUR', 'Euro plan');
        yield* selectPlanForMember(memberEur.id, team.id, eurPlan.id);

        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: memberCzk.id, present: true },
          { team_member_id: memberEur.id, present: true },
        ]);

        const fees = yield* trainingFees(team.id);
        expect(fees).toHaveLength(2);
        const czkFee = fees.find((f) => f.currency === 'CZK');
        const eurFee = fees.find((f) => f.currency === 'EUR');
        expect(czkFee).toBeDefined();
        expect(eurFee).toBeDefined();
        if (czkFee === undefined || eurFee === undefined) throw new Error('expected both fees');

        expect((yield* assignmentFor(czkFee.id, memberCzk.id))?.amount_minor).toBe('100');
        expect((yield* assignmentFor(eurFee.id, memberEur.id))?.amount_minor).toBe('8');
        expect(yield* assignmentFor(czkFee.id, memberEur.id)).toBeUndefined();
        expect(yield* assignmentFor(eurFee.id, memberCzk.id)).toBeUndefined();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'currency switch mid-month: switching CZK -> EUR zeroes/removes the stale CZK ' +
      'assignment and the EUR one carries the FULL month (both trainings, not just the ' +
      'one confirmed after the switch)',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('currency-switch');
        const member = yield* addBilledMember(team.id, 'currency-switch-member');
        yield* setDefaultPlanPrice(team.id, 100, 'CZK');
        const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(t1, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        const feesAfterCzk = yield* trainingFees(team.id);
        const czkFee = feesAfterCzk[0];
        if (czkFee === undefined) throw new Error('expected a CZK fee');
        expect((yield* assignmentFor(czkFee.id, member.id))?.amount_minor).toBe('100');

        const eurPlan = yield* createPlan(team.id, 8, 'EUR', 'Euro plan');
        yield* selectPlanForMember(member.id, team.id, eurPlan.id);

        const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
        yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        expect(yield* assignmentFor(czkFee.id, member.id)).toBeUndefined();

        const feesAfterSwitch = yield* trainingFees(team.id);
        const eurFee = feesAfterSwitch.find((f) => f.currency === 'EUR');
        expect(eurFee).toBeDefined();
        if (eurFee === undefined) throw new Error('expected a EUR fee');
        expect((yield* assignmentFor(eurFee.id, member.id))?.amount_minor).toBe('16');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 14. Period close
// ---------------------------------------------------------------------------

describe('training_period_charges — period close', () => {
  it.effect('confirming attendance on a training in a PAST month creates no fee row', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('period-close');
      const member = yield* addBilledMember(team.id, 'period-close-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, PAST_MONTH_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      expect(
        yield* trainingFees(team.id),
        'a past-period recompute must be a deliberate no-op, not a backdated fee',
      ).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 15-19. Triggers
// ---------------------------------------------------------------------------

describe('training_period_charges — events trigger', () => {
  it.effect('cancelling a training with confirmed attendance drops its charge', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('event-cancel');
      const member = yield* addBilledMember(team.id, 'event-cancel-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

      const events = yield* EventsRepository.asEffect();
      yield* events.cancelEvent(training.id);

      expect(
        yield* assignmentFor(fee.id, member.id),
        'a cancelled training must not stay billed',
      ).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'rescheduling a training within the same open month leaves the amount unchanged (sanity)',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('reschedule-same-month');
        const member = yield* addBilledMember(team.id, 'reschedule-same-month-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
        const fees = yield* trainingFees(team.id);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

        const events = yield* EventsRepository.asEffect();
        yield* events.updateEvent({
          id: training.id,
          title: training.title,
          eventType: 'training',
          trainingTypeId: Option.none(),
          description: Option.none(),
          startAt: DateTime.fromDateUnsafe(TRAINING_START_2),
          endAt: Option.none(),
          location: Option.none(),
        });

        expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
        const feesAfter = yield* trainingFees(team.id);
        expect(feesAfter).toHaveLength(1);
        expect(feesAfter[0]?.id).toBe(fee.id);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'WIDENED WHEN: changing a confirmed training to event_type=match drops its charge — a ' +
      'WHEN keyed only on NEW.event_type=training would miss this transition entirely',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('event-type-change');
        const member = yield* addBilledMember(team.id, 'event-type-change-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
        const fees = yield* trainingFees(team.id);
        const fee = fees[0];
        if (fee === undefined) throw new Error('expected a fee row');
        expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

        const events = yield* EventsRepository.asEffect();
        yield* events.updateEvent({
          id: training.id,
          title: training.title,
          eventType: 'match',
          trainingTypeId: Option.none(),
          description: Option.none(),
          startAt: DateTime.fromDateUnsafe(TRAINING_START),
          endAt: Option.none(),
          location: Option.none(),
        });

        expect(yield* assignmentFor(fee.id, member.id)).toBeUndefined();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'updating a training with NO confirmed attendance creates no fee row (trigger inert)',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('trigger-inert');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);

        const events = yield* EventsRepository.asEffect();
        yield* events.updateEvent({
          id: training.id,
          title: 'Renamed, still nobody confirmed',
          eventType: 'training',
          trainingTypeId: Option.none(),
          description: Option.none(),
          startAt: DateTime.fromDateUnsafe(TRAINING_START_2),
          endAt: Option.none(),
          location: Option.none(),
        });

        expect(yield* trainingFees(team.id)).toHaveLength(0);
      }).pipe(Effect.provide(TestLayer)),
  );
});

describe('training_period_charges — event_attendance trigger', () => {
  it.effect('deleting an attendance row directly (simulating a cascade) drops the charge', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('attendance-delete');
      const member = yield* addBilledMember(team.id, 'attendance-delete-member');
      yield* setDefaultPlanPrice(team.id, 100);
      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`DELETE FROM event_attendance WHERE event_id = ${training.id} AND team_member_id = ${member.id}`;

      expect(yield* assignmentFor(fee.id, member.id)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 20. Idempotence
// ---------------------------------------------------------------------------

describe('training_period_charges — idempotence', () => {
  it.effect(
    'confirming the same attendance twice produces identical amounts and ids, no duplicate fee',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('idempotent');
        const member = yield* addBilledMember(team.id, 'idempotent-member');
        yield* setDefaultPlanPrice(team.id, 100);
        const training = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);

        const feesFirst = yield* trainingFees(team.id);
        const feeFirst = feesFirst[0];
        if (feeFirst === undefined) throw new Error('expected a fee row');
        const assignmentFirst = yield* assignmentFor(feeFirst.id, member.id);

        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);

        const feesSecond = yield* trainingFees(team.id);
        expect(feesSecond).toHaveLength(1);
        expect(feesSecond[0]?.id).toBe(feeFirst.id);
        const assignmentSecond = yield* assignmentFor(feeFirst.id, member.id);
        expect(assignmentSecond?.id).toBe(assignmentFirst?.id);
        expect(assignmentSecond?.amount_minor).toBe(assignmentFirst?.amount_minor);
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 29. CONCURRENCY — S1's FOR UPDATE is the mutex preventing a lost update
// ---------------------------------------------------------------------------

// NOTE ON WHAT THIS DOES AND DOES NOT PIN.
// This is a genuine no-lost-update regression test for same-member accumulation across two
// sessions. It does NOT discriminate S1's `FOR UPDATE` on the fees row: removing that lock was
// measured and this test stayed GREEN, because Postgres already serialises this particular race
// one layer down -- either the UNIQUE (fee_id, team_member_id) constraint blocks the concurrent
// ON CONFLICT insert of the first-ever assignment, or, once the row exists, S3's
// MATERIALIZED ... FOR UPDATE OF fa locks that same row directly.
// S1 is therefore DEFENSIVE: it serialises the whole S0-S4 batch (shell creation, multi-member
// and multi-currency sweep, prune) rather than fixing a demonstrated lost update. An attempt to
// build a discriminating multi-member case did not produce one either, since READ COMMITTED
// hands each statement a fresh snapshot and a concurrent session's uncommitted rows are
// invisible to S3's lock CTE. The lock is kept because removing a lock from a money path on the
// strength of "I could not break it" is not a good trade -- but do not read this test as proof
// that it is required.
describe('training_period_charges — concurrency', () => {
  it.effect(
    'two connections confirming the SAME member on DIFFERENT trainings in the same team-month, ' +
      'interleaved so B starts before A commits, both land -> final amount = 2 x price ' +
      '(no lost update)',
    () =>
      Effect.scoped(
        TestClock.withLive(
          Effect.gen(function* () {
            const { team, captain } = yield* seedTeam('concurrency');
            const member = yield* addBilledMember(team.id, 'concurrency-member');
            yield* setDefaultPlanPrice(team.id, 100);
            const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
            const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);

            const sql = yield* SqlClient.SqlClient.asEffect();
            const sql2 = yield* secondTestPgClient;

            const reachedA = yield* Deferred.make<void>();
            const releaseA = yield* Deferred.make<void>();

            // Connection A: the INSERT fires the trigger, which acquires S1's `FOR UPDATE` on the
            // period's fees row and finishes its own recompute — but the transaction stays OPEN
            // (and every lock it took stays held) until `releaseA` fires.
            const fiberA = yield* Effect.forkChild(
              Effect.result(
                sql.withTransaction(
                  Effect.gen(function* () {
                    yield* sql`
                  INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at, confirmed_by)
                  VALUES (${t1.id}, ${member.id}, true, now(), ${captain.id})
                `;
                    yield* Deferred.succeed(reachedA, undefined);
                    yield* Deferred.await(releaseA);
                  }),
                ),
              ),
            );
            yield* Deferred.await(reachedA);

            // Connection B: a SEPARATE session, confirming a DIFFERENT training for the SAME
            // member — its own INSERT fires the same trigger for the SAME (team, period), and
            // blocks on the row lock A is still holding.
            const fiberB = yield* Effect.forkChild(
              Effect.result(
                sql2.withTransaction(
                  Effect.gen(function* () {
                    yield* sql2`
                  INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at, confirmed_by)
                  VALUES (${t2.id}, ${member.id}, true, now(), ${captain.id})
                `;
                  }),
                ),
              ),
            );
            // Give B enough time to actually reach and block on the lock before A releases.
            yield* Effect.sleep('200 millis');
            yield* Deferred.succeed(releaseA, undefined);

            const resultA = yield* Fiber.join(fiberA);
            const resultB = yield* Fiber.join(fiberB);
            expect(resultA._tag).toBe('Success');
            expect(resultB._tag).toBe('Success');

            const fees = yield* trainingFees(team.id);
            expect(fees).toHaveLength(1);
            const fee = fees[0];
            if (fee === undefined) throw new Error('expected a fee row');
            const assignment = yield* assignmentFor(fee.id, member.id);
            expect(
              assignment?.amount_minor,
              'no lost update — BOTH trainings must be counted',
            ).toBe('200');
          }),
        ),
      ).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 16. CHARACTERISATION — cross-currency reassignment of an ALREADY-PAID member
//
// Not a regression test for the "manage assigned members" story: this is PRE-EXISTING engine
// behaviour (`updateMembershipPlan`'s full-replace already rewrites a plan's `currency`). They
// are here because §B.5's bulk endpoint turns it from a per-member accident into one click for
// N members, and A.1 got the mechanics wrong on the first pass — the corrected reading is
// pinned here so the next reader does not have to re-derive it from the plpgsql.
//
// THESE PIN TODAY'S BEHAVIOUR, NOT DESIRED BEHAVIOUR. The first test's two-currency outcome is
// the bug §D's deferred `team_members.membership_plan_id` trigger is meant to fix. When that
// lands these go red BY DESIGN — rewrite them to the new expectation, do not read the failure
// as a regression. The two control tests (same currency, unpaid) stay: without them the first
// test reads as "moving a paid member always double-bills", which is false.
//
// The mechanics, in two lines of the migration:
//   S3 clamps the stale row to GREATEST(COALESCE(charge, 0), paid_minor) = paid_minor, NOT 0
//     (`1793200000_training_period_fees.ts:229`);
//   S4 then refuses to delete it — its guard is `amount_minor = 0 AND paid_minor = 0 AND NOT
//     EXISTS (... payments ...)` (`:244-246`), and a paid row fails all three.
// ---------------------------------------------------------------------------

describe('training_period_charges — cross-currency move of an ALREADY-PAID member', () => {
  it.effect(
    'leaves TWO open assignments in TWO currencies for the same attendance, and the finance ' +
      'overview reports the member under both',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('xcur-paid');
        const member = yield* addBilledMember(team.id, 'xcur-paid-member');
        yield* setDefaultPlanPrice(team.id, 100, 'CZK');

        const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(t1, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        const czkFee = (yield* trainingFees(team.id))[0];
        if (czkFee === undefined) throw new Error('expected a CZK fee');
        const czkAssignment = yield* assignmentFor(czkFee.id, member.id);
        if (czkAssignment === undefined) throw new Error('expected a CZK assignment');
        expect(czkAssignment.amount_minor).toBe('100');

        // The member pays their CZK charge in full — this is the ONLY thing that makes the
        // stale row survive the sweep below.
        const payments = yield* PaymentsRepository.asEffect();
        yield* payments.insert({
          feeAssignmentId: czkAssignment.id as never,
          teamMemberId: member.id,
          amountMinor: 100,
          method: 'cash',
          paidAt: DateTime.fromDateUnsafe(NOW),
          note: Option.none(),
          recordedByUserId: captain.user_id as never,
        });

        // The reassignment itself — a raw FK write, exactly the shape `reassignMembershipPlan`
        // performs. It fires NO trigger of its own (A.1): nothing happens until the next
        // attendance write lands in the period.
        const eurPlan = yield* createPlan(team.id, 8, 'EUR', 'Euro plan');
        yield* setMemberPlanRaw(member.id, eurPlan.id);

        const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
        yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

        const stale = yield* assignmentFor(czkFee.id, member.id);
        expect(stale, 'S4 cannot delete a row with paid_minor > 0').toBeDefined();
        expect(stale?.amount_minor, 'S3 clamps it to paid_minor, never to 0').toBe('100');
        expect(stale?.paid_minor).toBe('100');
        expect(stale?.stored_status).toBe('active');

        const eurFee = (yield* trainingFees(team.id)).find((f) => f.currency === 'EUR');
        if (eurFee === undefined) throw new Error('expected a EUR fee');
        const fresh = yield* assignmentFor(eurFee.id, member.id);
        expect(fresh, 'the EUR side re-prices the WHOLE month').toBeDefined();
        expect(fresh?.amount_minor).toBe('16');
        expect(fresh?.paid_minor).toBe('0');

        // What a treasurer actually sees: the same two trainings, billed twice, in two
        // currencies — one settled, one outstanding.
        const overview = yield* FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        );
        const memberRows = overview.filter((r) => r.teamMemberId === member.id);
        expect(memberRows.map((r) => r.currency).sort()).toEqual(['CZK', 'EUR']);
      }).pipe(Effect.provide(TestLayer)),
  );

  // The control on the CURRENCY axis: a paid member moved between two plans of the SAME
  // currency lands on ONE assignment, re-priced for the whole month. Without this, the test
  // above reads as "moving a paid member always double-bills", which is false and sends the
  // next reader after the wrong fix.
  it.effect('a SAME-currency move of a paid member leaves exactly ONE assignment, re-priced', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('samecur-paid');
      const member = yield* addBilledMember(team.id, 'samecur-paid-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK');

      const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(t1, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      const czkFee = (yield* trainingFees(team.id))[0];
      if (czkFee === undefined) throw new Error('expected a CZK fee');
      const assignment = yield* assignmentFor(czkFee.id, member.id);
      if (assignment === undefined) throw new Error('expected a CZK assignment');

      const payments = yield* PaymentsRepository.asEffect();
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 100,
        method: 'cash',
        paidAt: DateTime.fromDateUnsafe(NOW),
        note: Option.none(),
        recordedByUserId: captain.user_id as never,
      });

      const premium = yield* createPlan(team.id, 250, 'CZK', 'Premium');
      yield* setMemberPlanRaw(member.id, premium.id);

      const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
      yield* confirm(t2, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      expect(yield* trainingFees(team.id), 'one currency, one fee row').toHaveLength(1);
      const after = yield* assignmentFor(czkFee.id, member.id);
      expect(after?.amount_minor, 'both trainings at the NEW price').toBe('500');
      expect(after?.paid_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The control on the PAYMENT axis, in the shape bulk actually produces: ONE sweep moving
  // TWO members, one paid and one not. Both branches of S4's guard run inside the same
  // recompute, so the outcome is visibly asymmetric — the paid member keeps a stale CZK row,
  // the unpaid one does not.
  it.effect(
    'one bulk sweep, two members: only the PAID one keeps a stale assignment in the old currency',
    () =>
      Effect.gen(function* () {
        const { team, captain } = yield* seedTeam('bulk-xcur');
        const paid = yield* addBilledMember(team.id, 'bulk-xcur-paid');
        const unpaid = yield* addBilledMember(team.id, 'bulk-xcur-unpaid');
        yield* setDefaultPlanPrice(team.id, 100, 'CZK');

        const t1 = yield* createTraining(team.id, captain.id, TRAINING_START);
        yield* confirm(t1, team.id, captain.id, [
          { team_member_id: paid.id, present: true },
          { team_member_id: unpaid.id, present: true },
        ]);

        const czkFee = (yield* trainingFees(team.id))[0];
        if (czkFee === undefined) throw new Error('expected a CZK fee');
        const paidAssignment = yield* assignmentFor(czkFee.id, paid.id);
        if (paidAssignment === undefined) throw new Error('expected a CZK assignment');
        const payments = yield* PaymentsRepository.asEffect();
        yield* payments.insert({
          feeAssignmentId: paidAssignment.id as never,
          teamMemberId: paid.id,
          amountMinor: 100,
          method: 'cash',
          paidAt: DateTime.fromDateUnsafe(NOW),
          note: Option.none(),
          recordedByUserId: captain.user_id as never,
        });

        // The bulk move: both members, one statement, one new currency.
        const eurPlan = yield* createPlan(team.id, 8, 'EUR', 'Euro plan');
        yield* setMemberPlanRaw(paid.id, eurPlan.id);
        yield* setMemberPlanRaw(unpaid.id, eurPlan.id);

        const t2 = yield* createTraining(team.id, captain.id, TRAINING_START_2);
        yield* confirm(t2, team.id, captain.id, [
          { team_member_id: paid.id, present: true },
          { team_member_id: unpaid.id, present: true },
        ]);

        expect(yield* assignmentFor(czkFee.id, paid.id), 'paid -> survives').toBeDefined();
        expect(yield* assignmentFor(czkFee.id, unpaid.id), 'unpaid -> pruned').toBeUndefined();

        const eurFee = (yield* trainingFees(team.id)).find((f) => f.currency === 'EUR');
        if (eurFee === undefined) throw new Error('expected a EUR fee');
        expect((yield* assignmentFor(eurFee.id, paid.id))?.amount_minor).toBe('16');
        expect((yield* assignmentFor(eurFee.id, unpaid.id))?.amount_minor).toBe('16');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// The per-period free-training allowance (1793400000)
// ---------------------------------------------------------------------------

// A third training instant, still inside the same UTC month as `NOW` and still before it, so
// `confirmAttendance`'s `start_at <= now()` guard passes — same construction as
// `TRAINING_START` / `TRAINING_START_2`.
const TRAINING_START_3 = new Date(NOW.getTime() - 15 * 60 * 1000);

describe('training_period_charges — free trainings included (all-time)', () => {
  it.effect('an allowance BELOW the month’s attendance bills only the excess', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-partial');
      const member = yield* addBilledMember(team.id, 'allowance-partial-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);

      for (const startAt of [TRAINING_START, TRAINING_START_2, TRAINING_START_3]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      // 3 attended - 2 free = 1 billable x 100.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an allowance that COVERS the month produces no fee row at all', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-covers');
      const member = yield* addBilledMember(team.id, 'allowance-covers-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 5);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      // No empty `fees` shell either — shells are never deleted, so not creating one is the
      // only way the treasurer's fee list stays clean for a month nobody owes anything in.
      expect(yield* trainingFees(team.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an allowance EXACTLY equal to attendance bills nothing (boundary)', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-exact');
      const member = yield* addBilledMember(team.id, 'allowance-exact-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);

      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      expect(yield* trainingFees(team.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );

  // The point of `membership_plans_pricing_recompute_trg`: without it the captain sets an
  // allowance and the month's fee does not move until the next attendance write.
  it.effect('raising the allowance re-prices the OPEN period immediately', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-live');
      const member = yield* addBilledMember(team.id, 'allowance-live-member');
      yield* setDefaultPlanPrice(team.id, 100);

      for (const startAt of [TRAINING_START, TRAINING_START_2, TRAINING_START_3]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');

      // No attendance write here — the plan edit alone must move the money.
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);

      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Falling to zero is the S4 path, reached through the plan edit rather than an un-tick.
  it.effect('an allowance that swallows the whole charge PRUNES the unpaid assignment', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-prune');
      const member = yield* addBilledMember(team.id, 'allowance-prune-member');
      yield* setDefaultPlanPrice(team.id, 100);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 3);

      expect(yield* assignmentFor(fee.id, member.id)).toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  // The GREATEST(..., paid_minor) clamp still owns a member who ALREADY PAID. A late allowance
  // must never leave amount_minor < paid_minor — FinancesOverviewPage subtracts them raw, so a
  // single such row would understate the whole team's outstanding KPI.
  it.effect('a late allowance cannot drop an already-PAID assignment below paid_minor', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-paid');
      const member = yield* addBilledMember(team.id, 'allowance-paid-member');
      yield* setDefaultPlanPrice(team.id, 100);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      const assignment = yield* assignmentFor(fee.id, member.id);
      if (assignment === undefined) throw new Error('expected an assignment');

      const payments = yield* PaymentsRepository.asEffect();
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 100,
        method: 'cash',
        paidAt: DateTime.fromDateUnsafe(NOW),
        note: Option.none(),
        recordedByUserId: captain.user_id as never,
      });

      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 3);

      const after = yield* assignmentFor(fee.id, member.id);
      expect(after, 'a paid-against assignment is never pruned').toBeDefined();
      expect(after?.amount_minor).toBe('100');
      expect(after?.paid_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // Approved scope decision: the member's CURRENT plan applies to the WHOLE period, exactly as
  // `price_per_training_minor` already does. No proration, no carry — `training_period_charges`
  // resolves the plan at recompute time and has no record of what it was earlier in the month.
  it.effect('switching plan mid-period applies the NEW allowance to the whole month', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-switch');
      const member = yield* addBilledMember(team.id, 'allowance-switch-member');
      yield* setDefaultPlanPrice(team.id, 100);

      for (const startAt of [TRAINING_START, TRAINING_START_2, TRAINING_START_3]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }
      const fees = yield* trainingFees(team.id);
      const fee = fees[0];
      if (fee === undefined) throw new Error('expected a fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');

      // A second plan, same price and currency, but with an allowance.
      const generous = yield* createPlan(team.id, 100, 'CZK', 'Generous', 2);
      yield* selectPlanForMember(member.id, team.id, generous.id);

      // The selection itself does not recompute (no trigger on team_members); the next
      // attendance write does — and it must bill the whole month at the NEW allowance.
      const extra = yield* createTraining(team.id, captain.id, TRAINING_START_3);
      yield* confirm(extra, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      // 4 attended - 2 free = 2 billable x 100.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('200');
    }).pipe(Effect.provide(TestLayer)),
  );

  // The allowance must not become a back door around the opt-in gate: a plan that charges
  // nothing per training still produces no rows, allowance or not.
  it.effect('an allowance on a free plan changes nothing', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('allowance-free-plan');
      const member = yield* addBilledMember(team.id, 'allowance-free-plan-member');
      yield* setDefaultPlanPrice(team.id, 0, 'CZK', 4);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      expect(yield* trainingFees(team.id)).toHaveLength(0);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 21. The ALL-TIME allowance
// ---------------------------------------------------------------------------
//
// Everything above this line uses CURRENT-month attendance only, where `prior` is empty and the
// old per-period semantics and the new all-time ones agree exactly. The cases below are the ones
// that do NOT agree, and each comment says whether the case DISCRIMINATES (it goes red against a
// per-period implementation) or is only a REGRESSION NET (it would pass under both).

describe('training_period_charges — the ALL-TIME allowance across periods', () => {
  // THE ACCEPTANCE TEST, and a DISCRIMINATOR: under the old per-period formula the current month
  // sees a fresh allowance of 2 against 2 attended and produces NO FEE AT ALL, so this single case
  // is what makes the fix provable.
  it.effect('an allowance consumed in a PAST period is NOT refreshed in the current one', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-consumed');
      const member = yield* addBilledMember(team.id, 'alltime-consumed-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);
      // Anchor AFTER the allowance — setting it 0 -> 2 just stamped the anchor to now().
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }
      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fees = yield* trainingFees(team.id);
      expect(fees, 'a past period is never billed, so exactly one fee row').toHaveLength(1);
      const fee = feeForPeriod(fees, PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // prior 2 => free_left 0 => both current trainings chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('200');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR: the old formula gives no fee (2 attended vs a fresh allowance of 3).
  it.effect('a PARTIALLY consumed allowance carries its remainder forward', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-partial');
      const member = yield* addBilledMember(team.id, 'alltime-partial-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 3);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }
      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fee = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // prior 2 => free_left 1 => 2 attended, 1 chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR, and the ONLY case that fails against an INSTANT-aligned `prior` lower bound.
  // The anchor is stamped at day 16 of the past month; both past attendances are on day 15, i.e.
  // strictly BEFORE the anchor instant but in the SAME period as it. `prior` compares
  // training_period_start on both sides, so they count. With an instant floor they would fall out
  // of `prior` while still being covered by their own month's pass — four free trainings on a
  // two-training allowance.
  it.effect('an allowance burned earlier in the ANCHOR MONTH does not come back', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-anchor-month');
      const member = yield* addBilledMember(team.id, 'alltime-anchor-month-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, PAST_MONTH_MID);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }
      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fee = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // prior 2 (the anchor's own month counts IN FULL) => free_left 0 => 2 chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('200');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR at the third step (old formula: 3 attended vs a fresh 3 => still no fee). The
  // two `[]` assertions are also the no-empty-shell pin: shells are never deleted, so NOT creating
  // one is the entire job of the `WHERE attended > free_left` drop.
  it.effect('a member crossing the allowance MID-period', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-crossing');
      const member = yield* addBilledMember(team.id, 'alltime-crossing-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 3);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      const past = yield* createTraining(team.id, captain.id, PAST_MONTH_START);
      yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      // free_left is 2 from here on.
      const first = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(first, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      expect(yield* trainingFees(team.id), 'no shell on the first free training').toEqual([]);

      const second = yield* createTraining(team.id, captain.id, TRAINING_START_2);
      yield* confirm(second, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      expect(yield* trainingFees(team.id), 'no shell on the last free training').toEqual([]);

      const third = yield* createTraining(team.id, captain.id, TRAINING_START_3);
      yield* confirm(third, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = feeForPeriod(fees, PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // REGRESSION NET for the fee SHAPE (exactly one row, no past-period row), sized so that it also
  // discriminates: at 3 past + 2 current against an allowance of 4 the old per-period formula
  // still gives no fee. Do not soften the numbers — a larger allowance with fewer attendances
  // would pass under BOTH semantics and this case would stop proving anything.
  it.effect('the all-time sum across both periods is what is charged', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-sum');
      const member = yield* addBilledMember(team.id, 'alltime-sum-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 4);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2, PAST_MONTH_START_3]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }
      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      const fee = feeForPeriod(fees, PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // prior 3 => free_left 1 => 2 attended, 1 chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // REGRESSION NET, NOT idempotency evidence — say so rather than overclaiming.
  // `training_period_charges` contains no `now()` and no state, so a double recompute is
  // deterministic for ANY implementation of it; this only goes red if someone writes state into
  // the function or makes the recompute churn ids.
  it.effect('recomputing the same period twice changes nothing', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-stable');
      const member = yield* addBilledMember(team.id, 'alltime-stable-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }
      for (const startAt of [TRAINING_START, TRAINING_START_2]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }
      const before = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
      if (before === undefined) throw new Error('expected a CURRENT-period fee row');
      const assignmentBefore = yield* assignmentFor(before.id, member.id);

      yield* recomputePeriod(team.id, PERIOD_START);
      yield* recomputePeriod(team.id, PERIOD_START);

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(1);
      expect(feeForPeriod(fees, PERIOD_START)?.id).toBe(before.id);
      const after = yield* assignmentFor(before.id, member.id);
      expect(after?.id).toBe(assignmentBefore?.id);
      expect(after?.amount_minor).toBe('200');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATES a `created_at` anchor (which would give '300' — the seeded default plan predates
  // every training, so `prior` would be 2 and nobody would ever get the allowance) from the anchor
  // COLUMN. It does NOT discriminate a full revert to per-period semantics, which lands on the
  // same '100' — do not count this among the cases that prove the fix.
  it.effect('setting an allowance on the seeded default plan anchors at the EDIT', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-edit-anchor');
      const member = yield* addBilledMember(team.id, 'alltime-edit-anchor-member');

      // Attendance BEFORE the manager sets anything. No price yet, so no fee either.
      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }

      // No setPlanAnchor here on purpose: this edit is what stamps it.
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);

      for (const startAt of [TRAINING_START, TRAINING_START_2, TRAINING_START_3]) {
        const training = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(training, team.id, captain.id, [
          { team_member_id: member.id, present: true },
        ]);
      }

      const fee = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // The anchor's period IS the current period, so prior 0 => free_left 2 => 1 chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR against the rejected PER-MEMBER anchor (D2): with the anchor stamped at plan
  // SELECTION, moving to B would reset `prior` to 0 and produce no fee — the farming hole, reachable
  // by any member through the self-service `selectMembershipPlan`. Plan-level and equally old means
  // the burned 2 still count.
  it.effect('switching to an EQUALLY OLD plan does not grant a fresh allowance', () =>
    Effect.gen(function* () {
      const { team, captain } = yield* seedTeam('alltime-switch-old');
      const member = yield* addBilledMember(team.id, 'alltime-switch-old-member');
      yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);
      yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

      const planB = yield* createPlan(team.id, 100, 'CZK', 'Older B', 2);
      yield* setPlanAnchor(planB.id, OLD_ANCHOR);

      for (const startAt of [PAST_MONTH_START, PAST_MONTH_START_2]) {
        const past = yield* createTraining(team.id, captain.id, startAt);
        yield* confirm(past, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      }

      yield* selectPlanForMember(member.id, team.id, planB.id);

      const training = yield* createTraining(team.id, captain.id, TRAINING_START);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);

      const fee = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
      if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
      // free_left is 0 under B too.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 22. D5 — a past-period change moves the CURRENT period
// ---------------------------------------------------------------------------

/** Builds the shared starting state for the D5 and paid-clamp cases:
 *  allowance 2 at 100/training, anchored two months back, 3 CURRENT-month attendances (=> '100'),
 *  then 2 PAST-month attendances confirmed afterwards with NO current-period write following
 *  them — which is what makes the current period's move attributable to the past-period write
 *  alone. Ends at '300'. */
const pastCorrectionState = (username: string) =>
  Effect.gen(function* () {
    const { team, captain } = yield* seedTeam(username);
    const member = yield* addBilledMember(team.id, `${username}-member`);
    yield* setDefaultPlanPrice(team.id, 100, 'CZK', 2);
    yield* setPlanAnchor((yield* defaultPlan(team.id)).id, OLD_ANCHOR);

    const currentTrainings: EventRow[] = [];
    for (const startAt of [TRAINING_START, TRAINING_START_2, TRAINING_START_3]) {
      const training = yield* createTraining(team.id, captain.id, startAt);
      yield* confirm(training, team.id, captain.id, [{ team_member_id: member.id, present: true }]);
      currentTrainings.push(training);
    }
    const fee = feeForPeriod(yield* trainingFees(team.id), PERIOD_START);
    if (fee === undefined) throw new Error('expected a CURRENT-period fee row');
    expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('100');

    const pastTraining1 = yield* createTraining(team.id, captain.id, PAST_MONTH_START);
    yield* confirm(pastTraining1, team.id, captain.id, [
      { team_member_id: member.id, present: true },
    ]);
    const pastTraining2 = yield* createTraining(team.id, captain.id, PAST_MONTH_START_2);
    yield* confirm(pastTraining2, team.id, captain.id, [
      { team_member_id: member.id, present: true },
    ]);

    return { team, captain, member, fee, currentTrainings, pastTraining1, pastTraining2 };
  });

describe('training_period_charges — a past-period change moves the CURRENT period (D5)', () => {
  // DISCRIMINATOR for the `event_attendance_training_recompute` half of D5: without the second,
  // current-period `recompute_training_period_fees` call the past-period write early-returns and
  // this stays at '100'.
  it.effect('confirming attendance on a PAST training re-prices the OPEN period', () =>
    Effect.gen(function* () {
      const { team, member, fee } = yield* pastCorrectionState('d5-confirm');

      // prior 2 => free_left 0 => all 3 current trainings chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');
      const fees = yield* trainingFees(team.id);
      expect(fees, 'a past period is still never billed').toHaveLength(1);
      expect(feeForPeriod(fees, PERIOD_START)?.id).toBe(fee.id);
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR for the `events_training_recompute` half of D5 — the UN-charge direction, where
  // `free_left` goes UP. Without it the amount stays at '300'.
  it.effect('cancelling a PAST training gives the allowance back to the OPEN period', () =>
    Effect.gen(function* () {
      const { member, fee, pastTraining2 } = yield* pastCorrectionState('d5-cancel');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');

      const events = yield* EventsRepository.asEffect();
      yield* events.cancelEvent(pastTraining2.id);

      // prior 1 => free_left 1 => 3 attended, 2 chargeable.
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('200');
    }).pipe(Effect.provide(TestLayer)),
  );

  // DISCRIMINATOR, and the ONLY case in the suite that runs the recompute loop across a FUTURE
  // period — i.e. the exact path the rejected "handle old/new, then append the current period
  // last" ordering got wrong. Ascending is the only total order available there, so this case is
  // the regression net for the 40P01 it would deadlock on. The next-period row is also new
  // behaviour: under per-period semantics 1 attended against an allowance of 2 produced no row.
  //
  // TWO fees rows — select by period, never by index.
  it.effect('moving a past training into the FUTURE re-prices BOTH the open and next period', () =>
    Effect.gen(function* () {
      const { team, member, fee, pastTraining2 } = yield* pastCorrectionState('d5-future');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');

      // A RESCHEDULE of an already-confirmed event, not a confirmation of a future one —
      // `confirmAttendance`'s `start_at <= now()` guard would refuse the latter.
      const events = yield* EventsRepository.asEffect();
      yield* events.updateEvent({
        id: pastTraining2.id,
        title: pastTraining2.title,
        eventType: 'training',
        trainingTypeId: Option.none(),
        description: Option.none(),
        startAt: DateTime.fromDateUnsafe(NEXT_MONTH_MID),
        endAt: Option.none(),
        location: Option.none(),
      });

      const fees = yield* trainingFees(team.id);
      expect(fees).toHaveLength(2);

      const openFee = feeForPeriod(fees, PERIOD_START);
      if (openFee === undefined) throw new Error('expected a CURRENT-period fee row');
      // past prior drops to 1 => free_left 1 => 3 attended, 2 chargeable.
      expect((yield* assignmentFor(openFee.id, member.id))?.amount_minor).toBe('200');

      const nextFee = feeForPeriod(fees, NEXT_PERIOD_START);
      if (nextFee === undefined) throw new Error('expected a NEXT-period fee row');
      // The moved event's attendance rows travel with it: 1 attended next period, prior = the past
      // month's 1 + the current month's 3 = 4 => free_left 0 => 1 chargeable.
      expect((yield* assignmentFor(nextFee.id, member.id))?.amount_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );

  // REGRESSION NET, and explicitly NOT a test of the `confirmed_at` guard in
  // `event_attendance_training_recompute`. An unconfirmed row contributes to neither `in_period`
  // nor `prior`, so this passes with or WITHOUT that guard — the guard's only effect is COST (it
  // keeps a captain's 20-member pre-tick off 20 full current-period recomputes), which no amount
  // assertion can observe. The one observable difference is lock acquisition, and testing that
  // needs a two-session `secondTestPgClient` variant; write it only if the guard is questioned.
  it.effect('a pre-tick on a past training moves no money', () =>
    Effect.gen(function* () {
      const { team, captain, member, fee } = yield* pastCorrectionState('d5-pretick');
      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');

      const extraPast = yield* createTraining(team.id, captain.id, PAST_MONTH_START_3);
      // Raw SQL: `confirmAttendance` always stamps `confirmed_at`, so a pre-tick is unreachable
      // through the repository.
      const sql = yield* SqlClient.SqlClient.asEffect();
      yield* sql`
        INSERT INTO event_attendance (event_id, team_member_id, present, confirmed_at)
        VALUES (${extraPast.id}, ${member.id}, true, NULL)
      `;

      expect((yield* assignmentFor(fee.id, member.id))?.amount_minor).toBe('300');
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 23. The paid clamp on an ALL-TIME un-charge
// ---------------------------------------------------------------------------

describe('training_period_charges — the paid clamp on an ALL-TIME un-charge', () => {
  // `free_left` going UP is new in this PR: under per-period semantics a past-period change could
  // not move the current period at all, so this un-charge path did not exist. S3's
  // `GREATEST(COALESCE(c.amount_minor, 0), l.paid_minor)` is the only thing between it and
  // `amount_minor < paid_minor`, which `FinancesOverviewPage` subtracts raw and would use to
  // understate the whole team's outstanding KPI.
  it.effect('a past-period correction cannot drop an assignment below paid_minor', () =>
    Effect.gen(function* () {
      const { team, captain, member, fee, pastTraining1, pastTraining2 } =
        yield* pastCorrectionState('clamp-paid');
      const assignment = yield* assignmentFor(fee.id, member.id);
      if (assignment === undefined) throw new Error('expected an assignment');
      expect(assignment.amount_minor).toBe('300');

      const payments = yield* PaymentsRepository.asEffect();
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 300,
        method: 'cash',
        paidAt: DateTime.fromDateUnsafe(NOW),
        note: Option.none(),
        recordedByUserId: captain.user_id as never,
      });

      // Both past trainings gone => prior 0 => free_left 2 => 3 attended, 1 chargeable = 100.
      const events = yield* EventsRepository.asEffect();
      yield* events.cancelEvent(pastTraining1.id);
      yield* events.cancelEvent(pastTraining2.id);

      const after = yield* assignmentFor(fee.id, member.id);
      expect(after, 'a paid-against assignment is never pruned').toBeDefined();
      expect(after?.amount_minor, 'clamped to paid_minor, not recomputed down to 100').toBe('300');
      expect(after?.id, 'the same assignment row, not a churned one').toBe(assignment.id);
      expect(after?.paid_minor).toBe('300');
      expect(yield* trainingFees(team.id)).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  // S4's `paid_minor = 0` + `NOT EXISTS payments` prune guards. Deleting this assignment would
  // 23503 against `payments.fee_assignment_id`'s ON DELETE RESTRICT.
  it.effect('a partly-paid assignment that recomputes to 0 is NOT pruned', () =>
    Effect.gen(function* () {
      const { captain, member, fee, currentTrainings, pastTraining1, pastTraining2 } =
        yield* pastCorrectionState('clamp-zero');
      const assignment = yield* assignmentFor(fee.id, member.id);
      if (assignment === undefined) throw new Error('expected an assignment');
      expect(assignment.amount_minor).toBe('300');

      const payments = yield* PaymentsRepository.asEffect();
      yield* payments.insert({
        feeAssignmentId: assignment.id as never,
        teamMemberId: member.id,
        amountMinor: 100,
        method: 'cash',
        paidAt: DateTime.fromDateUnsafe(NOW),
        note: Option.none(),
        recordedByUserId: captain.user_id as never,
      });

      const events = yield* EventsRepository.asEffect();
      yield* events.cancelEvent(pastTraining1.id);
      yield* events.cancelEvent(pastTraining2.id);
      // prior 0 => free_left 2, and 2 attended is not > 2 => the member drops out of the function
      // entirely and S3's LEFT JOIN zeroes the assignment.
      const dropped = currentTrainings[0];
      if (dropped === undefined) throw new Error('expected a current training');
      yield* events.cancelEvent(dropped.id);

      const after = yield* assignmentFor(fee.id, member.id);
      expect(after, 'a partly-paid assignment is never pruned').toBeDefined();
      expect(after?.amount_minor).toBe('100');
      expect(after?.paid_minor).toBe('100');
    }).pipe(Effect.provide(TestLayer)),
  );
});
