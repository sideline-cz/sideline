// Slice 3b of "Setup memberships" — `FeeAssignmentsRepository.findReminderCandidates`'s
// `assigned_candidates` branch must not fire the one-shot 'assigned' DM for a training fee
// whose period is still OPEN (S3 keeps revising the amount every recompute, so quoting it
// mid-month would carry a QR for money the member will not owe by the 30th). Once the period
// has closed (`period_start + 1 month` is in the past), the amount is frozen and the branch
// must behave exactly like it does for a manual fee. Pattern:
// `FeeAssignmentsRepository.reminderArchived.test.ts` (same bound-`now` style — every candidate
// query call takes an explicit `now: Date`, never the real wall clock).
//
// Fixtures here insert `fees`/`fee_assignments` rows DIRECTLY via SQL rather than driving the
// charge engine through attendance confirmation — this file is testing the reminder predicate,
// not the engine (that is `trainingPeriodCharges.test.ts`'s job), so a hand-built row that
// merely satisfies the `kind='training'`/`period_start` CHECK is the leaner fixture.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, PaymentReminder, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { createFeeAndAssignment, enableBankSync } from '../bankSyncFixtures.js';
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
// Helpers
// ---------------------------------------------------------------------------

let discordIdCounter = 940_000_000_000_000_000n;
const nextDiscordId = (): Discord.Snowflake => (discordIdCounter++).toString() as Discord.Snowflake;

const createUser = (username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: nextDiscordId(),
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Training Period Reminder Team',
        guild_id: nextDiscordId(),
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

/** Hand-inserts a `kind='training'` fee + one unpaid assignment, bypassing the charge engine —
 * this file only cares that the reminder predicate reads `f.kind`/`f.period_start` correctly. */
const createTrainingFeeAndAssignment = (
  teamId: Team.TeamId,
  memberId: string,
  periodStart: Date,
  amountMinor: number,
  dueAt: Date,
) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      Effect.gen(function* () {
        const periodStartStr = periodStart.toISOString().slice(0, 10);
        const name = `${periodStart.getUTCFullYear()}-${String(periodStart.getUTCMonth() + 1).padStart(2, '0')}`;
        const feeRows = yield* sql<{ id: string }>`
          INSERT INTO fees (team_id, name, amount_minor, currency, due_at, target_scope, kind, period_start)
          VALUES (${teamId}, ${name}, 0, 'CZK', ${dueAt}, 'custom', 'training', ${periodStartStr}::date)
          RETURNING id::text AS id
        `;
        const feeId = feeRows[0]?.id;
        if (feeId === undefined) throw new Error('expected an inserted fee id');
        const assignmentRows = yield* sql<{ id: string }>`
          INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
          VALUES (${feeId}, ${memberId}, ${amountMinor})
          RETURNING id::text AS id
        `;
        const assignmentId = assignmentRows[0]?.id;
        if (assignmentId === undefined) throw new Error('expected an inserted assignment id');
        return { feeId, assignmentId };
      }),
    ),
  );

const candidatesAt = (now: Date) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) => repo.findReminderCandidates(now)),
  );

const seedBankEnabledTeam = (seq: string) =>
  Effect.gen(function* () {
    const ownerId = yield* createUser(`training-reminder-owner-${seq}`);
    const team = yield* createTeam(ownerId);
    const member = yield* addMember(team.id, ownerId);
    yield* enableBankSync(team.id, ownerId);
    return { ownerId, team, member: member as { id: string } };
  });

// A period start comfortably in the past so `period_start + 1 month` has already elapsed —
// used by the "period closed" tests.
const CLOSED_PERIOD_START = new Date('2020-01-01T00:00:00.000Z');
const CLOSED_PERIOD_DUE_AT = new Date('2020-02-10T00:00:00.000Z');
// "Now", for the "period still open" tests — the current calendar month is always open.
const NOW = new Date();
const OPEN_PERIOD_START = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth(), 1));
const OPEN_PERIOD_DUE_AT = new Date(Date.UTC(NOW.getUTCFullYear(), NOW.getUTCMonth() + 1, 10));

// ---------------------------------------------------------------------------
// 21-22. assigned_candidates — the training period-close gate
// ---------------------------------------------------------------------------

describe('findReminderCandidates — training fee, assigned branch, period-close gate', () => {
  it.effect(
    "an OPEN-period training fee produces NO 'assigned' candidate, even with bank sync " +
      'enabled and the assignment unpaid',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeam('21');
        const { assignmentId } = yield* createTrainingFeeAndAssignment(
          team.id,
          member.id,
          OPEN_PERIOD_START,
          100,
          OPEN_PERIOD_DUE_AT,
        );
        const kinds = (yield* candidatesAt(NOW))
          .filter((c) => c.assignment_id === assignmentId)
          .map((c) => c.kind);
        expect(kinds).not.toContain('assigned');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "moving `now` past period_start + 1 month (period CLOSED) makes the 'assigned' candidate " +
      'appear',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeam('22');
        const { assignmentId } = yield* createTrainingFeeAndAssignment(
          team.id,
          member.id,
          CLOSED_PERIOD_START,
          100,
          CLOSED_PERIOD_DUE_AT,
        );
        const kinds = (yield* candidatesAt(NOW))
          .filter((c) => c.assignment_id === assignmentId)
          .map((c) => c.kind);
        expect(kinds).toContain('assigned');
      }).pipe(Effect.provide(TestLayer)),
  );

  it.effect(
    "a kind='manual' fee with the same shape still returns 'assigned' — the training gate " +
      'must not regress manual fees',
    () =>
      Effect.gen(function* () {
        const { team, member } = yield* seedBankEnabledTeam('23');
        const { assignment } = yield* createFeeAndAssignment(team.id, member.id as never, 100);
        const kinds = (yield* candidatesAt(NOW))
          .filter((c) => c.assignment_id === assignment.id)
          .map((c) => c.kind);
        expect(kinds).toContain('assigned');
      }).pipe(Effect.provide(TestLayer)),
  );
});

// ---------------------------------------------------------------------------
// 24. The date-driven kinds still fire for a training fee — the `candidates` CTE was untouched
// ---------------------------------------------------------------------------

describe('findReminderCandidates — training fee, date-driven candidates branch', () => {
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

  const daysFrom = (base: Date, days: number): Date => {
    const d = new Date(base);
    d.setUTCDate(d.getUTCDate() + days);
    return d;
  };

  it.effect(
    'due_in_3d / due_today / overdue_3d / overdue_10d / overdue_21d all fire for a training ' +
      'fee at due_at +/- N days — proving the `candidates` CTE was left untouched',
    () =>
      Effect.gen(function* () {
        const ownerId = yield* createUser('training-reminder-dates-owner');
        const team = yield* createTeam(ownerId);
        const member = yield* addMember(team.id, ownerId);
        const dueAt = new Date();
        yield* upsertTeamSettings(team.id, toHHMM(dueAt));
        const periodStart = new Date(Date.UTC(dueAt.getUTCFullYear(), dueAt.getUTCMonth() - 1, 1));
        const { assignmentId } = yield* createTrainingFeeAndAssignment(
          team.id,
          (member as { id: string }).id,
          periodStart,
          100,
          dueAt,
        );

        for (const { days, kind } of OFFSETS) {
          const found = (yield* candidatesAt(daysFrom(dueAt, days))).find(
            (c) => c.assignment_id === assignmentId,
          );
          expect(found?.kind, `offset ${days}d should fire`).toBe(kind);
        }
      }).pipe(Effect.provide(TestLayer)),
  );
});
