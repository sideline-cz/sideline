import { Auth, Expense, type ExpenseApi, Team } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

export class ExpenseRow extends Schema.Class<ExpenseRow>('ExpenseRow')({
  id: Expense.ExpenseId,
  team_id: Team.TeamId,
  amount_minor: Expense.AmountMinor,
  currency: Expense.CurrencyCode,
  spent_at: Schemas.DateTimeFromDate,
  category: Expense.ExpenseCategory,
  description: Schema.String,
  created_by_user_id: Auth.UserId,
  updated_by_user_id: Auth.UserId,
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
}) {}

export class ExpenseWithNamesRow extends Schema.Class<ExpenseWithNamesRow>('ExpenseWithNamesRow')({
  id: Expense.ExpenseId,
  team_id: Team.TeamId,
  amount_minor: Expense.AmountMinor,
  currency: Expense.CurrencyCode,
  spent_at: Schemas.DateTimeFromDate,
  category: Expense.ExpenseCategory,
  description: Schema.String,
  created_by_user_id: Auth.UserId,
  updated_by_user_id: Auth.UserId,
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
  created_by_name: Schema.OptionFromNullOr(Schema.String),
  updated_by_name: Schema.OptionFromNullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// Balance-summary row (decoded once in the repo so callers receive typed values)
// ---------------------------------------------------------------------------

// Postgres returns BIGINT columns as strings via node-pg; decode as string here
// and `Number()`-convert below. Sums of int64 minor units never approach
// Number.MAX_SAFE_INTEGER for plausible team budgets.
const BalanceSummaryRawRow = Schema.Struct({
  currency: Expense.CurrencyCode,
  income_minor: Schema.String,
  expenses_minor: Schema.String,
});

export interface BalanceSummaryRow {
  readonly currency: Expense.CurrencyCode;
  readonly incomeMinor: Expense.AmountMinor;
  readonly expensesMinor: Expense.AmountMinor;
  readonly netMinor: ExpenseApi.NetAmountMinor;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      amount_minor: Expense.AmountMinor,
      currency: Expense.CurrencyCode,
      spent_at: Schemas.DateTimeFromDate,
      category: Expense.ExpenseCategory,
      description: Schema.String,
      created_by_user_id: Auth.UserId,
      updated_by_user_id: Auth.UserId,
    }),
    Result: ExpenseWithNamesRow,
    execute: (input) => sql`
      INSERT INTO expenses (team_id, amount_minor, currency, spent_at, category, description, created_by_user_id, updated_by_user_id)
      VALUES (
        ${input.team_id},
        ${input.amount_minor},
        ${input.currency},
        ${input.spent_at},
        ${input.category},
        ${input.description},
        ${input.created_by_user_id},
        ${input.updated_by_user_id}
      )
      RETURNING *, NULL::text AS created_by_name, NULL::text AS updated_by_name
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Expense.ExpenseId, team_id: Team.TeamId }),
    Result: ExpenseWithNamesRow,
    execute: (input) =>
      sql`
        SELECT e.*, NULL::text AS created_by_name, NULL::text AS updated_by_name
        FROM expenses e
        WHERE e.id = ${input.id} AND e.team_id = ${input.team_id}
      `,
  });

  const listByTeamQuery = (
    teamId: Team.TeamId,
    category: Option.Option<Expense.ExpenseCategory>,
    from: Option.Option<DateTime.Utc>,
    to: Option.Option<DateTime.Utc>,
  ) =>
    sql`
      SELECT
        e.*,
        COALESCE(cu.name, cu.discord_display_name, cu.discord_nickname, cu.username) AS created_by_name,
        COALESCE(uu.name, uu.discord_display_name, uu.discord_nickname, uu.username) AS updated_by_name
      FROM expenses e
      LEFT JOIN users cu ON cu.id = e.created_by_user_id
      LEFT JOIN users uu ON uu.id = e.updated_by_user_id
      WHERE e.team_id = ${teamId}
        AND (${Option.isNone(category)} OR e.category = ${Option.getOrNull(category)})
        AND (${Option.isNone(from)} OR e.spent_at >= ${Option.getOrNull(from)})
        AND (${Option.isNone(to)} OR e.spent_at <= ${Option.getOrNull(to)})
      ORDER BY e.spent_at DESC, e.created_at DESC
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(ExpenseWithNamesRow))),
      catchSqlErrors,
    );

  const updateQuery = (
    id: Expense.ExpenseId,
    teamId: Team.TeamId,
    userId: Auth.UserId,
    patch: {
      amount_minor: Option.Option<number>;
      currency: Option.Option<string>;
      spent_at: Option.Option<DateTime.Utc>;
      category: Option.Option<Expense.ExpenseCategory>;
      description: Option.Option<string>;
    },
  ) =>
    SqlSchema.findOneOption({
      Request: Schema.Void,
      Result: ExpenseWithNamesRow,
      execute: () => sql`
        UPDATE expenses SET
          amount_minor = CASE WHEN ${Option.isSome(patch.amount_minor)} THEN ${Option.getOrNull(patch.amount_minor)} ELSE amount_minor END,
          currency = CASE WHEN ${Option.isSome(patch.currency)} THEN ${Option.getOrNull(patch.currency)} ELSE currency END,
          spent_at = CASE WHEN ${Option.isSome(patch.spent_at)} THEN ${Option.getOrNull(patch.spent_at)} ELSE spent_at END,
          category = CASE WHEN ${Option.isSome(patch.category)} THEN ${Option.getOrNull(patch.category)} ELSE category END,
          description = CASE WHEN ${Option.isSome(patch.description)} THEN ${Option.getOrNull(patch.description)} ELSE description END,
          updated_by_user_id = ${userId},
          updated_at = now()
        WHERE id = ${id} AND team_id = ${teamId}
        RETURNING *, NULL::text AS created_by_name, NULL::text AS updated_by_name
      `,
    })(undefined).pipe(catchSqlErrors);

  const deleteReturningQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Expense.ExpenseId, team_id: Team.TeamId }),
    Result: Schema.Struct({ id: Expense.ExpenseId }),
    execute: (input) =>
      sql`DELETE FROM expenses WHERE id = ${input.id} AND team_id = ${input.team_id} RETURNING id`,
  });

  const countHistoryRowsQuery = SqlSchema.findOne({
    Request: Schema.Struct({ expense_id: Expense.ExpenseId, operation: Schema.String }),
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (input) =>
      sql`SELECT COUNT(*)::int AS count FROM expense_history WHERE expense_id = ${input.expense_id} AND operation = ${input.operation}`,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const insert = (input: {
    team_id: Team.TeamId;
    amount_minor: number;
    currency: string;
    spent_at: DateTime.Utc;
    category: Expense.ExpenseCategory;
    description: string;
    created_by_user_id: Auth.UserId;
    updated_by_user_id: Auth.UserId;
  }) =>
    insertQuery({
      team_id: input.team_id,
      amount_minor: input.amount_minor as Expense.AmountMinor,
      currency: input.currency as Expense.CurrencyCode,
      spent_at: input.spent_at,
      category: input.category,
      description: input.description,
      created_by_user_id: input.created_by_user_id,
      updated_by_user_id: input.updated_by_user_id,
    }).pipe(catchSqlErrors);

  const findById = (id: Expense.ExpenseId, teamId: Team.TeamId) =>
    findByIdQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const listByTeam = (
    teamId: Team.TeamId,
    filters: {
      category?: Expense.ExpenseCategory | undefined;
      from?: DateTime.Utc | undefined;
      to?: DateTime.Utc | undefined;
    },
  ) =>
    listByTeamQuery(
      teamId,
      Option.fromUndefinedOr(filters.category),
      Option.fromUndefinedOr(filters.from),
      Option.fromUndefinedOr(filters.to),
    );

  const update = (
    id: Expense.ExpenseId,
    teamId: Team.TeamId,
    userId: Auth.UserId,
    patch: {
      amount_minor: Option.Option<number>;
      currency: Option.Option<string>;
      spent_at: Option.Option<DateTime.Utc>;
      category: Option.Option<Expense.ExpenseCategory>;
      description: Option.Option<string>;
    },
  ) => updateQuery(id, teamId, userId, patch);

  const delete_ = (id: Expense.ExpenseId, teamId: Team.TeamId, userId: Auth.UserId) =>
    sql
      .withTransaction(
        // SET LOCAL doesn't accept bind parameters; use set_config(name, value, is_local=true)
        // so the audit trigger can read the deleting actor via current_setting('audit.user_id').
        sql`SELECT set_config('audit.user_id', ${String(userId)}, true)`.pipe(
          Effect.flatMap(() => deleteReturningQuery({ id, team_id: teamId })),
          Effect.map(Option.isSome),
          catchSqlErrors,
        ),
      )
      .pipe(catchSqlErrors);

  const balanceSummaryByTeam = (
    teamId: Team.TeamId,
    range: { from?: DateTime.Utc | undefined; to?: DateTime.Utc | undefined } = {},
  ) => {
    const from = Option.fromUndefinedOr(range.from);
    const to = Option.fromUndefinedOr(range.to);
    return sql`
      WITH
        income AS (
          SELECT
            f.currency,
            COALESCE(SUM(p.amount_minor), 0)::bigint AS income_minor
          FROM payments p
          JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
          JOIN fees f ON f.id = fa.fee_id
          WHERE f.team_id = ${teamId}
            AND p.voided_at IS NULL
            AND (${Option.isNone(from)} OR p.paid_at >= ${Option.getOrNull(from)})
            AND (${Option.isNone(to)} OR p.paid_at <= ${Option.getOrNull(to)})
          GROUP BY f.currency
        ),
        expense_totals AS (
          SELECT
            currency,
            COALESCE(SUM(amount_minor), 0)::bigint AS expenses_minor
          FROM expenses
          WHERE team_id = ${teamId}
            AND (${Option.isNone(from)} OR spent_at >= ${Option.getOrNull(from)})
            AND (${Option.isNone(to)} OR spent_at <= ${Option.getOrNull(to)})
          GROUP BY currency
        )
      SELECT
        COALESCE(i.currency, e.currency) AS currency,
        COALESCE(i.income_minor, 0)::bigint AS income_minor,
        COALESCE(e.expenses_minor, 0)::bigint AS expenses_minor
      FROM income i
      FULL OUTER JOIN expense_totals e ON e.currency = i.currency
      ORDER BY 1
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(BalanceSummaryRawRow))),
      Effect.map((rows): ReadonlyArray<BalanceSummaryRow> => {
        return rows.map((row) => {
          const incomeMinor = Number(row.income_minor);
          const expensesMinor = Number(row.expenses_minor);
          return {
            currency: row.currency,
            incomeMinor: incomeMinor as Expense.AmountMinor,
            expensesMinor: expensesMinor as Expense.AmountMinor,
            netMinor: (incomeMinor - expensesMinor) as ExpenseApi.NetAmountMinor,
          };
        });
      }),
      catchSqlErrors,
    );
  };

  // Test helper
  const countHistoryRows = (expenseId: Expense.ExpenseId, operation: string) =>
    countHistoryRowsQuery({ expense_id: expenseId, operation }).pipe(
      Effect.map((r) => r.count),
      catchSqlErrors,
    );

  return {
    insert,
    findById,
    listByTeam,
    update,
    delete: delete_,
    balanceSummaryByTeam,
    countHistoryRows,
  };
});

export class ExpensesRepository extends ServiceMap.Service<
  ExpensesRepository,
  Effect.Success<typeof make>
>()('api/ExpensesRepository') {
  static readonly Default = Layer.effect(ExpensesRepository, make);
}
