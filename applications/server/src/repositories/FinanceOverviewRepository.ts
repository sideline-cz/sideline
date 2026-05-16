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
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const overviewByTeamQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: OverviewRow,
    execute: (teamId) => sql`
      SELECT
        fa.team_member_id AS "teamMemberId",
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS "memberName",
        v.currency AS currency,
        COALESCE(SUM(v.due_minor) FILTER (WHERE v.status != 'waived'), 0)::int AS "totalDueMinor",
        COALESCE(SUM(v.paid_minor) FILTER (WHERE v.status != 'waived'), 0)::int AS "totalPaidMinor",
        COUNT(*) FILTER (WHERE v.status = 'overdue')::int AS "overdueCount",
        COUNT(*) FILTER (WHERE v.status IN ('pending', 'partial'))::int AS "pendingCount",
        COUNT(*) FILTER (WHERE v.status = 'paid')::int AS "paidCount"
      FROM fee_assignment_status_v v
      JOIN fee_assignments fa ON fa.id = v.assignment_id
      LEFT JOIN team_members tm ON tm.id = fa.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE v.team_id = ${teamId}
      GROUP BY fa.team_member_id, v.currency, u.name, u.discord_display_name, u.discord_nickname, u.username
      ORDER BY 2 ASC, v.currency ASC
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
      due_minor: Schema.Number,
      paid_minor: Schema.Number,
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const overviewByTeam = (teamId: Team.TeamId) => overviewByTeamQuery(teamId).pipe(catchSqlErrors);

  const myStatus = (teamId: Team.TeamId, userId: Auth.UserId) =>
    myStatusQuery({ team_id: teamId, user_id: userId }).pipe(
      Effect.map((rows) => {
        // Group by currency
        const byCurrency = new Map<
          string,
          {
            currency: Fee.CurrencyCode;
            assignments: typeof rows;
            totalOutstandingMinor: number;
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
