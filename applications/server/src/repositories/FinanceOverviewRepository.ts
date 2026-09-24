import { Auth, Fee, Team, TeamMember } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class OverviewRow extends Schema.Class<OverviewRow>('OverviewRow')({
  teamMemberId: TeamMember.TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  currency: Fee.CurrencyCode,
  totalDueMinor: Schema.Number,
  totalPaidMinor: Schema.Number,
  overdueCount: Schema.Number,
  pendingCount: Schema.Number,
  paidCount: Schema.Number,
  // this row's currency, 0 when none (§6.3)
  creditMinor: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // §6.3 — driven off a UNION of keys (assignment currencies + credit-holding currencies), not
  // fee_assignment_status_v alone: a member with credit and NO assignments used to produce no
  // row at all, making a prepayment invisible to the treasurer.
  //
  // COUNT(v.assignment_id), never COUNT(*): the LEFT JOIN makes COUNT(*) return 1 for a
  // credit-only row (the single most likely off-by-one in this change).
  const overviewByTeamQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: OverviewRow,
    execute: (teamId) => sql`
      WITH keys AS (
        SELECT fa.team_member_id, v.currency
          FROM fee_assignment_status_v v
          JOIN fee_assignments fa ON fa.id = v.assignment_id
         WHERE v.team_id = ${teamId}
        UNION
        SELECT a.team_member_id, a.currency
          FROM member_credit_accounts a
          JOIN team_members tm ON tm.id = a.team_member_id
         WHERE tm.team_id = ${teamId} AND a.balance_minor > 0
      )
      SELECT
        k.team_member_id AS "teamMemberId",
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS "memberName",
        k.currency AS currency,
        COALESCE(SUM(v.due_minor) FILTER (WHERE v.status != 'waived'), 0)::int AS "totalDueMinor",
        COALESCE(SUM(v.paid_minor) FILTER (WHERE v.status != 'waived'), 0)::int AS "totalPaidMinor",
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'overdue')::int AS "overdueCount",
        COUNT(v.assignment_id) FILTER (WHERE v.status IN ('pending', 'partial'))::int AS "pendingCount",
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'paid')::int AS "paidCount",
        COALESCE(MAX(a.balance_minor), 0)::int AS "creditMinor"
      FROM keys k
      LEFT JOIN team_members tm ON tm.id = k.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      LEFT JOIN fee_assignments fa ON fa.team_member_id = k.team_member_id
      LEFT JOIN fee_assignment_status_v v
             ON v.assignment_id = fa.id AND v.currency = k.currency AND v.team_id = ${teamId}
      LEFT JOIN member_credit_accounts a
             ON a.team_member_id = k.team_member_id AND a.currency = k.currency
      GROUP BY k.team_member_id, k.currency, u.name, u.discord_display_name, u.discord_nickname, u.username
      ORDER BY 2 ASC, k.currency ASC
    `,
  });

  const myStatusQuery = SqlSchema.findAll({
    Request: Schema.Struct({ team_id: Team.TeamId, user_id: Auth.UserId }),
    Result: Schema.Struct({
      team_member_id: TeamMember.TeamMemberId,
      assignment_id: Schema.String,
      fee_id: Schema.String,
      fee_name: Schema.String,
      currency: Fee.CurrencyCode,
      // BIGINT columns, and the pg driver hands int8 back as a string — `Fee.AmountMinor`
      // accepts both, plain `Schema.Number` does not. `overviewByTeamQuery` gets away with
      // `Schema.Number` only because every money column there is cast `::int` in SQL.
      due_minor: Fee.AmountMinor,
      paid_minor: Fee.AmountMinor,
      status: Schema.String,
      effective_due_at: Schema.OptionFromNullOr(Schema.Date),
      waived_reason: Schema.OptionFromNullOr(Schema.String),
      member_name: Schema.OptionFromNullOr(Schema.String),
    }),
    execute: (input) => sql`
      SELECT
        fa.team_member_id,
        v.assignment_id,
        v.fee_id,
        v.fee_name,
        v.currency,
        v.due_minor,
        v.paid_minor,
        v.status,
        v.effective_due_at,
        v.waived_reason,
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS member_name
      FROM team_members tm
      JOIN fee_assignment_status_v v ON v.team_id = tm.team_id
      JOIN fee_assignments fa ON fa.id = v.assignment_id AND fa.team_member_id = tm.id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${input.team_id}
        AND tm.user_id = ${input.user_id}
      ORDER BY v.currency ASC, fa.created_at ASC
    `,
  });

  // §5.3b / §6.2 — plain read, no dependency on MemberCreditsRepository: this query joins
  // member_credit_accounts through team_members exactly as PaymentsRepository.listByTeam joins
  // through fees. No FOR UPDATE, no lock.
  const myCreditQuery = SqlSchema.findAll({
    Request: Schema.Struct({ team_id: Team.TeamId, user_id: Auth.UserId }),
    Result: Schema.Struct({
      currency: Fee.CurrencyCode,
      balance_minor: Fee.AmountMinor,
    }),
    execute: (input) => sql`
      SELECT a.currency, a.balance_minor
        FROM member_credit_accounts a
        JOIN team_members tm ON tm.id = a.team_member_id
       WHERE tm.team_id = ${input.team_id} AND tm.user_id = ${input.user_id}
    `,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const overviewByTeam = (teamId: Team.TeamId) => overviewByTeamQuery(teamId).pipe(catchSqlErrors);

  const myStatus = (teamId: Team.TeamId, userId: Auth.UserId) =>
    Effect.Do.pipe(
      Effect.bind('rows', () => myStatusQuery({ team_id: teamId, user_id: userId })),
      Effect.bind('creditRows', () => myCreditQuery({ team_id: teamId, user_id: userId })),
      Effect.map(({ rows, creditRows }) => {
        // Group by currency
        const byCurrency = new Map<
          string,
          {
            currency: Fee.CurrencyCode;
            assignments: typeof rows;
            totalOutstandingMinor: number;
            creditMinor: number;
          }
        >();

        for (const row of rows) {
          const existing = byCurrency.get(row.currency);
          if (existing) {
            existing.assignments.push(row);
            if (row.status !== 'waived' && row.status !== 'paid') {
              existing.totalOutstandingMinor += Math.max(0, row.due_minor - row.paid_minor);
            }
          } else {
            byCurrency.set(row.currency, {
              currency: row.currency,
              assignments: [row],
              totalOutstandingMinor:
                row.status !== 'waived' && row.status !== 'paid'
                  ? Math.max(0, row.due_minor - row.paid_minor)
                  : 0,
              creditMinor: 0,
            });
          }
        }

        // Merge in every credit balance AFTER the assignment loop — a currency with balance > 0
        // but no assignments still gets a group, defaulting `assignments: []` /
        // `totalOutstandingMinor: 0`, otherwise a member who paid in advance before any fee
        // exists sees nothing at all.
        for (const credit of creditRows) {
          const existing = byCurrency.get(credit.currency);
          if (existing) {
            existing.creditMinor = credit.balance_minor;
          } else {
            byCurrency.set(credit.currency, {
              currency: credit.currency,
              assignments: [],
              totalOutstandingMinor: 0,
              creditMinor: credit.balance_minor,
            });
          }
        }

        return Array.from(byCurrency.values());
      }),
      catchSqlErrors,
    );

  return {
    overviewByTeam,
    myStatus,
  };
});

export class FinanceOverviewRepository extends ServiceMap.Service<
  FinanceOverviewRepository,
  Effect.Success<typeof make>
>()('api/FinanceOverviewRepository') {
  static readonly Default = Layer.effect(FinanceOverviewRepository, make);
}
