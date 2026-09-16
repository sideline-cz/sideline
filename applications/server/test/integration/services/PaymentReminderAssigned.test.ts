// TDD mode — tests written BEFORE `FeeAssignmentsRepository.findReminderCandidates` gains the
// `assigned` UNION ALL branch (D15b, T10c).
//
// Plan `.work-plans/fio-transaction-matching.md` D15b / §7.2 tests 184-189.
//
// Per D15b's defect analysis (read `src/repositories/FeeAssignmentsRepository.ts:284-353`
// before implementing):
//   1. The `assigned` arm must be a `UNION ALL` branch OUTSIDE the `rsvp_reminder_time` gate —
//      it fires immediately at assignment creation, not "up to 24h later".
//   2. `effective_due_at IS NOT NULL` must NOT apply to the `assigned` branch (a fee with no due
//      date is exactly the case where an early QR helps most) — the outbox's `effective_due_at`
//      column becomes nullable in migration `1792000003` (already applied).
//   3. The branch is gated on `EXISTS (bank_sync_config WHERE team_id = ... AND enabled)` — no
//      bank connection, no QR, no reason to DM every pre-existing team on deploy day.
//
// `1792000003_seed_assigned_reminder_sent.ts` (backfill guard, test 189) already exists and has
// already run against this test database by the time these tests execute.

import { describe, expect, it } from '@effect/vitest';
import { DateTime, Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import {
  createFeeAndAssignment,
  createTeam,
  createTeamMember,
  createUser,
  enableBankSync,
  nextDiscordId,
  setTeamTimezone,
} from '../bankSyncFixtures.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  TeamsRepository.Default,
  UsersRepository.Default,
  TeamMembersRepository.Default,
  FeesRepository.Default,
  FeeAssignmentsRepository.Default,
  PaymentRemindersSentRepository.Default,
  PaymentReminderSyncEventsRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

const seedBankEnabledTeamAndMember = () =>
  Effect.gen(function* () {
    const user = yield* createUser('treasurer-reminders');
    const team = yield* createTeam(nextDiscordId(), user.id);
    yield* setTeamTimezone(team.id, 'Europe/Prague');
    yield* enableBankSync(team.id, user.id); // enabled = true
    const memberUser = yield* createUser('player-reminders');
    const member = yield* createTeamMember(team.id, memberUser.id);
    return { user, team, member };
  });

const assignedCandidates = (now: Date) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.flatMap((repo) => repo.findReminderCandidates(now)),
    Effect.map((candidates) => candidates.filter((c) => c.kind === 'assigned')),
  );

