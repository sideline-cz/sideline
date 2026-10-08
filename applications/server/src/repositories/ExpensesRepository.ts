import { Auth, BankTransaction, Expense, ExpenseApi, Team } from '@sideline/domain';
import { Schemas, SqlErrors } from '@sideline/effect-lib';
import { Data, type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const BANK_TRANSACTION_UNIQUE_CONSTRAINT = 'uq_expenses_bank_transaction_id';

/** The referenced movement already has an expense. Raised from the unique violation alone —
 * there is deliberately no pre-flight SELECT, so two concurrent inserts cannot both win. */
export class BankTransactionAlreadyExpensed extends Data.TaggedError(
  'BankTransactionAlreadyExpensed',
)<{}> {}

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
  bank_transaction_id: Schema.OptionFromNullOr(BankTransaction.BankTransactionId),
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
  bank_transaction_id: Schema.OptionFromNullOr(BankTransaction.BankTransactionId),
  created_by_user_id: Auth.UserId,
  updated_by_user_id: Auth.UserId,
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
  created_by_name: Schema.OptionFromNullOr(Schema.String),
  updated_by_name: Schema.OptionFromNullOr(Schema.String),
  attachments: Schema.Array(Expense.ExpenseAttachmentMeta),
}) {}

/**
 * Attachment METADATA for one expense, as a jsonb array, empty array (never NULL, never [null])
 * when the expense has none. One correlated scalar subquery per outer row, served by
 * idx_expense_attachments_expense_id — no second round trip and no N+1.
 *
 * node-pg parses jsonb columns into plain JS values, so the read side decodes this with
 * Schema.Array(Expense.ExpenseAttachmentMeta) and gets real class instances back, which is what
 * ExpenseView requires (Schema.Class is nominal).
 *
 * jsonb_agg over zero rows returns NULL, hence the COALESCE to an empty array. The
 * FROM ... WHERE form cannot yield [null]: jsonb_build_object is never NULL.
 *
 * The alias is a parameter because the INSERT/UPDATE queries select from a CTE aliased "a" while
 * findById/listByTeam select from "e". It is a module constant, never user input, and is spliced
 * with sql.unsafe the same way RostersRepository splices effectiveRolesAggLateral.
 */
const attachmentsAgg = (expenseAlias: string): string => `
  COALESCE(
    (SELECT jsonb_agg(
       jsonb_build_object(
         'attachmentId', ea.id,
         'filename', ea.filename,
         'contentType', ea.content_type,
         'sizeBytes', ea.size_bytes
       ) ORDER BY ea.created_at ASC, ea.id ASC
     )
     FROM expense_attachments ea
     WHERE ea.expense_id = ${expenseAlias}.id),
    '[]'::jsonb
  ) AS attachments
`;

// ---------------------------------------------------------------------------
// Balance-summary row (decoded once in the repo so callers receive typed values)
// ---------------------------------------------------------------------------

// Postgres returns BIGINT columns as strings via node-pg; `Expense.AmountMinor`
// decodes both a number and a numeric string (via its `NumberFromString` branch),
// so it validates and converts the raw BIGINT-as-string output in one step.
// Sums of int64 minor units never approach Number.MAX_SAFE_INTEGER for plausible
// team budgets.
// `income_minor`/`expenses_minor` are SUMs of `payments.amount_minor` and
// `expenses.amount_minor`, both of which are non-negative by DB CHECK constraint;
// voided payments are excluded via `voided_at IS NULL`. So the sums can never be
// negative, and decoding them as (non-negative) `AmountMinor` is safe. A future
// signed-amount feature (e.g. refunds) would need a signed schema here instead.
const BalanceSummaryRawRow = Schema.Struct({
  currency: Expense.CurrencyCode,
  income_minor: Expense.AmountMinor,
  expenses_minor: Expense.AmountMinor,
});

const CategoryBreakdownRawRow = Schema.Struct({
  currency: Expense.CurrencyCode,
  category: Expense.ExpenseCategory,
  amount_minor: Expense.AmountMinor,
});

