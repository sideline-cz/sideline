// TDD mode — tests written BEFORE PaymentReminderCron implementation.
// These tests WILL FAIL until the developer implements:
//   - applications/server/src/services/PaymentReminderCron.ts
//   - FeeAssignmentsRepository.findReminderCandidates(now)
//   - PaymentReminderSyncEventsRepository (emit, findUnprocessed, markProcessed, markFailed)
//   - PaymentRemindersSentRepository (markSent)

import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { Discord, FeeAssignment, PaymentReminder, Team } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { paymentReminderCronEffect } from '~/services/PaymentReminderCron.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const GUILD_ID = '111111111111111111' as Discord.Snowflake;
const ASSIGNMENT_ID_1 = '00000000-0000-0000-0000-000000000040' as FeeAssignment.FeeAssignmentId;
const ASSIGNMENT_ID_2 = '00000000-0000-0000-0000-000000000041' as FeeAssignment.FeeAssignmentId;
const DISCORD_USER_ID = '222222222222222222' as Discord.Snowflake;

// ---------------------------------------------------------------------------
// Reminder candidate shape
// ---------------------------------------------------------------------------

type ReminderCandidate = {
  assignment_id: FeeAssignment.FeeAssignmentId;
  team_id: Team.TeamId;
  guild_id: Discord.Snowflake;
  user_discord_id: Discord.Snowflake;
  fee_name: string;
  currency: string;
  amount_minor: number;
  paid_minor: number;
  effective_due_at: Date;
  kind: PaymentReminder.PaymentReminderKind;
};

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

let reminderCandidates: ReminderCandidate[];
let emittedSyncRows: {
  assignment_id: FeeAssignment.FeeAssignmentId;
  kind: PaymentReminder.PaymentReminderKind;
}[];
let sentRows: {
  assignment_id: FeeAssignment.FeeAssignmentId;
  kind: PaymentReminder.PaymentReminderKind;
}[];

const resetStores = () => {
  reminderCandidates = [];
  emittedSyncRows = [];
  sentRows = [];
};

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const makeReminderCandidate = (
  assignmentId: FeeAssignment.FeeAssignmentId,
  kind: PaymentReminder.PaymentReminderKind,
  overrides: Partial<ReminderCandidate> = {},
): ReminderCandidate => ({
  assignment_id: assignmentId,
  team_id: TEAM_ID,
  guild_id: GUILD_ID,
  user_discord_id: DISCORD_USER_ID,
  fee_name: 'Test Fee',
  currency: 'CZK',
  amount_minor: 5000,
  paid_minor: 0,
  effective_due_at: new Date(),
  kind,
  ...overrides,
});

const makeMockFeeAssignmentsRepository = () =>
  Layer.succeed(FeeAssignmentsRepository, {
    findReminderCandidates: (_now: Date) => Effect.succeed(reminderCandidates),
    // Other methods are not called by the cron — stub them
    findById: () => Effect.succeed(Option.none()),
    findByFee: () => Effect.succeed([]),
    findByTeamMember: () => Effect.succeed([]),
    findByFeeAndMember: () => Effect.succeed(Option.none()),
    bulkInsert: () => Effect.succeed([]),
    update: () => Effect.die(new Error('Not implemented')),
  } as any);

const makeMockPaymentReminderSyncEventsRepository = () =>
  Layer.succeed(PaymentReminderSyncEventsRepository, {
    emit: (
      assignmentId: FeeAssignment.FeeAssignmentId,
      _guildId: Discord.Snowflake,
      kind: PaymentReminder.PaymentReminderKind,
    ) => {
      emittedSyncRows.push({ assignment_id: assignmentId, kind });
      return Effect.void;
    },
    findUnprocessed: () => Effect.succeed([]),
    markProcessed: () => Effect.void,
    markFailed: () => Effect.void,
  } as any);