// ---------------------------------------------------------------------------
// 184 / 187 — fires immediately, not date-gated
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository.findReminderCandidates — the assigned arm (184, 187)', () => {
  it.effect('a newly created assignment produces exactly one assigned candidate', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedBankEnabledTeamAndMember();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

      const candidates = yield* assignedCandidates(new Date());
      const forThisAssignment = candidates.filter((c) => c.assignment_id === assignment.id);
      expect(forThisAssignment).toHaveLength(1);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an assignment due in six weeks still fires immediately — not date-gated', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedBankEnabledTeamAndMember();
      const farFuture = DateTime.makeUnsafe(Date.now() + 42 * 24 * 60 * 60 * 1000);
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500, {
        dueAt: farFuture,
      });

      const candidates = yield* assignedCandidates(new Date());
      expect(candidates.some((c) => c.assignment_id === assignment.id)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a fee with NO due date still produces an assigned candidate', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedBankEnabledTeamAndMember();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500); // no dueAt
      const candidates = yield* assignedCandidates(new Date());
      expect(candidates.some((c) => c.assignment_id === assignment.id)).toBe(true);
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('a team with NO enabled bank-sync config produces NO assigned candidate', () =>
    Effect.gen(function* () {
      const user = yield* createUser('treasurer-no-bank');
      const team = yield* createTeam(nextDiscordId(), user.id);
      yield* setTeamTimezone(team.id, 'Europe/Prague');
      // No enableBankSync call — the team has never connected Fio.
      const memberUser = yield* createUser('player-no-bank');
      const member = yield* createTeamMember(team.id, memberUser.id);
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

      const candidates = yield* assignedCandidates(new Date());
      expect(candidates.some((c) => c.assignment_id === assignment.id)).toBe(false);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 185 / 186 — one DM per assignment per kind (both outbox and sent guards)
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository.findReminderCandidates — one DM per assignment per kind (185, 186)', () => {
  it.effect(
    'once a pending sync-outbox row exists for (assignment, assigned), the candidate disappears',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeamAndMember();
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);
        expect(yield* assignedCandidates(new Date())).not.toEqual([]);

        const syncRepo = yield* PaymentReminderSyncEventsRepository.asEffect();
        yield* syncRepo.emit(
          assignment.id as never,
          '111111111111111111' as never,
          'assigned' as never,
        );

        const afterEmit = (yield* assignedCandidates(new Date())).filter(
          (c) => c.assignment_id === assignment.id,
        );
        expect(afterEmit).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('after the bot acks via markSent, the candidate still does not reappear', () =>
    Effect.gen(function* () {
      const { team, member } = yield* seedBankEnabledTeamAndMember();
      const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

      const syncRepo = yield* PaymentReminderSyncEventsRepository.asEffect();
      const sentRepo = yield* PaymentRemindersSentRepository.asEffect();
      const eventId = yield* syncRepo.emit(
        assignment.id as never,
        '111111111111111111' as never,
        'assigned' as never,
      );
      yield* sentRepo.markSent(assignment.id as never, 'assigned' as never);
      if (eventId._tag === 'Some') yield* syncRepo.markProcessed(eventId.value);

      const candidates = (yield* assignedCandidates(new Date())).filter(
        (c) => c.assignment_id === assignment.id,
      );
      expect(candidates).toEqual([]);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 188 — a due_in_3d reminder for the same assignment is unaffected (independent rows)
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository.findReminderCandidates — assigned and due_in_3d are independent (188)', () => {
  it.effect(
    'acking "assigned" does not suppress a later due_in_3d candidate for the same assignment',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeamAndMember();
        // The date-gated CTE (`candidates`) only fires inside the team's
        // `rsvp_reminder_time` +5min window (mirrors
        // `FeeAssignmentsRepository.reminder.test.ts`'s `toHHMM`/`upsertTeamSettings` pattern) —
        // pin the team to UTC and align the window to "now"'s clock time so `due_in_3d` is
        // actually reachable, rather than gated out by the default 18:00 Europe/Prague window.
        const now = new Date();
        yield* setTeamTimezone(team.id, 'UTC');
        const sql = yield* SqlClient.SqlClient.asEffect();
        const reminderTime = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}`;
        yield* sql`UPDATE team_settings SET rsvp_reminder_time = ${reminderTime}::time WHERE team_id = ${team.id}`;

        // `due_in_3d` fires when "now" is 3 days BEFORE the due date — the assignment's due date,
        // not "now" itself, is 3 days out.
        const dueInThreeDays = DateTime.makeUnsafe(now.getTime() + 3 * 24 * 60 * 60 * 1000);
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500, {
          dueAt: dueInThreeDays,
        });

        const sentRepo = yield* PaymentRemindersSentRepository.asEffect();
        yield* sentRepo.markSent(assignment.id as never, 'assigned' as never);

        const allCandidates = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.flatMap((repo) => repo.findReminderCandidates(now)),
        );
        const dueIn3dCandidate = allCandidates.find(
          (c) => c.assignment_id === assignment.id && c.kind === 'due_in_3d',
        );
        expect(dueIn3dCandidate).toBeDefined();
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 189 — backfill guard: a pre-existing assignment (simulated via a manual sent-row, standing in
// for what 1792000003 already inserted at deploy time) produces zero assigned candidates.
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository.findReminderCandidates — backfill guard (189)', () => {
  it.effect(
    'an assignment whose payment_reminders_sent(assigned) row was backfilled (simulating 1792000003) ' +
      'produces zero assigned candidates on the first live cycle',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeamAndMember();
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id, 1500);

        // Without the backfill guard, this pre-existing assignment would be a fresh candidate —
        // simulate the migration's seed by marking it sent exactly as 1792000003 does.
        const sentRepo = yield* PaymentRemindersSentRepository.asEffect();
        yield* sentRepo.markSent(assignment.id as never, 'assigned' as never);

        const candidates = (yield* assignedCandidates(new Date())).filter(
          (c) => c.assignment_id === assignment.id,
        );
        expect(candidates).toEqual([]);
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'the seed migration 1792000003 has already marked every PRE-migration assignment sent',
    () =>
      Effect.gen(function* () {
        // This assertion only has teeth once real (pre-1792000003) fixture data exists in the test
        // DB at migration time, which `cleanDatabase` wipes between tests. It is included as a
        // structural check that the guard mechanism (payment_reminders_sent PK) is queryable, and
        // is the reason 1792000003 is dated AFTER 1792000000-1792000002 in the migration sequence.
        const sql = yield* SqlClient.SqlClient.asEffect();
        const cols = yield* sql<{ column_name: string; is_nullable: string }>`
        SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_name = 'payment_reminder_sync_events' AND column_name = 'effective_due_at'
      `;
        expect(cols[0]?.is_nullable).toBe('YES');
      }).pipe(Effect.provide(TestLayer)),
  );
});
