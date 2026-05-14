import { Auth, Fee, FeeAssignment, Payment, Team, TeamMember } from '@sideline/domain';
import { Schemas } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

export class PaymentRow extends Schema.Class<PaymentRow>('PaymentRow')({
  id: Payment.PaymentId,
  fee_assignment_id: FeeAssignment.FeeAssignmentId,
  team_member_id: TeamMember.TeamMemberId,
  amount_minor: Fee.AmountMinor,
  method: Payment.PaymentMethod,
  paid_at: Schemas.DateTimeFromDate,
  note: Schema.OptionFromNullOr(Schema.String),
  recorded_by_user_id: Auth.UserId,
  voided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  voided_by_user_id: Schema.OptionFromNullOr(Auth.UserId),
  void_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Schemas.DateTimeFromDate,
}) {}

export class PaymentViewRow extends Schema.Class<PaymentViewRow>('PaymentViewRow')({
  id: Payment.PaymentId,
  fee_assignment_id: FeeAssignment.FeeAssignmentId,
  team_member_id: TeamMember.TeamMemberId,
  amount_minor: Fee.AmountMinor,
  method: Payment.PaymentMethod,
  paid_at: Schemas.DateTimeFromDate,
  note: Schema.OptionFromNullOr(Schema.String),
  recorded_by_user_id: Auth.UserId,
  voided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  voided_by_user_id: Schema.OptionFromNullOr(Auth.UserId),
  void_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Schemas.DateTimeFromDate,
  member_name: Schema.OptionFromNullOr(Schema.String),
  recorder_name: Schema.OptionFromNullOr(Schema.String),
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      fee_assignment_id: FeeAssignment.FeeAssignmentId,
      team_member_id: TeamMember.TeamMemberId,
      amount_minor: Fee.AmountMinor,
      method: Payment.PaymentMethod,
      paid_at: Schemas.DateTimeFromDate,
      note: Schema.OptionFromNullOr(Schema.String),
      recorded_by_user_id: Auth.UserId,
    }),
    Result: PaymentRow,
    execute: (input) => sql`
      INSERT INTO payments (fee_assignment_id, team_member_id, amount_minor, method, paid_at, note, recorded_by_user_id)
      VALUES (
        ${input.fee_assignment_id},
        ${input.team_member_id},
        ${input.amount_minor},
        ${input.method},
        ${input.paid_at},
        ${input.note},
        ${input.recorded_by_user_id}
      )
      RETURNING *
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Payment.PaymentId,
    Result: PaymentRow,
    execute: (id) => sql`SELECT * FROM payments WHERE id = ${id}`,
  });

  const findActiveByIdQuery = SqlSchema.findOneOption({
    Request: Payment.PaymentId,
    Result: PaymentRow,
    execute: (id) => sql`SELECT * FROM payments WHERE id = ${id} AND voided_at IS NULL`,
  });

  const findActiveByIdAndTeamQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Payment.PaymentId,
      team_id: Team.TeamId,
    }),
    Result: PaymentRow,
    execute: (input) => sql`
      SELECT p.*
      FROM payments p
      JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
      JOIN fees f ON f.id = fa.fee_id
      WHERE p.id = ${input.id}
        AND p.voided_at IS NULL
        AND f.team_id = ${input.team_id}
    `,
  });

  const voidQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: Payment.PaymentId,
      voided_by_user_id: Auth.UserId,
      void_reason: Schema.String,
      voided_at: Schemas.DateTimeFromDate,
    }),
    Result: PaymentRow,
    execute: (input) => sql`
      UPDATE payments SET
        voided_at = ${input.voided_at},
        voided_by_user_id = ${input.voided_by_user_id},
        void_reason = ${input.void_reason}
      WHERE id = ${input.id} AND voided_at IS NULL
      RETURNING *
    `,
  });

  // Test helper
  const hardDeleteQuery = SqlSchema.void({
    Request: Payment.PaymentId,
    execute: (id) => sql`DELETE FROM payments WHERE id = ${id}`,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const insert = (input: {
    feeAssignmentId: FeeAssignment.FeeAssignmentId | undefined;
    teamMemberId: TeamMember.TeamMemberId;
    amountMinor: number;
    method: Payment.PaymentMethod;
    paidAt: DateTime.Utc;
    note: Option.Option<string>;
    recordedByUserId: Auth.UserId;
  }) =>
    insertQuery({
      fee_assignment_id: input.feeAssignmentId as FeeAssignment.FeeAssignmentId,
      team_member_id: input.teamMemberId,
      amount_minor: input.amountMinor as Fee.AmountMinor,
      method: input.method,
      paid_at: input.paidAt,
      note: input.note,
      recorded_by_user_id: input.recordedByUserId,
    }).pipe(catchSqlErrors);

  const findById = (id: Payment.PaymentId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findActiveById = (id: Payment.PaymentId) => findActiveByIdQuery(id).pipe(catchSqlErrors);

  const findActiveByIdAndTeam = (id: Payment.PaymentId, teamId: Team.TeamId) =>
    findActiveByIdAndTeamQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const void_ = (
    id: Payment.PaymentId,
    input: {
      voidedByUserId: Auth.UserId;
      voidReason: string;
      voidedAt: DateTime.Utc;
    },
  ) =>
    voidQuery({
      id,
      voided_by_user_id: input.voidedByUserId,
      void_reason: input.voidReason,
      voided_at: input.voidedAt,
    }).pipe(catchSqlErrors);

  const listByTeam = (
    teamId: Team.TeamId,
    filters: {
      memberId?: Option.Option<TeamMember.TeamMemberId>;
      feeId?: Option.Option<Fee.FeeId>;
      from?: Option.Option<unknown>;
      to?: Option.Option<unknown>;
      includeVoided?: boolean;
    },
  ) => {
    const memberId = filters.memberId ?? Option.none<TeamMember.TeamMemberId>();
    const feeId = filters.feeId ?? Option.none<Fee.FeeId>();
    const from = filters.from ?? Option.none<Date>();
    const to = filters.to ?? Option.none<Date>();
    const noMemberId = Option.isNone(memberId);
    const memberIdVal = Option.getOrNull(memberId);
    const noFeeId = Option.isNone(feeId);
    const feeIdVal = Option.getOrNull(feeId);
    const noFrom = Option.isNone(from);
    const fromVal = Option.getOrNull(from);
    const noTo = Option.isNone(to);
    const toVal = Option.getOrNull(to);
    const includeVoided = filters.includeVoided ?? false;
    return sql`
      SELECT
        p.id, p.fee_assignment_id, p.team_member_id, p.amount_minor,
        p.method, p.paid_at, p.note, p.recorded_by_user_id,
        p.voided_at, p.voided_by_user_id, p.void_reason, p.created_at,
        mu.name AS member_name,
        ru.name AS recorder_name
      FROM payments p
      JOIN fee_assignments fa ON fa.id = p.fee_assignment_id
      JOIN fees f ON f.id = fa.fee_id
      LEFT JOIN team_members mtm ON mtm.id = p.team_member_id
      LEFT JOIN users mu ON mu.id = mtm.user_id
      LEFT JOIN users ru ON ru.id = p.recorded_by_user_id
      WHERE f.team_id = ${teamId}
        AND (${noMemberId} OR p.team_member_id = ${memberIdVal})
        AND (${noFeeId} OR fa.fee_id = ${feeIdVal})
        AND (${noFrom} OR p.paid_at >= ${fromVal})
        AND (${noTo} OR p.paid_at <= ${toVal})
        AND (${includeVoided} OR p.voided_at IS NULL)
      ORDER BY p.paid_at DESC
    `.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(PaymentViewRow))),
      catchSqlErrors,
    );
  };

  // Test helper
  const hardDeleteForTest = (id: Payment.PaymentId) => hardDeleteQuery(id).pipe(catchSqlErrors);

  return {
    insert,
    findById,
    findActiveById,
    findActiveByIdAndTeam,
    void_,
    listByTeam,
    hardDeleteForTest,
  };
});

export class PaymentsRepository extends ServiceMap.Service<
  PaymentsRepository,
  Effect.Success<typeof make>
>()('api/PaymentsRepository') {
  static readonly Default = Layer.effect(PaymentsRepository, make);
}
