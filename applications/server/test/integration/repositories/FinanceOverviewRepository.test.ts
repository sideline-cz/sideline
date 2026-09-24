// TDD mode — tests written BEFORE FinanceOverviewRepository implementation exists.
// These tests WILL FAIL until the developer implements FinanceOverviewRepository.
//
// Required implementation:
//   - applications/server/src/repositories/FeesRepository.ts
//   - applications/server/src/repositories/FeeAssignmentsRepository.ts
//   - applications/server/src/repositories/PaymentsRepository.ts
//   - applications/server/src/repositories/FinanceOverviewRepository.ts
//
// T6 (6.8-6.12) — `.work-plans/finances/settle-all-and-credit-architecture.md` §6.2/§6.3 — added
// on real Postgres, [R3]-moved off the mock harness: `finance.test.ts`'s
// `MockFinanceOverviewRepositoryLayer` is literally `overviewByTeam: () => Effect.succeed([])`,
// so it cannot observe the SQL under test here, and §6.3's `COUNT(*)` -> `COUNT(v.assignment_id)`
// swap is "the single most likely off-by-one in the change" — it needs the real query. These
// tests seed `member_credit_accounts` directly via raw SQL (there is no repository dependency:
// §5.3b explicitly marks `overviewByTeam`/`myStatus`'s credit join as plain reads, no
// `MemberCreditsRepository` involved) rather than through `MemberCreditsRepository.settle`, so
// this file does not need that repository to exist to be useful once these two queries are
// rewritten (though it currently WILL fail to compile like every other T4-T6 file, because
// `packages/migrations/src/before/1792700000_create_member_credits.ts` must be built first).

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Fee, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { FinanceOverviewRepository } from '~/repositories/FinanceOverviewRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { assertCreditReconciles } from '../creditReconciliation.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  FinanceOverviewRepository.Default,
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
        name: 'Overview Test Team',
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

const createFee = (teamId: Team.TeamId, amountMinor: number, currency: string) =>
  FeesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        name: `Fee in ${currency}`,
        description: Option.none(),
        amount_minor: amountMinor,
        currency,
        due_at: Option.none(),
      }),
    ),
  );

