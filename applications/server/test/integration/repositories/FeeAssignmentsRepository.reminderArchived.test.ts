// Archiving a fee must silence its payment reminders — both CTE branches of
// `FeeAssignmentsRepository._findReminderCandidates`:
//   - `candidates`          — the five day-offset kinds (due_in_3d … overdue_21d)
//   - `assigned_candidates` — the `assigned` kind (bank-sync gated, fires on creation)
//
// Sibling to `FeeAssignmentsRepository.reminder.test.ts` and `.reminderCredit.test.ts`; kept
// separate so its archive fixtures stay out of those files' scaffolding.
//
// DECISION (documented here because the SQL cannot express it): suppression is one-way and
// permanent for a passed offset. `payment_reminders_sent` is keyed on (assignment_id, kind) and
// each due_*/overdue_* kind fires on an exact day offset, so a fee archived across the day an
// offset would have fired never emits that kind — un-archiving would not bring it back. That is
// accepted: `archiveFee` is a one-way endpoint (there is no un-archive in the API), and a
// resurrected offset would be a backdated DM about a fee nobody was chasing. The `assigned`
// branch is NOT offset-bound, so it does return after un-archiving if it never fired.

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
// Helpers — mirrors FeeAssignmentsRepository.reminderCredit.test.ts
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
        name: 'Reminder Archived Test Team',
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

const createFee = (teamId: Team.TeamId, name: string, opts: { amountMinor?: number } = {}) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name,
        description: Option.none(),
        amount_minor: opts.amountMinor ?? 1700,
        currency: 'CZK',
        due_at: Option.none(),
      }),
    ),
  );

const addMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({ team_id: teamId, user_id: userId, active: true, joined_at: undefined }),
    ),
  );

const toHHMM = (d: Date): string =>
  `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`;

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
        memberIds: [memberId as never],
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

const archiveFee = (feeId: Fee.FeeId) =>
  FeesRepository.asEffect().pipe(Effect.andThen((repo) => repo.archive(feeId)));

/** No un-archive exists in the API (archiveFee is one-way) — raw SQL so the decision note above
 * can be exercised as a test rather than only asserted in prose. */
const unarchiveFee = (feeId: Fee.FeeId) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) => sql`UPDATE fees SET archived_at = NULL WHERE id = ${feeId}`),
  );

const seedCredit = (memberId: string, balanceMinor: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      Effect.Do.pipe(
        Effect.tap(
          () => sql`
            INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
            VALUES (${memberId}, 'CZK', ${balanceMinor})
            ON CONFLICT (team_member_id, currency) DO UPDATE SET balance_minor = EXCLUDED.balance_minor
          `,
        ),
        Effect.bind(
          'recorder',
          () => sql<{ user_id: string }>`
            SELECT user_id::text AS user_id FROM team_members WHERE id = ${memberId}
          `,
        ),
        Effect.tap(
          ({ recorder }) => sql`
            INSERT INTO member_credit_deposits
              (team_member_id, currency, amount_minor, method, paid_at, recorded_by_user_id)
            VALUES (${memberId}, 'CZK', ${balanceMinor}, 'cash', now(), ${recorder[0]?.user_id})
          `,
        ),
        Effect.asVoid,
      ),
    ),
  );

const daysFrom = (base: Date, days: number): Date => {
  const d = new Date(base);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
};

const candidatesAt = (now: Date) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findReminderCandidates(now)),
  );

const OFFSETS: ReadonlyArray<{
  readonly days: number;
  readonly kind: PaymentReminder.PaymentReminderKind;
}> = [
  { days: -3, kind: 'due_in_3d' },
  { days: 0, kind: 'due_today' },
  { days: 3, kind: 'overdue_3d' },
  { days: 10, kind: 'overdue_10d' },
  { days: 21, kind: 'overdue_21d' },
];

/** A team whose reminder window is open right now, with one member and one dated assignment. */
const seedDatedAssignment = (seq: string) =>
  Effect.gen(function* () {
    const ownerId = yield* createUser(`9230000000000000${seq}`, `ra-owner-${seq}`);
    const team = yield* createTeam(`9231000000000000${seq}` as Discord.Snowflake, ownerId);
    const fee = yield* createFee(team.id, `Archived Reminder Fee ${seq}`);
    const member = yield* addMember(team.id, ownerId);
    const anchor = new Date();
    yield* upsertTeamSettings(team.id, toHHMM(anchor));
    const assignment = yield* createAssignment(fee.id, (member as { id: string }).id, anchor);
    return { anchor, assignment, fee, member: member as { id: string }, ownerId, team };
  });

// ---------------------------------------------------------------------------
// candidates CTE — the five day-offset kinds
// ---------------------------------------------------------------------------

