// TDD mode — tests written BEFORE §6.6's credit-suppression predicate exists on
// `FeeAssignmentsRepository._findReminderCandidates`.
//
// `.work-plans/finances/settle-all-and-credit-architecture.md` §6.6, T4.31-4.36. Sibling to
// `FeeAssignmentsRepository.reminder.test.ts` (the tester's choice per the T4 spec: "In the same
// file … or a sibling — the tester picks") — kept separate so this file's fixtures stay focused
// on the credit predicate and don't grow the existing file's six-offset scaffolding further.
//
// Deliberately does NOT depend on `MemberCreditsRepository` (which does not exist yet) —
// `member_credit_accounts` / a `method='credit'` payment are seeded directly via raw SQL, exactly
// mirroring what `MemberCreditsRepository.settle` would write (§5.1 steps 3-4: debit the account,
// insert a `method='credit'` payment — the trigger recomputes `paid_minor` for either). That
// keeps this file's only real dependency on task 10 (the predicate), not tasks 6-9 (the
// repository), so it can go green independently and earlier.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, PaymentReminder, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { enableBankSync } from '../bankSyncFixtures.js';
import { assertCreditReconciles } from '../creditReconciliation.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FeeAssignmentsRepository.Default,
  FeesRepository.Default,
  TeamMembersRepository.Default,
  TeamSettingsRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers — mirrors FeeAssignmentsRepository.reminder.test.ts
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
        name: 'Reminder Credit Test Team',
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

const createFee = (teamId: Team.TeamId, opts: { amountMinor?: number; currency?: string } = {}) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: 'Reminder Credit Fee',
        description: Option.none(),
        amount_minor: opts.amountMinor ?? 1700,
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

const createAssignment = (feeId: Fee.FeeId, memberId: string, dueAt: Date, amountMinor?: number) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.bulkInsert({
        feeId,
        memberIds: [memberId as any],
        amountMinorOverride: amountMinor
          ? Option.some(amountMinor as Fee.AmountMinor)
          : Option.none(),
        dueAtOverride: Option.some(DateTime.fromDateUnsafe(dueAt)),
      }),
    ),
    Effect.map((rows) => {
      const row = rows[0];
      if (row === undefined) throw new Error('bulkInsert did not return an assignment');
      return row;
    }),
  );

const daysFrom = (base: Date, days: number): Date => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const seedCredit = (memberId: string, currency: string, balanceMinor: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen(
      (sql) => sql`
        INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
        VALUES (${memberId}, ${currency}, ${balanceMinor})
        ON CONFLICT (team_member_id, currency) DO UPDATE SET balance_minor = EXCLUDED.balance_minor
      `,
    ),
  );

/** Simulates what `MemberCreditsRepository.settle` would write when spending credit against an
 * assignment: a `method='credit'` payment (the trigger recomputes `paid_minor`) and the matching
 * debit of the account balance — without depending on that repository (see file header). */
const spendCreditOnAssignment = (
  memberId: string,
  assignmentId: string,
  currency: string,
  amountMinor: number,
  recordedByUserId: string,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      Effect.Do.pipe(
        Effect.tap(
          () => sql`
            INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, recorded_by_user_id)
            VALUES (${assignmentId}, ${memberId}, ${amountMinor}, 'credit', now(), ${recordedByUserId})
          `,
        ),
        Effect.tap(
          () => sql`
            UPDATE member_credit_accounts SET balance_minor = balance_minor - ${amountMinor}, updated_at = now()
             WHERE team_member_id = ${memberId} AND currency = ${currency}
          `,
        ),
      ),
    ),
  );