const assignFee = (feeId: Fee.FeeId, memberId: string) =>
  FeeAssignmentsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.bulkInsert({
        feeId,
        memberIds: [memberId as any],
        amountMinorOverride: Option.none(),
        dueAtOverride: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FinanceOverviewRepository — overviewByTeam', () => {
  it.effect('returns per-currency rows per member (CZK + EUR → 2 rows)', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000001', 'overview-user-1')),
      Effect.bind('team', ({ user }) =>
        createTeam('930100000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('czFee', ({ team }) => createFee(team.id, 5000, 'CZK')),
      Effect.bind('eurFee', ({ team }) => createFee(team.id, 1000, 'EUR')),
      Effect.tap(({ czFee, member }) => assignFee(czFee.id, (member as any).id)),
      Effect.tap(({ eurFee, member }) => assignFee(eurFee.id, (member as any).id)),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          // One row per currency
          expect(memberRows).toHaveLength(2);
          const currencies = memberRows.map((r) => r.currency).sort();
          expect(currencies).toEqual(['CZK', 'EUR']);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('member with no fees is not in result', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000002', 'overview-user-2')),
      Effect.bind('team', ({ user }) =>
        createTeam('930200000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      // No fees assigned
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          expect(memberRows).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('waived assignment is excluded from totalDueMinor and totalPaidMinor', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000003', 'overview-user-3')),
      Effect.bind('team', ({ user }) =>
        createTeam('930300000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('fee', ({ team }) => createFee(team.id, 5000, 'CZK')),
      Effect.bind('assignments', ({ fee, member }) => assignFee(fee.id, (member as any).id)),
      // Waive the assignment
      Effect.tap(({ assignments }) =>
        FeeAssignmentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(assignments[0]?.id, {
              waived: Option.some(true),
              waivedReason: Option.some(Option.some('Scholarship')),
              amountMinor: Option.none(),
              dueAt: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberRows = overview.filter((r) => r.teamMemberId === (member as any).id);
          // Waived assignments should not contribute to totals
          // Member may not appear at all, or if they do, totals should be 0
          if (memberRows.length > 0) {
            expect(memberRows[0]?.totalDueMinor ?? 0).toBe(0);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('multiple fees same currency aggregate correctly: 500 + 700 = 1200 totalDueMinor', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000004', 'overview-user-4')),
      Effect.bind('team', ({ user }) =>
        createTeam('930400000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('fee1', ({ team }) => createFee(team.id, 500, 'CZK')),
      Effect.bind('fee2', ({ team }) => createFee(team.id, 700, 'CZK')),
      Effect.tap(({ fee1, member }) => assignFee(fee1.id, (member as any).id)),
      Effect.tap(({ fee2, member }) => assignFee(fee2.id, (member as any).id)),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const memberCzkRows = overview.filter(
            (r) => r.teamMemberId === (member as any).id && r.currency === 'CZK',
          );
          expect(memberCzkRows).toHaveLength(1);
          expect(memberCzkRows[0]?.totalDueMinor).toBe(1200);
          expect(memberCzkRows[0]?.totalPaidMinor).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

describe('FinanceOverviewRepository — myStatus', () => {
  it.effect('returns the member assignments grouped by currency', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000005', 'my-status-user-1')),
      Effect.bind('team', ({ user }) =>
        createTeam('930500000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('fee', ({ team }) => createFee(team.id, 5000, 'CZK')),
      Effect.tap(({ fee, member }) => assignFee(fee.id, (member as any).id)),
      Effect.bind('status', ({ team, user }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.myStatus(team.id, user.id)),
        ),
      ),
      Effect.tap(({ status }) =>
        Effect.sync(() => {
          expect(status).toHaveLength(1);
          expect(status[0]?.currency).toBe('CZK');
          expect(status[0]?.totalOutstandingMinor).toBe(5000);
          expect(status[0]?.assignments).toHaveLength(1);
          expect(status[0]?.assignments[0]?.due_minor).toBe(5000);
          expect(status[0]?.assignments[0]?.paid_minor).toBe(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// T6 (6.8-6.12) — credit joins on overviewByTeam / myStatus
// ---------------------------------------------------------------------------

/** Direct raw-SQL seed of an account row — a plain read-side fixture, not a trip through
 * `MemberCreditsRepository.settle` (§5.3b: these two queries take no dependency on that
 * repository, so this file shouldn't either). */
const seedCredit = (memberId: string, currency: string, balanceMinor: number) =>
  SqlClient.SqlClient.asEffect().pipe(
    Effect.andThen((sql) =>
      Effect.Do.pipe(
        Effect.tap(
          () => sql`
            INSERT INTO member_credit_accounts (team_member_id, currency, balance_minor)
            VALUES (${memberId}, ${currency}, ${balanceMinor})
            ON CONFLICT (team_member_id, currency) DO UPDATE SET balance_minor = EXCLUDED.balance_minor
          `,
        ),
        // Keeps the §2.4 reconciliation identity satisfiable: `balance − deposits +
        // credit_payments == 0` can never hold for a balance with no backing deposit row, and
        // that is not a state `settle`/`voidDeposit` can ever produce. Give this fixture the
        // same shape: a real, non-voided `member_credit_deposits` row for the same amount.
        // Reuses the member's own user as the recorder — this fixture only needs a valid
        // `users(id)` FK, not a realistic treasurer.
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
            VALUES (
              ${memberId}, ${currency}, ${balanceMinor}, 'cash', now(), ${recorder[0]?.user_id}
            )
          `,
        ),
        Effect.asVoid,
      ),
    ),
  );

describe('FinanceOverviewRepository — overviewByTeam with credit (6.10, 6.11, 6.12)', () => {
  it.effect(
    '6.10 overview shows a credit-only member with zero counts (COUNT(v.assignment_id), not COUNT(*))',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('930000000000000008', 'credit-only-overview-1')),
        Effect.bind('team', ({ user }) =>
          createTeam('930800000000000000' as Discord.Snowflake, user.id),
        ),
        Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
        Effect.tap(({ member }) => seedCredit((member as any).id, 'CZK', 500)),
        Effect.bind('overview', ({ team }) =>
          FinanceOverviewRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.overviewByTeam(team.id)),
          ),
        ),
        Effect.tap(({ overview, member }) =>
          Effect.sync(() => {
            const row = overview.find(
              (r) => r.teamMemberId === (member as any).id && r.currency === 'CZK',
            ) as any;
            expect(row).toBeDefined();
            expect(row.creditMinor).toBe(500);
            expect(row.overdueCount).toBe(0);
            expect(row.pendingCount).toBe(0);
            expect(row.paidCount).toBe(0);
            expect(row.totalDueMinor).toBe(0);
          }),
        ),
        Effect.tap(() => assertCreditReconciles()),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('6.11 overview creditMinor is per row currency (CZK fees + EUR credit)', () =>
    Effect.Do.pipe(
      Effect.bind('user', () => createUser('930000000000000009', 'credit-only-overview-2')),
      Effect.bind('team', ({ user }) =>
        createTeam('930900000000000000' as Discord.Snowflake, user.id),
      ),
      Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
      Effect.bind('czFee', ({ team }) => createFee(team.id, 1000, 'CZK')),
      Effect.tap(({ czFee, member }) => assignFee(czFee.id, (member as any).id)),
      Effect.tap(({ member }) => seedCredit((member as any).id, 'EUR', 25)),
      Effect.bind('overview', ({ team }) =>
        FinanceOverviewRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.overviewByTeam(team.id)),
        ),
      ),
      Effect.tap(({ overview, member }) =>
        Effect.sync(() => {
          const rows = overview.filter((r) => r.teamMemberId === (member as any).id) as any[];
          expect(rows).toHaveLength(2);
          const czRow = rows.find((r) => r.currency === 'CZK');
          const eurRow = rows.find((r) => r.currency === 'EUR');
          expect(czRow.creditMinor).toBe(0);
          expect(czRow.totalDueMinor).toBe(1000);
          expect(eurRow.creditMinor).toBe(25);
          expect(eurRow.totalDueMinor).toBe(0);
        }),
      ),
      Effect.tap(() => assertCreditReconciles()),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    '6.12 overview still returns the pre-existing shape for a member with no credit (WITH keys rewrite regression)',
    () =>
      Effect.Do.pipe(
        Effect.bind('user', () => createUser('930000000000000010', 'no-credit-overview')),
        Effect.bind('team', ({ user }) =>
          createTeam('931000000000000000' as Discord.Snowflake, user.id),
        ),
        Effect.bind('member', ({ team, user }) => addMember(team.id, user.id)),
        Effect.bind('fee1', ({ team }) => createFee(team.id, 500, 'CZK')),
        Effect.bind('fee2', ({ team }) => createFee(team.id, 700, 'CZK')),
        Effect.tap(({ fee1, member }) => assignFee(fee1.id, (member as any).id)),
        Effect.tap(({ fee2, member }) => assignFee(fee2.id, (member as any).id)),
        Effect.bind('overview', ({ team }) =>
          FinanceOverviewRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.overviewByTeam(team.id)),
          ),
        ),
        Effect.tap(({ overview, member }) =>
          Effect.sync(() => {
            const memberCzkRows = overview.filter(
              (r) => r.teamMemberId === (member as any).id && r.currency === 'CZK',
            ) as any[];
            expect(memberCzkRows).toHaveLength(1);
            expect(memberCzkRows[0].totalDueMinor).toBe(1200);
            expect(memberCzkRows[0].totalPaidMinor).toBe(0);
            expect(memberCzkRows[0].pendingCount).toBe(2);
            expect(memberCzkRows[0].creditMinor).toBe(0);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
