import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, PaymentReminder, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';
import { PaymentRemindersSentRepository } from '~/repositories/PaymentRemindersSentRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  PaymentsRepository.Default,
  PaymentRemindersSentRepository.Default,
  PaymentReminderSyncEventsRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
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
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Reminder Test Team',
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
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const createFee = (teamId: Team.TeamId, opts: { amountMinor?: number; currency?: string } = {}) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Reminder Fee',
        description: Option.none(),
        amount_minor: opts.amountMinor ?? 5000,
        currency: opts.currency ?? 'CZK',
        due_at: Option.none(),
      }),
    ),
  );

const addMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

/** Format a Date as HH:MM in UTC — used to set rsvp_reminder_time within the current window */
const toHHMM = (d: Date): string => {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

const upsertTeamSettings = (teamId: Team.TeamId, reminderTime: string) =>
  TeamSettingsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsert({
        teamId,
        eventHorizonDays: 30,
        minPlayersThreshold: 5,
        rsvpReminderDaysBefore: 1,
        rsvpReminderTime: reminderTime,
        remindersChannelId: Option.none(),
        timezone: 'UTC',
      }),
    ),
  );

/** Create a fee assignment with a specific effective_due_at (using dueAtOverride) */
const createAssignment = (feeId: Fee.FeeId, memberId: string, dueAt: Date, amountMinor?: number) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.bulkInsert({
        feeId,
        memberIds: [memberId as any],
        amountMinorOverride: amountMinor
          ? Option.some(amountMinor as Fee.AmountMinor)
          : Option.none(),
        dueAtOverride: Option.some(dueAt),
      }),
    ),
    Effect.map((rows) => rows[0]!),
  );