const makeMockPaymentRemindersSentRepository = () =>
  Layer.succeed(PaymentRemindersSentRepository, {
    markSent: (
      assignmentId: FeeAssignment.FeeAssignmentId,
      kind: PaymentReminder.PaymentReminderKind,
    ) => {
      sentRows.push({ assignment_id: assignmentId, kind });
      return Effect.void;
    },
    existsForAssignmentKind: (
      assignmentId: FeeAssignment.FeeAssignmentId,
      kind: PaymentReminder.PaymentReminderKind,
    ) => Effect.succeed(sentRows.some((r) => r.assignment_id === assignmentId && r.kind === kind)),
  } as any);

const buildMockLayer = () =>
  Layer.mergeAll(
    makeMockFeeAssignmentsRepository(),
    makeMockPaymentReminderSyncEventsRepository(),
    makeMockPaymentRemindersSentRepository(),
  );

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('paymentReminderCronEffect', () => {
  it.effect('emits one sync row per candidate from findReminderCandidates', () => {
    reminderCandidates = [
      makeReminderCandidate(ASSIGNMENT_ID_1, 'due_today'),
      makeReminderCandidate(ASSIGNMENT_ID_2, 'overdue_3d'),
    ];

    return paymentReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedSyncRows).toHaveLength(2);
          const a1 = emittedSyncRows.find((r) => r.assignment_id === ASSIGNMENT_ID_1);
          const a2 = emittedSyncRows.find((r) => r.assignment_id === ASSIGNMENT_ID_2);
          expect(a1?.kind).toBe('due_today');
          expect(a2?.kind).toBe('overdue_3d');
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });

  it.effect(
    'running cron twice does NOT duplicate sync rows (unprocessed-sync exclusion prevents it)',
    () => {
      // Second cron tick: findReminderCandidates returns empty because the unprocessed
      // sync row blocks re-emission. The cron itself should just call emit once.
      // We simulate: first tick finds 1 candidate, second tick finds 0 (excluded by DB query).
      let callCount = 0;

      const TwoTickFeeAssignmentsLayer = Layer.succeed(FeeAssignmentsRepository, {
        findReminderCandidates: () => {
          callCount++;
          if (callCount === 1)
            return Effect.succeed([makeReminderCandidate(ASSIGNMENT_ID_1, 'due_today')]);
          // Second call: exclusion filter returns empty (unprocessed row exists in DB)
          return Effect.succeed([]);
        },
        findById: () => Effect.succeed(Option.none()),
        findByFee: () => Effect.succeed([]),
        findByTeamMember: () => Effect.succeed([]),
        findByFeeAndMember: () => Effect.succeed(Option.none()),
        bulkInsert: () => Effect.succeed([]),
        update: () => Effect.die(new Error('Not implemented')),
      } as any);

      const layer = Layer.mergeAll(
        TwoTickFeeAssignmentsLayer,
        makeMockPaymentReminderSyncEventsRepository(),
        makeMockPaymentRemindersSentRepository(),
      );

      return Effect.Do.pipe(
        // First tick
        Effect.tap(() => paymentReminderCronEffect.pipe(Effect.provide(layer))),
        // Second tick
        Effect.tap(() => paymentReminderCronEffect.pipe(Effect.provide(layer))),
        Effect.tap(() =>
          Effect.sync(() => {
            // Only one sync row emitted total — the second tick found no candidates
            expect(emittedSyncRows).toHaveLength(1);
          }),
        ),
        Effect.asVoid,
      ) as Effect.Effect<void, never, never>;
    },
  );

  it.effect(
    'voided-payment-reopens-eligibility: after bot acks due_today and payment is voided, cron emits overdue_3d',
    () => {
      // Scenario:
      // 1. Assignment is at due_today offset → cron emits due_today sync row
      // 2. Bot processes it → markReminderSent writes 'due_today' to sentRows
      // 3. Payment is voided → assignment is now overdue_3d
      // 4. findReminderCandidates returns overdue_3d (no sent row for that kind)
      // 5. Cron should emit overdue_3d sync row

      // Step 1: first tick finds due_today candidate
      reminderCandidates = [makeReminderCandidate(ASSIGNMENT_ID_1, 'due_today')];

      return paymentReminderCronEffect.pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            // Simulate bot ack: write sent row for due_today
            sentRows.push({ assignment_id: ASSIGNMENT_ID_1, kind: 'due_today' });
            // Simulate payment voided: now overdue_3d is the candidate
            reminderCandidates = [makeReminderCandidate(ASSIGNMENT_ID_1, 'overdue_3d')];
          }),
        ),
        Effect.tap(() => paymentReminderCronEffect),
        Effect.tap(() =>
          Effect.sync(() => {
            const overdueSyncs = emittedSyncRows.filter(
              (r) => r.assignment_id === ASSIGNMENT_ID_1 && r.kind === 'overdue_3d',
            );
            expect(overdueSyncs).toHaveLength(1);
          }),
        ),
        Effect.provide(buildMockLayer()),
        Effect.asVoid,
      );
    },
  );

  it.effect(
    'failed Discord send does not lose reminder — re-queued on next eligible cron tick',
    () => {
      // Scenario:
      // 1. Emit due_today sync row (first cron tick)
      // 2. Bot marks sync row as failed (processed_at set, NO sent row written)
      // 3. On next eligible cron tick, findReminderCandidates returns due_today again
      //    (because: sync row is now processed (excluded from unprocessed check), and no sent row)
      // 4. Cron emits a NEW due_today sync row

      let tickCount = 0;

      const RequeueFeeAssignmentsLayer = Layer.succeed(FeeAssignmentsRepository, {
        findReminderCandidates: () => {
          tickCount++;
          if (tickCount === 1) {
            // First tick: candidate available
            return Effect.succeed([makeReminderCandidate(ASSIGNMENT_ID_1, 'due_today')]);
          }
          // Second tick: the failed sync row is now processed (excluded from unprocessed check)
          // AND no sent row exists → candidate reappears
          return Effect.succeed([makeReminderCandidate(ASSIGNMENT_ID_1, 'due_today')]);
        },
        findById: () => Effect.succeed(Option.none()),
        findByFee: () => Effect.succeed([]),
        findByTeamMember: () => Effect.succeed([]),
        findByFeeAndMember: () => Effect.succeed(Option.none()),
        bulkInsert: () => Effect.succeed([]),
        update: () => Effect.die(new Error('Not implemented')),
      } as any);

      const layer = Layer.mergeAll(
        RequeueFeeAssignmentsLayer,
        makeMockPaymentReminderSyncEventsRepository(),
        makeMockPaymentRemindersSentRepository(),
      );

      return Effect.Do.pipe(
        // First tick: emits sync row
        Effect.tap(() => paymentReminderCronEffect.pipe(Effect.provide(layer))),
        // Bot marks failed — no sent row written (sentRows stays empty)
        // Second tick: candidate reappears (no unprocessed sync row, no sent row)
        Effect.tap(() => paymentReminderCronEffect.pipe(Effect.provide(layer))),
        Effect.tap(() =>
          Effect.sync(() => {
            // Both ticks emitted a due_today sync row for this assignment
            const dueTodaySyncs = emittedSyncRows.filter(
              (r) => r.assignment_id === ASSIGNMENT_ID_1 && r.kind === 'due_today',
            );
            expect(dueTodaySyncs).toHaveLength(2);
            // No sent row was ever written (bot failed)
            expect(sentRows).toHaveLength(0);
          }),
        ),
        Effect.asVoid,
      ) as Effect.Effect<void, never, never>;
    },
  );

  it.effect('does nothing when findReminderCandidates returns empty array', () => {
    reminderCandidates = [];

    return paymentReminderCronEffect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(emittedSyncRows).toHaveLength(0);
        }),
      ),
      Effect.provide(buildMockLayer()),
      Effect.asVoid,
    );
  });
});
