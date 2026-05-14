import { Fee, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

export class FeeRow extends Schema.Class<FeeRow>('FeeRow')({
  id: Fee.FeeId,
  team_id: Team.TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  amount_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  recurrence: Fee.FeeRecurrence,
  target_scope: Fee.FeeTargetScope,
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
  archived_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

export class FeeWithCountsRow extends Schema.Class<FeeWithCountsRow>('FeeWithCountsRow')({
  id: Fee.FeeId,
  team_id: Team.TeamId,
  name: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  amount_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  recurrence: Fee.FeeRecurrence,
  target_scope: Fee.FeeTargetScope,
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
  archived_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  assignment_count: Schema.Number,
  paid_count: Schema.Number,
  pending_count: Schema.Number,
  overdue_count: Schema.Number,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      name: Schema.String,
      description: Schema.OptionFromNullOr(Schema.String),
      amount_minor: Fee.AmountMinor,
      currency: Fee.CurrencyCode,
      due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      target_scope: Fee.FeeTargetScope,
    }),
    Result: FeeRow,
    execute: (input) => sql`
      INSERT INTO fees (team_id, name, description, amount_minor, currency, due_at, target_scope)
      VALUES (
        ${input.team_id},
        ${input.name},
        ${input.description},
        ${input.amount_minor},
        ${input.currency},
        ${input.due_at},
        ${input.target_scope}
      )
      RETURNING *
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Fee.FeeId,
    Result: FeeRow,
    execute: (id) => sql`SELECT * FROM fees WHERE id = ${id} AND archived_at IS NULL`,
  });

  const findWithCountsByIdQuery = SqlSchema.findOneOption({
    Request: Fee.FeeId,
    Result: FeeWithCountsRow,
    execute: (id) => sql`
      SELECT f.*,
        COUNT(v.assignment_id)::int AS assignment_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'paid')::int AS paid_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status IN ('pending', 'partial'))::int AS pending_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'overdue')::int AS overdue_count
      FROM fees f
      LEFT JOIN fee_assignment_status_v v ON v.fee_id = f.id
      WHERE f.id = ${id} AND f.archived_at IS NULL
      GROUP BY f.id
    `,
  });

  const listByTeamActiveQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: FeeWithCountsRow,
    execute: (teamId) => sql`
      SELECT f.*,
        COUNT(v.assignment_id)::int AS assignment_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'paid')::int AS paid_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status IN ('pending', 'partial'))::int AS pending_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'overdue')::int AS overdue_count
      FROM fees f
      LEFT JOIN fee_assignment_status_v v ON v.fee_id = f.id
      WHERE f.team_id = ${teamId} AND f.archived_at IS NULL
      GROUP BY f.id
      ORDER BY f.created_at ASC
    `,
  });

  const listByTeamAllQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: FeeWithCountsRow,
    execute: (teamId) => sql`
      SELECT f.*,
        COUNT(v.assignment_id)::int AS assignment_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'paid')::int AS paid_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status IN ('pending', 'partial'))::int AS pending_count,
        COUNT(v.assignment_id) FILTER (WHERE v.status = 'overdue')::int AS overdue_count
      FROM fees f
      LEFT JOIN fee_assignment_status_v v ON v.fee_id = f.id
      WHERE f.team_id = ${teamId}
      GROUP BY f.id
      ORDER BY f.created_at ASC
    `,
  });

  const archiveQuery = SqlSchema.void({
    Request: Fee.FeeId,
    execute: (id) =>
      sql`UPDATE fees SET archived_at = now(), updated_at = now() WHERE id = ${id} AND archived_at IS NULL`,
  });

  // Test helpers
  const insertAssignmentQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      fee_id: Fee.FeeId,
      team_member_id: TeamMember.TeamMemberId,
      amount_minor: Fee.AmountMinor,
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor)
      VALUES (${input.fee_id}, ${input.team_member_id}, ${input.amount_minor})
      RETURNING id
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: Fee.FeeId,
    execute: (id) => sql`DELETE FROM fees WHERE id = ${id}`,
  });

  const countAssignmentsQuery = SqlSchema.findOne({
    Request: Fee.FeeId,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (feeId) =>
      sql`SELECT COUNT(*)::int AS count FROM fee_assignments WHERE fee_id = ${feeId}`,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const insert = (input: {
    team_id: Team.TeamId;
    name: string;
    description: Option.Option<string>;
    amount_minor: number;
    currency: string;
    due_at: Option.Option<unknown>;
    target_scope?: Fee.FeeTargetScope;
  }) =>
    insertQuery({
      team_id: input.team_id,
      name: input.name,
      description: input.description,
      amount_minor: input.amount_minor as Fee.AmountMinor,
      currency: input.currency as Fee.CurrencyCode,
      due_at: input.due_at as Option.Option<never>,
      target_scope: (input.target_scope ?? 'all_members') as Fee.FeeTargetScope,
    }).pipe(catchSqlErrors);

  const findById = (id: Fee.FeeId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findWithCountsById = (id: Fee.FeeId) => findWithCountsByIdQuery(id).pipe(catchSqlErrors);

  const listByTeam = (teamId: Team.TeamId, opts?: { includeArchived?: boolean }) =>
    (opts?.includeArchived ? listByTeamAllQuery(teamId) : listByTeamActiveQuery(teamId)).pipe(
      catchSqlErrors,
    );

  const update = (
    id: Fee.FeeId,
    patch: {
      name: Option.Option<string>;
      description: Option.Option<Option.Option<string>>;
      amount_minor: Option.Option<Fee.AmountMinor>;
      currency: Option.Option<Fee.CurrencyCode>;
      due_at: Option.Option<Option.Option<unknown>>;
      target_scope: Option.Option<Fee.FeeTargetScope>;
    },
  ) =>
    SqlSchema.findOne({
      Request: Schema.Void,
      Result: FeeRow,
      execute: () => sql`
        UPDATE fees SET
          name = CASE WHEN ${Option.isSome(patch.name)} THEN ${Option.getOrNull(patch.name)} ELSE name END,
          description = CASE WHEN ${Option.isSome(patch.description)} THEN ${Option.isNone(patch.description) ? null : Option.getOrNull(Option.getOrElse(patch.description, () => Option.none<string>()))} ELSE description END,
          amount_minor = CASE WHEN ${Option.isSome(patch.amount_minor)} THEN ${Option.getOrNull(patch.amount_minor)} ELSE amount_minor END,
          currency = CASE WHEN ${Option.isSome(patch.currency)} THEN ${Option.getOrNull(patch.currency)} ELSE currency END,
          due_at = CASE WHEN ${Option.isSome(patch.due_at)} THEN ${Option.isNone(patch.due_at) ? null : Option.getOrNull(Option.getOrElse(patch.due_at, () => Option.none<Date>()) as Option.Option<Date | null>)} ELSE due_at END,
          target_scope = CASE WHEN ${Option.isSome(patch.target_scope)} THEN ${Option.getOrNull(patch.target_scope)} ELSE target_scope END,
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `,
    })(undefined).pipe(catchSqlErrors);

  const archive = (id: Fee.FeeId) => archiveQuery(id).pipe(catchSqlErrors);

  // Test helpers (not part of public API contract)
  const insertAssignmentForTest = (
    feeId: Fee.FeeId,
    teamMemberId: TeamMember.TeamMemberId,
    amountMinor: number,
  ) =>
    insertAssignmentQuery({
      fee_id: feeId,
      team_member_id: teamMemberId,
      amount_minor: amountMinor as Fee.AmountMinor,
    }).pipe(catchSqlErrors);

  const delete_ = (id: Fee.FeeId) => deleteQuery(id).pipe(catchSqlErrors);

  const countAssignmentsByFeeId = (feeId: Fee.FeeId) =>
    countAssignmentsQuery(feeId).pipe(
      Effect.map((r) => r.count),
      catchSqlErrors,
    );

  return {
    insert,
    findById,
    findWithCountsById,
    listByTeam,
    update,
    archive,
    // test helpers
    insertAssignmentForTest,
    delete_,
    countAssignmentsByFeeId,
  };
});

export class FeesRepository extends ServiceMap.Service<
  FeesRepository,
  Effect.Success<typeof make>
>()('api/FeesRepository') {
  static readonly Default = Layer.effect(FeesRepository, make);
}