describe('findReminderCandidates — archived fees, candidates branch', () => {
  it.effect('an active fee fires at every offset (control)', () =>
    Effect.gen(function* () {
      const { anchor, assignment } = yield* seedDatedAssignment('01');

      for (const { days, kind } of OFFSETS) {
        const found = (yield* candidatesAt(daysFrom(anchor, days))).find(
          (c) => c.assignment_id === assignment.id,
        );
        expect(found?.kind, `offset ${days}d should fire`).toBe(kind);
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('archiving the fee suppresses every offset', () =>
    Effect.gen(function* () {
      const { anchor, assignment, fee } = yield* seedDatedAssignment('02');
      yield* archiveFee(fee.id);

      for (const { days } of OFFSETS) {
        const found = (yield* candidatesAt(daysFrom(anchor, days))).find(
          (c) => c.assignment_id === assignment.id,
        );
        expect(found, `offset ${days}d should be suppressed`).toBeUndefined();
      }
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('archiving one fee does not silence the member’s other active fees', () =>
    Effect.gen(function* () {
      const { anchor, fee, member, team } = yield* seedDatedAssignment('03');
      const otherFee = yield* createFee(team.id, 'Still Collected');
      const otherAssignment = yield* createAssignment(otherFee.id, member.id, anchor);
      yield* archiveFee(fee.id);

      const found = (yield* candidatesAt(anchor)).find(
        (c) => c.assignment_id === otherAssignment.id,
      );
      expect(found?.kind).toBe('due_today');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an archived fee no longer inflates the credit-suppression outstanding total', () =>
    Effect.gen(function* () {
      // 1700 of credit against two 1700 fees is NOT full coverage — both stay noisy. Archive one
      // and the credit now covers everything still being collected, so the other goes quiet.
      const { anchor, fee, member, team } = yield* seedDatedAssignment('04');
      const otherFee = yield* createFee(team.id, 'Covered By Credit');
      const otherAssignment = yield* createAssignment(otherFee.id, member.id, anchor);
      yield* seedCredit(member.id, 1700);

      const before = (yield* candidatesAt(anchor)).find(
        (c) => c.assignment_id === otherAssignment.id,
      );
      expect(before?.kind, 'two unpaid fees vs 1700 credit is not full coverage').toBe('due_today');

      yield* archiveFee(fee.id);

      const after = (yield* candidatesAt(anchor)).find(
        (c) => c.assignment_id === otherAssignment.id,
      );
      expect(after, 'credit now covers all collectable debt').toBeUndefined();
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('an offset that passed while archived never fires after un-archiving (DECISION)', () =>
    Effect.gen(function* () {
      const { anchor, assignment, fee } = yield* seedDatedAssignment('05');
      yield* archiveFee(fee.id);

      // due_today passes while the fee is archived...
      expect((yield* candidatesAt(anchor)).some((c) => c.assignment_id === assignment.id)).toBe(
        false,
      );

      yield* unarchiveFee(fee.id);

      // ...and is gone for good: only the offsets still ahead can ever fire again.
      const laterKinds = (yield* candidatesAt(daysFrom(anchor, 3)))
        .filter((c) => c.assignment_id === assignment.id)
        .map((c) => c.kind);
      expect(laterKinds).toEqual(['overdue_3d']);
    }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// assigned_candidates CTE — the bank-sync-gated `assigned` kind
// ---------------------------------------------------------------------------

describe('findReminderCandidates — archived fees, assigned branch', () => {
  const seedBankEnabled = (seq: string) =>
    Effect.gen(function* () {
      const seeded = yield* seedDatedAssignment(seq);
      yield* enableBankSync(seeded.team.id, seeded.ownerId);
      return seeded;
    });

  it.effect('an active fee produces an assigned candidate (control)', () =>
    Effect.gen(function* () {
      const { assignment } = yield* seedBankEnabled('06');

      const kinds = (yield* candidatesAt(new Date()))
        .filter((c) => c.assignment_id === assignment.id)
        .map((c) => c.kind);
      expect(kinds).toContain('assigned');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect('archiving the fee suppresses the assigned candidate', () =>
    Effect.gen(function* () {
      const { assignment, fee } = yield* seedBankEnabled('07');
      yield* archiveFee(fee.id);

      const kinds = (yield* candidatesAt(new Date()))
        .filter((c) => c.assignment_id === assignment.id)
        .map((c) => c.kind);
      expect(kinds).not.toContain('assigned');
    }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    'the assigned kind is not offset-bound, so it returns after un-archiving (DECISION)',
    () =>
      Effect.gen(function* () {
        const { assignment, fee } = yield* seedBankEnabled('08');
        yield* archiveFee(fee.id);
        yield* unarchiveFee(fee.id);

        const kinds = (yield* candidatesAt(new Date()))
          .filter((c) => c.assignment_id === assignment.id)
          .map((c) => c.kind);
        expect(kinds).toContain('assigned');
      }).pipe(Effect.provide(TestLayer)),
  );
});