/** Returns a Date offset by `days` from base (UTC midnight) */
const daysFrom = (base: Date, days: number): Date => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository — findReminderCandidates', () => {
  it.effect('returns assignment matching due_in_3d when due_at = now + 3 days', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000001', 'rem-owner-1')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920100000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, daysFrom(now, 3)),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          expect(match?.kind).toBe('due_in_3d' satisfies PaymentReminder.PaymentReminderKind);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns assignment matching due_today when due_at = now', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000002', 'rem-owner-2')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920200000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, now),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          expect(match?.kind).toBe('due_today' satisfies PaymentReminder.PaymentReminderKind);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns overdue_3d when due_at = now - 3 days', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000003', 'rem-owner-3')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920300000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, daysFrom(now, -3)),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          expect(match?.kind).toBe('overdue_3d' satisfies PaymentReminder.PaymentReminderKind);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns overdue_10d when due_at = now - 10 days', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000004', 'rem-owner-4')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920400000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, daysFrom(now, -10)),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          expect(match?.kind).toBe('overdue_10d' satisfies PaymentReminder.PaymentReminderKind);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns overdue_21d when due_at = now - 21 days', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000005', 'rem-owner-5')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920500000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, daysFrom(now, -21)),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          expect(match?.kind).toBe('overdue_21d' satisfies PaymentReminder.PaymentReminderKind);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('skips assignments with computed_status = paid', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000006', 'rem-owner-6')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920600000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id, { amountMinor: 1000 })),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, now, 1000),
      ),
      // Record a full payment so computed_status = 'paid'
      Effect.tap(({ assignment, member, ownerId }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: assignment.id,
              teamMemberId: (member as any).id,
              amountMinor: 1000,
              method: 'cash' as const,
              paidAt: DateTime.fromDateUnsafe(new Date()),
              note: Option.none(),
              recordedByUserId: ownerId,
            }),
          ),
        ),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeUndefined();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('skips assignments with stored_status = waived', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000007', 'rem-owner-7')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('920700000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id)),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, now),
      ),
      // Waive the assignment
      Effect.tap(({ assignment }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignment.id, {
              waived: Option.some(true),
              waivedReason: Option.some(Option.some('Waived for test')),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeUndefined();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'excludes assignments that already have a payment_reminders_sent row for that kind',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('920000000000000008', 'rem-owner-8')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('920800000000000000' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('fee', ({ team }) => createFee(team.id)),
        Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
        Effect.bind('now', () => Effect.sync(() => new Date())),
        Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
        Effect.bind('assignment', ({ fee, member, now }) =>
          createAssignment(fee.id, (member as any).id, now),
        ),
        // Mark as already sent for 'due_today'
        Effect.tap(({ assignment }) =>
          PaymentRemindersSentRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.markSent(assignment.id, 'due_today')),
          ),
        ),
        Effect.bind('candidates', ({ now }) =>
          FeeAssignmentsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findReminderCandidates(now)),
          ),
        ),
        Effect.tap(({ candidates, assignment }) =>
          Effect.sync(() => {
            const match = candidates.find((c) => c.assignment_id === assignment.id);
            expect(match).toBeUndefined();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'excludes assignments with an unprocessed payment_reminder_sync_events row (prevents duplicate emits)',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('920000000000000009', 'rem-owner-9')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('920900000000000000' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('fee', ({ team }) => createFee(team.id)),
        Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
        Effect.bind('now', () => Effect.sync(() => new Date())),
        Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
        Effect.bind('assignment', ({ fee, member, now }) =>
          createAssignment(fee.id, (member as any).id, now),
        ),
        // Emit an unprocessed sync row for 'due_today'
        Effect.tap(({ assignment, team }) =>
          PaymentReminderSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.emit(assignment.id, team.guild_id, 'due_today')),
          ),
        ),
        Effect.bind('candidates', ({ now }) =>
          FeeAssignmentsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findReminderCandidates(now)),
          ),
        ),
        Effect.tap(({ candidates, assignment }) =>
          Effect.sync(() => {
            const match = candidates.find((c) => c.assignment_id === assignment.id);
            expect(match).toBeUndefined();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('includes partial-paid assignments (computed_status = partial)', () =>
    Effect.Do.pipe(
      Effect.bind('ownerId', () => createUser('920000000000000010', 'rem-owner-10')),
      Effect.bind('team', ({ ownerId }) =>
        createTeam('921000000000000000' as Discord.Snowflake, ownerId),
      ),
      Effect.bind('fee', ({ team }) => createFee(team.id, { amountMinor: 2000 })),
      Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
      Effect.bind('now', () => Effect.sync(() => new Date())),
      Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
      Effect.bind('assignment', ({ fee, member, now }) =>
        createAssignment(fee.id, (member as any).id, now, 2000),
      ),
      // Record a partial payment (half of the amount)
      Effect.tap(({ assignment, member, ownerId }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: assignment.id,
              teamMemberId: (member as any).id,
              amountMinor: 1000,
              method: 'cash' as const,
              paidAt: DateTime.fromDateUnsafe(new Date()),
              note: Option.none(),
              recordedByUserId: ownerId,
            }),
          ),
        ),
      ),
      Effect.bind('candidates', ({ now }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(now)),
        ),
      ),
      Effect.tap(({ candidates, assignment }) =>
        Effect.sync(() => {
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match).toBeDefined();
          // Partial-paid should still be included
          expect(match?.paid_minor).toBe(1000);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'returns required fields: user_discord_id, guild_id, currency, amount_minor, paid_minor, fee_name, effective_due_at, kind',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('920000000000000011', 'rem-owner-11')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('921100000000000000' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('fee', ({ team }) =>
          createFee(team.id, { amountMinor: 3000, currency: 'EUR' }),
        ),
        Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
        Effect.bind('now', () => Effect.sync(() => new Date())),
        Effect.tap(({ team, now }) => upsertTeamSettings(team.id, toHHMM(now))),
        Effect.bind('assignment', ({ fee, member, now }) =>
          createAssignment(fee.id, (member as any).id, now),
        ),
        Effect.bind('candidates', ({ now }) =>
          FeeAssignmentsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findReminderCandidates(now)),
          ),
        ),
        Effect.tap(({ candidates, assignment }) =>
          Effect.sync(() => {
            const match = candidates.find((c) => c.assignment_id === assignment.id);
            expect(match).toBeDefined();
            expect(match?.user_discord_id).toBe('920000000000000011');
            expect(match?.guild_id).toBe('921100000000000000');
            expect(match?.currency).toBe('EUR');
            expect(match?.amount_minor).toBe(3000);
            expect(match?.paid_minor).toBeDefined();
            expect(match?.fee_name).toBe('Reminder Fee');
            expect(match?.effective_due_at).toBeDefined();
            expect(match?.kind).toBeDefined();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'respects the team rsvp_reminder_time BETWEEN window — outside window returns no candidates',
    () =>
      Effect.Do.pipe(
        Effect.bind('ownerId', () => createUser('920000000000000012', 'rem-owner-12')),
        Effect.bind('team', ({ ownerId }) =>
          createTeam('921200000000000000' as Discord.Snowflake, ownerId),
        ),
        Effect.bind('fee', ({ team }) => createFee(team.id)),
        Effect.bind('member', ({ team, ownerId }) => addMember(team.id, ownerId)),
        // Set team settings to a reminder window of 09:00 (team timezone)
        Effect.tap(({ team }) =>
          TeamSettingsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert({
                teamId: team.id,
                eventHorizonDays: 30,
                minPlayersThreshold: 5,
                rsvpReminderDaysBefore: 1,
                rsvpReminderTime: '09:00',
                remindersChannelId: Option.none(),
                timezone: 'UTC',
              }),
            ),
          ),
        ),
        Effect.bind('now', () => Effect.sync(() => new Date())),
        Effect.bind('assignment', ({ fee, member, now }) =>
          createAssignment(fee.id, (member as any).id, now),
        ),
        // Call with a time well outside the window (e.g., 23:00 UTC)
        Effect.bind('nowOutsideWindow', () =>
          Effect.sync(() => {
            const d = new Date();
            d.setUTCHours(23, 0, 0, 0);
            return d;
          }),
        ),
        Effect.bind('candidates', ({ nowOutsideWindow }) =>
          FeeAssignmentsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findReminderCandidates(nowOutsideWindow)),
          ),
        ),
        Effect.tap(({ candidates, assignment }) =>
          Effect.sync(() => {
            const match = candidates.find((c) => c.assignment_id === assignment.id);
            // Outside the reminder window → no candidates
            expect(match).toBeUndefined();
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
