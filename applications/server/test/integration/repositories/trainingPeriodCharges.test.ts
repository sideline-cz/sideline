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
// `trainingPeriodFees.test.ts`'s own fallback test). `PAST_MONTH_START` is the one deliberate
// exception, for the period-close test.

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

const setDefaultPlanPrice = (teamId: Team.TeamId, priceMinor: number, currency = 'CZK') =>
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
      expires_at: def.expires_at,
    });
  });

const createPlan = (teamId: Team.TeamId, priceMinor: number, currency: string, name: string) =>
  MembershipPlansRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insertMembershipPlan({
        team_id: teamId,
        name: Option.some(name as never),
        price_minor: 0 as never,
        currency: currency as never,
        price_per_training_minor: priceMinor as never,
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