const SIX_OFFSETS: ReadonlyArray<{
  readonly days: number;
  readonly kind: PaymentReminder.PaymentReminderKind;
}> = [
  { days: -3, kind: 'due_in_3d' },
  { days: 0, kind: 'due_today' },
  { days: 3, kind: 'overdue_3d' },
  { days: 10, kind: 'overdue_10d' },
  { days: 21, kind: 'overdue_21d' },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FeeAssignmentsRepository — reminder suppression by credit (§6.6, T4.31-4.36)', () => {
  it.effect(
    '4.31 credit covering the outstanding amount suppresses every due/overdue firing offset',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('922000000000000001', 'rc-owner-1');
        const team = yield* createTeam('922100000000000000' as Discord.Snowflake, ownerId);
        const fee = yield* createFee(team.id, { amountMinor: 1700 });
        const member = yield* addMember(team.id, ownerId);
        const anchor = new Date();
        yield* upsertTeamSettings(team.id, toHHMM(anchor));
        const assignment = yield* createAssignment(fee.id, (member as any).id, anchor);
        yield* seedCredit((member as any).id, 'CZK', 5000);

        for (const { days } of SIX_OFFSETS) {
          const candidates = yield* FeeAssignmentsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findReminderCandidates(daysFrom(anchor, days))),
          );
          const match = candidates.find((c) => c.assignment_id === assignment.id);
          expect(match, `offset ${days}d should be suppressed`).toBeUndefined();
        }

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.32 partial credit does not suppress — the member genuinely owes the rest', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('922000000000000002', 'rc-owner-2');
      const team = yield* createTeam('922200000000000000' as Discord.Snowflake, ownerId);
      const fee = yield* createFee(team.id, { amountMinor: 1700 });
      const member = yield* addMember(team.id, ownerId);
      const anchor = new Date();
      yield* upsertTeamSettings(team.id, toHHMM(anchor));
      const assignment = yield* createAssignment(fee.id, (member as any).id, anchor);
      yield* seedCredit((member as any).id, 'CZK', 300);

      const candidates = yield* FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
      );
      expect(candidates.find((c) => c.assignment_id === assignment.id)).toBeDefined();

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.32b credit covering ONE fee but not the TOTAL silences neither — total-outstanding comparison, not row-local',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('922000000000000003', 'rc-owner-3');
        const team = yield* createTeam('922300000000000000' as Discord.Snowflake, ownerId);
        const fee1 = yield* createFee(team.id, { amountMinor: 1700 });
        const fee2 = yield* createFee(team.id, { amountMinor: 1700 });
        const member = yield* addMember(team.id, ownerId);
        const anchor = new Date();
        yield* upsertTeamSettings(team.id, toHHMM(anchor));
        const assignment1 = yield* createAssignment(fee1.id, (member as any).id, anchor);
        const assignment2 = yield* createAssignment(fee2.id, (member as any).id, anchor);
        // Exactly enough to cover ONE of the two 1700 fees, never both.
        yield* seedCredit((member as any).id, 'CZK', 1700);

        const candidates = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
        );
        expect(
          candidates.find((c) => c.assignment_id === assignment1.id),
          'a row-local predicate would wrongly silence this one too',
        ).toBeDefined();
        expect(candidates.find((c) => c.assignment_id === assignment2.id)).toBeDefined();

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.33 credit in another currency does not suppress', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('922000000000000004', 'rc-owner-4');
      const team = yield* createTeam('922400000000000000' as Discord.Snowflake, ownerId);
      const fee = yield* createFee(team.id, { amountMinor: 1700, currency: 'CZK' });
      const member = yield* addMember(team.id, ownerId);
      const anchor = new Date();
      yield* upsertTeamSettings(team.id, toHHMM(anchor));
      const assignment = yield* createAssignment(fee.id, (member as any).id, anchor);
      yield* seedCredit((member as any).id, 'EUR', 5000);

      const candidates = yield* FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
      );
      expect(candidates.find((c) => c.assignment_id === assignment.id)).toBeDefined();

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    '4.34 credit exactly equal to the outstanding amount suppresses (the predicate is >=, not >)',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('922000000000000005', 'rc-owner-5');
        const team = yield* createTeam('922500000000000000' as Discord.Snowflake, ownerId);
        const fee = yield* createFee(team.id, { amountMinor: 1700 });
        const member = yield* addMember(team.id, ownerId);
        const anchor = new Date();
        yield* upsertTeamSettings(team.id, toHHMM(anchor));
        const assignment = yield* createAssignment(fee.id, (member as any).id, anchor);
        yield* seedCredit((member as any).id, 'CZK', 1700);

        const candidates = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
        );
        expect(candidates.find((c) => c.assignment_id === assignment.id)).toBeUndefined();

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "4.35 suppression applies to the assigned_candidates branch too (kind='assigned', gated on enabled bank-sync)",
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('922000000000000006', 'rc-owner-6');
        const team = yield* createTeam('922600000000000000' as Discord.Snowflake, ownerId);
        yield* enableBankSync(team.id, ownerId as never);
        const fee = yield* createFee(team.id, { amountMinor: 1700 });
        const member = yield* addMember(team.id, ownerId);
        const anchor = new Date();
        yield* upsertTeamSettings(team.id, toHHMM(anchor));
        // No due date at all — 'assigned' deliberately doesn't require one (D15b/T10c).
        const assignment = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.bulkInsert({
              feeId: fee.id,
              memberIds: [(member as any).id],
              amountMinorOverride: Option.none(),
              dueAtOverride: Option.none(),
            }),
          ),
          Effect.map((rows) => {
            const row = rows[0];
            if (row === undefined) throw new Error('bulkInsert did not return an assignment');
            return row;
          }),
        );

        const withoutCredit = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
        );
        expect(
          withoutCredit.find((c) => c.assignment_id === assignment.id && c.kind === 'assigned'),
        ).toBeDefined();

        yield* seedCredit((member as any).id, 'CZK', 5000);
        const withCredit = yield* FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
        );
        expect(
          withCredit.find((c) => c.assignment_id === assignment.id && c.kind === 'assigned'),
        ).toBeUndefined();

        yield* assertCreditReconciles();
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('4.36 spending the credit un-suppresses the reminder', () =>
    Effect.gen(function* () {
      const ownerId = yield* createUser('922000000000000007', 'rc-owner-7');
      const team = yield* createTeam('922700000000000000' as Discord.Snowflake, ownerId);
      const fee1 = yield* createFee(team.id, { amountMinor: 1700 });
      const fee2 = yield* createFee(team.id, { amountMinor: 1700 });
      const member = yield* addMember(team.id, ownerId);
      const anchor = new Date();
      yield* upsertTeamSettings(team.id, toHHMM(anchor));
      const assignment1 = yield* createAssignment(fee1.id, (member as any).id, anchor);
      const assignment2 = yield* createAssignment(fee2.id, (member as any).id, anchor);
      yield* seedCredit((member as any).id, 'CZK', 1700);

      const beforeSpend = yield* FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
      );
      // Both are candidates before anything is spent (4.32b's invariant).
      expect(beforeSpend.find((c) => c.assignment_id === assignment1.id)).toBeDefined();
      expect(beforeSpend.find((c) => c.assignment_id === assignment2.id)).toBeDefined();

      // Spend the whole balance on fee1 — mirrors what `credits.settle` would do.
      yield* spendCreditOnAssignment((member as any).id, assignment1.id, 'CZK', 1700, ownerId);

      const afterSpend = yield* FeeAssignmentsRepository.asEffect().pipe(
        Effect.andThen((repo) => repo.findReminderCandidates(anchor)),
      );
      // fee1 is now paid off entirely (excluded by computed_status = paid), fee2's outstanding
      // 1700 is no longer covered by the (now zero) balance — it must be a candidate again.
      expect(afterSpend.find((c) => c.assignment_id === assignment1.id)).toBeUndefined();
      expect(afterSpend.find((c) => c.assignment_id === assignment2.id)).toBeDefined();

      yield* assertCreditReconciles();
    }).pipe(Effect.provide(TestLayer)),
  );
});
