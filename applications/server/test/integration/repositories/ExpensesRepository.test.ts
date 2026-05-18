import { describe, expect, it } from '@effect/vitest';
import type { Discord, Expense, Team, User } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Schema } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { beforeEach } from 'vitest';
import { ExpensesRepository } from '~/repositories/ExpensesRepository.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { FeesRepository } from '~/repositories/FeesRepository.js';
import { PaymentsRepository } from '~/repositories/PaymentsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  ExpensesRepository.Default,
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
    Effect.map((u) => u.id),
  );

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Expense Test Team',
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

const insertExpense = (teamId: Team.TeamId, createdByUserId: User.UserId) =>
  ExpensesRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        team_id: teamId,
        amount_minor: 2000,
        currency: 'CZK',
        spent_at: DateTime.fromDateUnsafe(new Date('2025-04-10T12:00:00Z')),
        category: 'fields',
        description: 'Pitch rental',
        created_by_user_id: createdByUserId,
        updated_by_user_id: createdByUserId,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// insert
// ---------------------------------------------------------------------------

describe('ExpensesRepository — insert', () => {
  it.effect('insert returns a row with generated id, populated timestamps, and user ids', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000001', 'exp-owner-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('930100000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team, userId }) => insertExpense(team.id, userId)),
      Effect.tap(({ expense, userId }) =>
        Effect.sync(() => {
          expect(expense.id).toBeTruthy();
          expect(expense.amount_minor).toBe(2000);
          expect(expense.currency).toBe('CZK');
          expect(expense.category).toBe('fields');
          expect(expense.description).toBe('Pitch rental');
          expect(expense.created_by_user_id).toBe(userId);
          expect(expense.updated_by_user_id).toBe(userId);
          expect(expense.created_at).toBeTruthy();
          expect(expense.updated_at).toBeTruthy();
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// update
// ---------------------------------------------------------------------------

describe('ExpensesRepository — update', () => {
  it.effect('update patches only Option.some fields and bumps updated_by_user_id', () =>
    Effect.Do.pipe(
      Effect.bind('creator', () => createUser('930000000000000002', 'exp-creator-2')),
      Effect.bind('updater', () => createUser('930000000000000003', 'exp-updater-2')),
      Effect.bind('team', ({ creator }) =>
        createTeam('930200000000000000' as Discord.Snowflake, creator),
      ),
      Effect.bind('expense', ({ team, creator }) => insertExpense(team.id, creator)),
      Effect.bind('updated', ({ expense, team, updater }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(expense.id, team.id, updater, {
              amount_minor: Option.some(9999),
              currency: Option.none(),
              spent_at: Option.none(),
              category: Option.none(),
              description: Option.some('Updated description'),
            }),
          ),
        ),
      ),
      Effect.tap(({ updated, expense, creator, updater }) =>
        Effect.sync(() => {
          expect(Option.isSome(updated)).toBe(true);
          const row = Option.getOrThrow(updated);
          expect(row.id).toBe(expense.id);
          expect(row.amount_minor).toBe(9999);
          expect(row.description).toBe('Updated description');
          // Currency unchanged
          expect(row.currency).toBe('CZK');
          // updated_by_user_id reflects the updater, not the creator
          expect(row.updated_by_user_id).toBe(updater);
          expect(row.updated_by_user_id).not.toBe(creator);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('update returns Option.none when expense belongs to a different team', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000004', 'exp-owner-3')),
      Effect.bind('team1', ({ userId }) =>
        createTeam('930300000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('team2', ({ userId }) =>
        createTeam('930400000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team1, userId }) => insertExpense(team1.id, userId)),
      Effect.bind('result', ({ expense, team2, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update(expense.id, team2.id, userId, {
              amount_minor: Option.some(5000),
              currency: Option.none(),
              spent_at: Option.none(),
              category: Option.none(),
              description: Option.none(),
            }),
          ),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(Option.isNone(result)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// findById
// ---------------------------------------------------------------------------

describe('ExpensesRepository — findById', () => {
  it.effect('findById returns the expense for the correct team', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000005', 'exp-owner-4')),
      Effect.bind('team', ({ userId }) =>
        createTeam('930500000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team, userId }) => insertExpense(team.id, userId)),
      Effect.bind('found', ({ expense, team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(expense.id, team.id)),
        ),
      ),
      Effect.tap(({ found, expense }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const row = Option.getOrThrow(found);
          expect(row.id).toBe(expense.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findById returns Option.none for cross-team lookup', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000006', 'exp-owner-5')),
      Effect.bind('team1', ({ userId }) =>
        createTeam('930600000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('team2', ({ userId }) =>
        createTeam('930700000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team1, userId }) => insertExpense(team1.id, userId)),
      Effect.bind('found', ({ expense, team2 }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(expense.id, team2.id)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// listByTeam
// ---------------------------------------------------------------------------

describe('ExpensesRepository — listByTeam', () => {
  it.effect('listByTeam returns expenses ordered by spent_at DESC', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000007', 'exp-owner-6')),
      Effect.bind('team', ({ userId }) =>
        createTeam('930800000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('exp1', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 1000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-01-01T12:00:00Z')),
              category: 'fields',
              description: 'Earlier expense',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('exp2', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 2000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-03-01T12:00:00Z')),
              category: 'travel',
              description: 'Later expense',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('list', ({ team }) =>
        ExpensesRepository.asEffect().pipe(Effect.andThen((repo) => repo.listByTeam(team.id, {}))),
      ),
      Effect.tap(({ list, exp1, exp2 }) =>
        Effect.sync(() => {
          expect(list.length).toBeGreaterThanOrEqual(2);
          const ids = list.map((e) => e.id);
          const idx1 = ids.indexOf(exp1.id);
          const idx2 = ids.indexOf(exp2.id);
          // exp2 (later date) should appear before exp1 (earlier date)
          expect(idx1).toBeGreaterThanOrEqual(0);
          expect(idx2).toBeGreaterThanOrEqual(0);
          expect(idx2).toBeLessThan(idx1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('listByTeam filters by category', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000008', 'exp-owner-7')),
      Effect.bind('team', ({ userId }) =>
        createTeam('930900000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('fieldsExp', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 1000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-04-01T12:00:00Z')),
              category: 'fields',
              description: 'Fields expense',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('travelExp', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 5000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-04-02T12:00:00Z')),
              category: 'travel',
              description: 'Travel expense',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('list', ({ team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.listByTeam(team.id, { category: 'fields' })),
        ),
      ),
      Effect.tap(({ list, fieldsExp, travelExp }) =>
        Effect.sync(() => {
          const ids = list.map((e) => e.id);
          expect(ids).toContain(fieldsExp.id);
          expect(ids).not.toContain(travelExp.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('listByTeam filters by date range', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000009', 'exp-owner-8')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931000000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('inRange', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 1000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-06-15T12:00:00Z')),
              category: 'other',
              description: 'In range',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('outOfRange', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 2000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2024-01-10T12:00:00Z')),
              category: 'other',
              description: 'Out of range',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      Effect.bind('list', ({ team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.listByTeam(team.id, {
              from: DateTime.fromDateUnsafe(new Date('2025-01-01T00:00:00Z')),
              to: DateTime.fromDateUnsafe(new Date('2025-12-31T23:59:59Z')),
            }),
          ),
        ),
      ),
      Effect.tap(({ list, inRange, outOfRange }) =>
        Effect.sync(() => {
          const ids = list.map((e) => e.id);
          expect(ids).toContain(inRange.id);
          expect(ids).not.toContain(outOfRange.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('ExpensesRepository — delete', () => {
  it.effect('delete returns true and removes the row', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000010', 'exp-owner-9')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931100000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team, userId }) => insertExpense(team.id, userId)),
      Effect.bind('deleted', ({ expense, team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.delete(expense.id, team.id, userId)),
        ),
      ),
      Effect.bind('found', ({ expense, team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findById(expense.id, team.id)),
        ),
      ),
      Effect.tap(({ deleted, found }) =>
        Effect.sync(() => {
          expect(deleted).toBe(true);
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('delete returns false when no row matched', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000011', 'exp-owner-10')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931200000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('result', ({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.delete(
              '00000000-0000-0000-0000-000000000000' as Expense.ExpenseId,
              team.id,
              userId,
            ),
          ),
        ),
      ),
      Effect.tap(({ result }) =>
        Effect.sync(() => {
          expect(result).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('after delete, an expense_history row with operation="delete" exists', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000012', 'exp-owner-11')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931300000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expense', ({ team, userId }) => insertExpense(team.id, userId)),
      Effect.tap(({ expense, team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.delete(expense.id, team.id, userId)),
        ),
      ),
      Effect.bind('historyCount', ({ expense }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.countHistoryRows(expense.id, 'delete')),
        ),
      ),
      Effect.tap(({ historyCount }) =>
        Effect.sync(() => {
          expect(historyCount).toBeGreaterThanOrEqual(1);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'delete audit row performed_by_user_id matches the deleting user, not the prior editor',
    () =>
      Effect.Do.pipe(
        Effect.bind('creator', () => createUser('930000000000000019', 'exp-creator-audit')),
        Effect.bind('deleter', () => createUser('930000000000000020', 'exp-deleter-audit')),
        Effect.bind('team', ({ creator }) =>
          createTeam('932000000000000000' as Discord.Snowflake, creator),
        ),
        Effect.bind('expense', ({ team, creator }) => insertExpense(team.id, creator)),
        Effect.tap(({ expense, team, deleter }) =>
          ExpensesRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.delete(expense.id, team.id, deleter)),
          ),
        ),
        Effect.bind('sql', () => SqlClient.SqlClient.asEffect()),
        Effect.bind('auditRow', ({ sql, expense }) =>
          sql`
          SELECT performed_by_user_id
          FROM expense_history
          WHERE expense_id = ${expense.id} AND operation = 'delete'
          LIMIT 1
        `.pipe(
            Effect.flatMap(
              Schema.decodeUnknownEffect(
                Schema.Array(Schema.Struct({ performed_by_user_id: Schema.String })),
              ),
            ),
          ),
        ),
        Effect.tap(({ auditRow, deleter, creator }) =>
          Effect.sync(() => {
            expect(auditRow.length).toBe(1);
            expect(auditRow[0].performed_by_user_id).toBe(String(deleter));
            expect(auditRow[0].performed_by_user_id).not.toBe(String(creator));
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});

// ---------------------------------------------------------------------------
// balanceSummaryByTeam
// ---------------------------------------------------------------------------

describe('ExpensesRepository — balanceSummaryByTeam', () => {
  it.effect('returns one entry per currency (EUR income only, CZK expenses only)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000013', 'exp-owner-12')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931400000000000000' as Discord.Snowflake, userId),
      ),
      // Insert a CZK expense
      Effect.tap(({ team, userId }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              amount_minor: 3000,
              currency: 'CZK',
              spent_at: DateTime.fromDateUnsafe(new Date('2025-04-01T12:00:00Z')),
              category: 'equipment',
              description: 'CZK equipment',
              created_by_user_id: userId,
              updated_by_user_id: userId,
            }),
          ),
        ),
      ),
      // Insert an EUR fee + payment so that incomeMinor > 0 in EUR
      Effect.bind('fee', ({ team }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              name: 'EUR Fee',
              description: Option.none(),
              amount_minor: 5000,
              currency: 'EUR',
              due_at: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('member', ({ team, userId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: userId,
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
      Effect.tap(({ assignments, member, userId }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: assignments[0]?.id,
              teamMemberId: (member as any).id,
              amountMinor: 5000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-04-05T12:00:00Z')),
              note: Option.none(),
              recordedByUserId: userId,
            }),
          ),
        ),
      ),
      Effect.bind('summary', ({ team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.balanceSummaryByTeam(team.id)),
        ),
      ),
      Effect.tap(({ summary }) =>
        Effect.sync(() => {
          // Should have 2 entries: CZK (expense) and EUR (income)
          expect(summary.length).toBe(2);
          const currencies = summary.map((s) => s.currency);
          expect(currencies).toContain('CZK');
          expect(currencies).toContain('EUR');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('returns empty array when team has no payments and no expenses', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000014', 'exp-owner-13')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931500000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('summary', ({ team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.balanceSummaryByTeam(team.id)),
        ),
      ),
      Effect.tap(({ summary }) =>
        Effect.sync(() => {
          expect(summary).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('balanceSummaryByTeam excludes voided payments from income', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000015', 'exp-owner-14')),
      Effect.bind('team', ({ userId }) =>
        createTeam('931600000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('fee', ({ team }) =>
        FeesRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              team_id: team.id,
              name: 'Void Test Fee',
              description: Option.none(),
              amount_minor: 10000,
              currency: 'CZK',
              due_at: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('member', ({ team, userId }) =>
        TeamMembersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.addMember({
              team_id: team.id,
              user_id: userId,
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
      Effect.bind('payment', ({ assignments, member, userId }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              feeAssignmentId: assignments[0]?.id,
              teamMemberId: (member as any).id,
              amountMinor: 10000,
              method: 'cash',
              paidAt: DateTime.fromDateUnsafe(new Date('2025-04-10T12:00:00Z')),
              note: Option.none(),
              recordedByUserId: userId,
            }),
          ),
        ),
      ),
      // Void the payment
      Effect.tap(({ payment, userId }) =>
        PaymentsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.void_(payment.id, {
              voidedByUserId: userId,
              voidReason: 'Test void',
              voidedAt: DateTime.fromDateUnsafe(new Date('2025-04-11T10:00:00Z')),
            }),
          ),
        ),
      ),
      Effect.bind('summary', ({ team }) =>
        ExpensesRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.balanceSummaryByTeam(team.id)),
        ),
      ),
      Effect.tap(({ summary }) =>
        Effect.sync(() => {
          // No active payments, no expenses → empty or income = 0
          const czkEntry = summary.find((s) => s.currency === 'CZK');
          if (czkEntry) {
            expect(czkEntry.incomeMinor).toBe(0);
          } else {
            // No entry at all is also valid when both sides are 0
            expect(summary.length).toBe(0);
          }
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});

// ---------------------------------------------------------------------------
// Two-team isolation
// ---------------------------------------------------------------------------

describe('ExpensesRepository — two-team isolation', () => {
  it.effect('expenses in team A never appear in team B queries', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('930000000000000016', 'exp-owner-15')),
      Effect.bind('teamA', ({ userId }) =>
        createTeam('931700000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('teamB', ({ userId }) =>
        createTeam('931800000000000000' as Discord.Snowflake, userId),
      ),
      Effect.bind('expenseA', ({ teamA, userId }) => insertExpense(teamA.id, userId)),
      Effect.bind('listB', ({ teamB }) =>
        ExpensesRepository.asEffect().pipe(Effect.andThen((repo) => repo.listByTeam(teamB.id, {}))),
      ),
      Effect.tap(({ listB, expenseA }) =>
        Effect.sync(() => {
          const ids = listB.map((e) => e.id);
          expect(ids).not.toContain(expenseA.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
