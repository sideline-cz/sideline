// TDD mode — tests written BEFORE PaymentsRepository implementation exists.
// These tests WILL FAIL until the developer implements PaymentsRepository
// and the DB trigger recompute_paid_minor.
//
// Required implementation:
//   - applications/server/src/repositories/FeesRepository.ts
//   - applications/server/src/repositories/FeeAssignmentsRepository.ts
//   - applications/server/src/repositories/PaymentsRepository.ts
//   - DB trigger: recompute_paid_minor on payments table

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  PaymentsRepository.Default,
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Payments Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        overview_channel_id: Option.none(),
        achievement_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const setupScenario = (discordId: string, username: string, guildId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('user', () => createUser(discordId, username)),
    Effect.bind('team', ({ user }) => createTeam(guildId, user.id)),
    Effect.bind('fee', ({ team }) =>
      FeesRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.insert({
            team_id: team.id,
            name: 'Payment Test Fee',
            description: Option.none(),
            amount_minor: 5000,
            currency: 'CZK',
            due_at: Option.none(),
          }),
        ),
      ),
    ),
    Effect.bind('member', ({ team, user }) =>
      TeamMembersRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.addMember({
            team_id: team.id,
            user_id: user.id,
            active: true,
            joined_at: undefined,
          }),
        ),
      ),
    ),
    Effect.bind('assignments', ({ fee, member }) =>
      FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) =>
          repo.bulkInsert({
            feeId: fee.id,
            memberIds: [(member as any).id],
            amountMinorOverride: Option.none(),
            dueAtOverride: Option.none(),
          }),
        ),
      ),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PaymentsRepository — insert + trigger recomputes paid_minor', () => {
  it.effect('insert creates payment and trigger updates paid_minor on assignment', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000001',
          'pay-user-1',
          '920100000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.bind('payment', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 2000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('refreshedAssignment', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(ctx.assignments[0]?.id)),
        ),
      ),
      Effect.tap(({ refreshedAssignment }) =>
        Effect.sync(() => {
          const assignment = Option.getOrThrow(refreshedAssignment);
          // Trigger should have updated paid_minor
          expect(assignment.paid_minor).toBe(2000);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PaymentsRepository — status computed from view', () => {
  it.effect('0 paid → pending status', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000002',
          'pay-user-2',
          '920200000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.bind('assignmentStatus', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByFee(ctx.fee.id)),
        ),
      ),
      Effect.tap(({ assignmentStatus }) =>
        Effect.sync(() => {
          // No payments yet → pending
          const assignment = assignmentStatus[0];
          expect(assignment).toBeDefined();
          expect(assignment?.computed_status).toBe('pending');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('partial payment → partial status', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000003',
          'pay-user-3',
          '920300000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 2000, // Partial: 2000 of 5000
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('assignmentStatus', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByFee(ctx.fee.id)),
        ),
      ),
      Effect.tap(({ assignmentStatus }) =>
        Effect.sync(() => {
          expect(assignmentStatus[0]?.computed_status).toBe('partial');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('full payment → paid status', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000004',
          'pay-user-4',
          '920400000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 5000, // Full amount
              method: 'bank_transfer',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('assignmentStatus', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByFee(ctx.fee.id)),
        ),
      ),
      Effect.tap(({ assignmentStatus }) =>
        Effect.sync(() => {
          expect(assignmentStatus[0]?.computed_status).toBe('paid');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('overpaid → still treated as paid (no overpaid status in v1)', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000005',
          'pay-user-5',
          '920500000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 6000, // Overpaid
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('assignmentStatus', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByFee(ctx.fee.id)),
        ),
      ),
      Effect.tap(({ assignmentStatus }) =>
        Effect.sync(() => {
          // v1 has no overpaid status — should be 'paid'
          expect(assignmentStatus[0]?.computed_status).toBe('paid');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PaymentsRepository — void', () => {
  it.effect('void sets voided fields and paid_minor recomputes to exclude voided payment', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000006',
          'pay-user-6',
          '920600000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.bind('payment', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 5000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.tap(({ payment, ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.void_(payment.id, {
              voidedByUserId: ctx.user.id,
              voidReason: 'Error entry',
              voidedAt: DateTime.fromDateUnsafe(new Date('2025-05-02T10:00:00Z')),
            }),
          ),
        ),
      ),
      Effect.bind('refreshedAssignment', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(ctx.assignments[0]?.id)),
        ),
      ),
      Effect.tap(({ refreshedAssignment }) =>
        Effect.sync(() => {
          const assignment = Option.getOrThrow(refreshedAssignment);
          // Voided payment should not count toward paid_minor
          expect(assignment.paid_minor).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('voided payment + new payment: paid_minor reflects only the new payment', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000007',
          'pay-user-7',
          '920700000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.bind('payment1', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 5000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      // Void the first payment
      Effect.tap(({ payment1, ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.void_(payment1.id, {
              voidedByUserId: ctx.user.id,
              voidReason: 'Mistake',
              voidedAt: DateTime.fromDateUnsafe(new Date('2025-05-02T10:00:00Z')),
            }),
          ),
        ),
      ),
      // Add a new correct payment
      Effect.tap(({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 3000,
              method: 'bank_transfer',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-03T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('refreshedAssignment', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(ctx.assignments[0]?.id)),
        ),
      ),
      Effect.tap(({ refreshedAssignment }) =>
        Effect.sync(() => {
          const assignment = Option.getOrThrow(refreshedAssignment);
          // Only the new 3000 payment counts
          expect(assignment.paid_minor).toBe(3000);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PaymentsRepository — status after voiding with past due_at', () => {
  it.effect('paid + voided + dueAt past = overdue after voiding', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        Effect.Do.pipe(
          Effect.bind('user', () => createUser('920000000000000008', 'pay-user-8')),
          Effect.bind('team', ({ user }) =>
            createTeam('920800000000000000' as Discord.Snowflake, user.id),
          ),
          Effect.bind('fee', ({ team }) =>
            FeesRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.insert({
                  team_id: team.id,
                  name: 'Overdue Test Fee',
                  description: Option.none(),
                  amount_minor: 5000,
                  currency: 'CZK',
                  // Due date in the past
                  due_at: Option.some(DateTime.fromDateUnsafe(new Date('2024-01-01T00:00:00Z'))),
                }),
              ),
            ),
          ),
          Effect.bind('member', ({ team, user }) =>
            TeamMembersRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.addMember({
                  team_id: team.id,
                  user_id: user.id,
                  active: true,
                  joined_at: undefined,
                }),
              ),
            ),
          ),
          Effect.bind('assignments', ({ fee, member }) =>
            FeeAssignmentsRepository.asEffect().pipe(
              Effect.andThen((repo) =>
                repo.bulkInsert({
                  feeId: fee.id,
                  memberIds: [(member as any).id],
                  amountMinorOverride: Option.none(),
                  dueAtOverride: Option.none(),
                }),
              ),
            ),
          ),
        ),
      ),
      // Pay in full
      Effect.bind('payment', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 5000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      // Void the payment → now overdue (past due_at, 0 paid)
      Effect.tap(({ payment, ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.void_(payment.id, {
              voidedByUserId: ctx.user.id,
              voidReason: 'Test void',
              voidedAt: DateTime.fromDateUnsafe(new Date('2025-05-02T10:00:00Z')),
            }),
          ),
        ),
      ),
      Effect.bind('assignmentStatus', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByFee(ctx.fee.id)),
        ),
      ),
      Effect.tap(({ assignmentStatus }) =>
        Effect.sync(() => {
          // Due in the past, 0 paid → overdue
          expect(assignmentStatus[0]?.computed_status).toBe('overdue');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PaymentsRepository — listByTeam', () => {
  it.effect('listByTeam filters by member', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000009',
          'pay-user-9',
          '920900000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.tap(({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 1000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      Effect.bind('payments', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.listByTeam(ctx.team.id, {
              memberId: Option.some((ctx.member as any).id),
              feeId: Option.none(),
              from: Option.none(),
              to: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ payments }) =>
        Effect.sync(() => {
          expect(payments).toHaveLength(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('PaymentsRepository — hard delete trigger', () => {
  it.effect('hard delete of payment via raw SQL also triggers paid_minor recompute', () =>
    Effect.Do.pipe(
      Effect.bind('ctx', () =>
        setupScenario(
          '920000000000000010',
          'pay-user-10',
          '921000000000000000' as Discord.Snowflake,
        ),
      ),
      Effect.bind('payment', ({ ctx }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: ctx.assignments[0]?.id,
              teamMemberId: (ctx.member as any).id,
              amountMinor: 5000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-05-01T10:00:00Z')),
              note: Option.none(),
              recordedByUserId: ctx.user.id,
            }),
          ),
        ),
      ),
      // Hard delete via internal test helper (not exposed on repo)
      Effect.tap(({ payment }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen(
            (repo) => (repo as any).hardDeleteForTest(payment.id) as Effect.Effect<void>,
          ),
        ),
      ),
      Effect.bind('refreshedAssignment', ({ ctx }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(ctx.assignments[0]?.id)),
        ),
      ),
      Effect.tap(({ refreshedAssignment }) =>
        Effect.sync(() => {
          const assignment = Option.getOrThrow(refreshedAssignment);
          // After hard delete, trigger should have set paid_minor back to 0
          expect(assignment.paid_minor).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