const MonthlyRawRow = Schema.Struct({
  currency: Expense.CurrencyCode,
  // `::text` in the query, not a DATE: see `ExpenseApi.MonthKey` for why the team-local month
  // stays a key and never becomes an instant.
  month: ExpenseApi.MonthKey,
  income_minor: Expense.AmountMinor,
  expenses_minor: Expense.AmountMinor,
});

const SeasonWindowRawRow = Schema.Struct({
  starts_at: Schemas.DateTimeFromDate,
  // NULL = the season never ends on its own, so it runs up to now().
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
});

export interface BalanceSummaryRow {
  readonly currency: Expense.CurrencyCode;
  readonly incomeMinor: Expense.AmountMinor;
  readonly expensesMinor: Expense.AmountMinor;
  readonly netMinor: ExpenseApi.NetAmountMinor;
  readonly byCategory: ReadonlyArray<{
    readonly category: Expense.ExpenseCategory;
    readonly amountMinor: Expense.AmountMinor;
  }>;
  readonly byMonth: ReadonlyArray<{
    readonly month: ExpenseApi.MonthKey;
    readonly incomeMinor: Expense.AmountMinor;
    readonly expensesMinor: Expense.AmountMinor;
  }>;
}

/** What `balanceSummaryByTeam` actually scoped to, which is not always what was asked for. */
export interface BalanceWindowApplied {
  readonly window: ExpenseApi.BalanceWindow;
  readonly windowStart: Option.Option<DateTime.Utc>;
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
      bank_transaction_id: Schema.OptionFromNullOr(BankTransaction.BankTransactionId),
      created_by_user_id: Auth.UserId,
      updated_by_user_id: Auth.UserId,
    }),
    Result: ExpenseWithNamesRow,
    execute: (input) => sql`
      WITH affected AS (
        INSERT INTO expenses (team_id, amount_minor, currency, spent_at, category, description, bank_transaction_id, created_by_user_id, updated_by_user_id)
        VALUES (
          ${input.team_id},
          ${input.amount_minor},
          ${input.currency},
          ${input.spent_at},
          ${input.category},
          ${input.description},
          ${input.bank_transaction_id},
          ${input.created_by_user_id},
          ${input.updated_by_user_id}
        )
        RETURNING *
      )
      SELECT
        a.*,
        COALESCE(cu.name, cu.discord_display_name, cu.discord_nickname, cu.username) AS created_by_name,
        COALESCE(uu.name, uu.discord_display_name, uu.discord_nickname, uu.username) AS updated_by_name,
        ${sql.unsafe(attachmentsAgg('a'))}
      FROM affected a
      LEFT JOIN users cu ON cu.id = a.created_by_user_id
      LEFT JOIN users uu ON uu.id = a.updated_by_user_id
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: Expense.ExpenseId, team_id: Team.TeamId }),
    Result: ExpenseWithNamesRow,
    execute: (input) =>
      sql`
        SELECT
          e.*,
          COALESCE(cu.name, cu.discord_display_name, cu.discord_nickname, cu.username) AS created_by_name,
          COALESCE(uu.name, uu.discord_display_name, uu.discord_nickname, uu.username) AS updated_by_name,
          ${sql.unsafe(attachmentsAgg('e'))}
        FROM expenses e
        LEFT JOIN users cu ON cu.id = e.created_by_user_id
        LEFT JOIN users uu ON uu.id = e.updated_by_user_id
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
        COALESCE(uu.name, uu.discord_display_name, uu.discord_nickname, uu.username) AS updated_by_name,
        ${sql.unsafe(attachmentsAgg('e'))}
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
        WITH affected AS (
          UPDATE expenses SET
            amount_minor = CASE WHEN ${Option.isSome(patch.amount_minor)} THEN ${Option.getOrNull(patch.amount_minor)} ELSE amount_minor END,
            currency = CASE WHEN ${Option.isSome(patch.currency)} THEN ${Option.getOrNull(patch.currency)} ELSE currency END,
            spent_at = CASE WHEN ${Option.isSome(patch.spent_at)} THEN ${Option.getOrNull(patch.spent_at)} ELSE spent_at END,
            category = CASE WHEN ${Option.isSome(patch.category)} THEN ${Option.getOrNull(patch.category)} ELSE category END,
            description = CASE WHEN ${Option.isSome(patch.description)} THEN ${Option.getOrNull(patch.description)} ELSE description END,
            updated_by_user_id = ${userId},
            updated_at = now()
          WHERE id = ${id} AND team_id = ${teamId}
          RETURNING *
        )
        SELECT
          a.*,
          COALESCE(cu.name, cu.discord_display_name, cu.discord_nickname, cu.username) AS created_by_name,
          COALESCE(uu.name, uu.discord_display_name, uu.discord_nickname, uu.username) AS updated_by_name,
          ${sql.unsafe(attachmentsAgg('a'))}
        FROM affected a
        LEFT JOIN users cu ON cu.id = a.created_by_user_id
        LEFT JOIN users uu ON uu.id = a.updated_by_user_id
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
    bank_transaction_id?: Option.Option<BankTransaction.BankTransactionId> | undefined;
    created_by_user_id: Auth.UserId;
    updated_by_user_id: Auth.UserId;
  }) =>
    insertQuery({
      team_id: input.team_id,
      amount_minor: Schema.decodeSync(Expense.AmountMinor)(input.amount_minor),
      currency: Schema.decodeSync(Expense.CurrencyCode)(input.currency),
      spent_at: input.spent_at,
      category: input.category,
      description: input.description,
      bank_transaction_id: input.bank_transaction_id ?? Option.none(),
      created_by_user_id: input.created_by_user_id,
      updated_by_user_id: input.updated_by_user_id,
    }).pipe(
      // Must precede `catchSqlErrors`, which would otherwise turn the violation into a defect.
      SqlErrors.catchUniqueViolationOn(
        BANK_TRANSACTION_UNIQUE_CONSTRAINT,
        () => new BankTransactionAlreadyExpensed(),
      ),
      catchSqlErrors,
    );

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

  /**
   * Turn the caller's request into the concrete `from`/`to` the three aggregates filter on, plus
   * the window that was ACTUALLY applied.
   *
   * A requested season is not always an applied season: `governing_season_id` returns NULL for a
   * team whose only seasons are closed and in the future (see 1793900000 step 4a), and that team
   * must get all-time figures under an all-time label rather than an empty page under a season one.
   */
  const resolveWindow = (
    teamId: Team.TeamId,
    range: {
      from?: DateTime.Utc | undefined;
      to?: DateTime.Utc | undefined;
      window?: ExpenseApi.BalanceWindow | undefined;
    },
  ) => {
    const allTime = {
      from: Option.fromUndefinedOr(range.from),
      to: Option.fromUndefinedOr(range.to),
      // An explicit from/to is a custom range, not a season — it reports as 'all' because the
      // literal only ever distinguishes "scoped to the governing season" from "not".
      window: 'all' as const,
      windowStart: Option.none<DateTime.Utc>(),
    };
    if (range.window !== 'season' || range.from !== undefined || range.to !== undefined) {
      return Effect.succeed(allTime);
    }
    return sql`
      SELECT s.starts_at, s.expires_at
      FROM seasons s
      WHERE s.id = governing_season_id(${teamId})
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(SeasonWindowRawRow))),
      Effect.map((rows) =>
        rows.length === 0
          ? allTime
          : {
              from: Option.some(rows[0].starts_at),
              // None = the season never ends on its own, so it runs to now() — left open rather
              // than pinned to a timestamp, so the figures stay live as the season continues.
              to: rows[0].expires_at,
              window: 'season' as const,
              windowStart: Option.some(rows[0].starts_at),
            },
      ),
      catchSqlErrors,
    );
  };

  const balanceSummaryByTeam = (
    teamId: Team.TeamId,
    range: {
      from?: DateTime.Utc | undefined;
      to?: DateTime.Utc | undefined;
      window?: ExpenseApi.BalanceWindow | undefined;
    } = {},
  ) => {
    return Effect.Do.pipe(
      // Must resolve BEFORE the aggregates — they all read the from/to it produces.
      Effect.bind('applied', () => resolveWindow(teamId, range)),
      Effect.bind('totals', ({ applied: { from, to } }) =>
        sql`
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
          catchSqlErrors,
        ),
      ),
      Effect.bind('categories', ({ applied: { from, to } }) =>
        sql`
          SELECT
            currency,
            category,
            COALESCE(SUM(amount_minor), 0)::bigint AS amount_minor
          FROM expenses
          WHERE team_id = ${teamId}
            AND (${Option.isNone(from)} OR spent_at >= ${Option.getOrNull(from)})
            AND (${Option.isNone(to)} OR spent_at <= ${Option.getOrNull(to)})
          GROUP BY currency, category
          ORDER BY amount_minor DESC
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CategoryBreakdownRawRow))),
          catchSqlErrors,
        ),
      ),
      // Same two sources and the same predicates as `totals`, bucketed per month instead of
      // collapsed. `training_period_start` (1793200000) is the month key the team already sees on
      // its fees — reusing it keeps the trend's months aligned with the fee periods and resolves
      // the bucket in `team_settings.timezone` rather than the server's.
      Effect.bind('monthly', ({ applied: { from, to } }) =>
        sql`
          WITH
            income AS (
              SELECT
                f.currency,
                training_period_start(p.paid_at, ${teamId})::text AS month,
                COALESCE(SUM(p.amount_minor), 0)::bigint AS income_minor
              FROM payments p
              JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
              JOIN fees f ON f.id = fa.fee_id
              WHERE f.team_id = ${teamId}
                AND p.voided_at IS NULL
                AND (${Option.isNone(from)} OR p.paid_at >= ${Option.getOrNull(from)})
                AND (${Option.isNone(to)} OR p.paid_at <= ${Option.getOrNull(to)})
              GROUP BY 1, 2
            ),
            expense_months AS (
              SELECT
                currency,
                training_period_start(spent_at, ${teamId})::text AS month,
                COALESCE(SUM(amount_minor), 0)::bigint AS expenses_minor
              FROM expenses
              WHERE team_id = ${teamId}
                AND (${Option.isNone(from)} OR spent_at >= ${Option.getOrNull(from)})
                AND (${Option.isNone(to)} OR spent_at <= ${Option.getOrNull(to)})
              GROUP BY 1, 2
            )
          SELECT
            COALESCE(i.currency, e.currency) AS currency,
            COALESCE(i.month, e.month) AS month,
            COALESCE(i.income_minor, 0)::bigint AS income_minor,
            COALESCE(e.expenses_minor, 0)::bigint AS expenses_minor
          FROM income i
          FULL OUTER JOIN expense_months e ON e.currency = i.currency AND e.month = i.month
          ORDER BY 1, 2
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(MonthlyRawRow))),
          catchSqlErrors,
        ),
      ),
      Effect.map(
        ({
          totals,
          categories,
          monthly,
          applied,
        }): BalanceWindowApplied & { readonly summaries: ReadonlyArray<BalanceSummaryRow> } => ({
          window: applied.window,
          windowStart: applied.windowStart,
          summaries: totals.map((row) => {
            const { income_minor: incomeMinor, expenses_minor: expensesMinor } = row;
            const byCategory = categories
              .filter((c) => c.currency === row.currency)
              .map((c) => ({
                category: c.category,
                amountMinor: c.amount_minor,
              }));
            const byMonth = monthly
              .filter((m) => m.currency === row.currency)
              .map((m) => ({
                month: m.month,
                incomeMinor: m.income_minor,
                expensesMinor: m.expenses_minor,
              }));
            return {
              currency: row.currency,
              incomeMinor,
              expensesMinor,
              netMinor: Schema.decodeSync(ExpenseApi.NetAmountMinor)(incomeMinor - expensesMinor),
              byCategory,
              byMonth,
            };
          }),
        }),
      ),
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
