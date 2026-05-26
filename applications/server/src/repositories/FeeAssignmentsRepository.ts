import {
  Discord,
  Fee,
  FeeAssignment,
  PaymentReminder,
  Team,
  TeamMember,
  User,
} from '@sideline/domain';
import { LogicError, Schemas } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

// Raw assignment row (from fee_assignments table directly)
class AssignmentRow extends Schema.Class<AssignmentRow>('AssignmentRow')({
  id: FeeAssignment.FeeAssignmentId,
  fee_id: Fee.FeeId,
  team_member_id: TeamMember.TeamMemberId,
  amount_minor: Fee.AmountMinor,
  paid_minor: Fee.AmountMinor,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  stored_status: FeeAssignment.StoredAssignmentStatus,
  waived_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
}) {}

// View-joined row (from fee_assignment_status_v with member name)
export class AssignmentViewRow extends Schema.Class<AssignmentViewRow>('AssignmentViewRow')({
  id: FeeAssignment.FeeAssignmentId,
  fee_id: Fee.FeeId,
  team_member_id: TeamMember.TeamMemberId,
  amount_minor: Fee.AmountMinor,
  paid_minor: Fee.AmountMinor,
  due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  stored_status: FeeAssignment.StoredAssignmentStatus,
  waived_reason: Schema.OptionFromNullOr(Schema.String),
  created_at: Schemas.DateTimeFromDate,
  updated_at: Schemas.DateTimeFromDate,
  // from the view
  fee_name: Schema.String,
  currency: Fee.CurrencyCode,
  due_minor: Fee.AmountMinor,
  effective_due_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  computed_status: FeeAssignment.FeeAssignmentStatus,
  member_name: Schema.OptionFromNullOr(Schema.String),
}) {}

// Row returned by findReminderCandidates
class ReminderCandidateRow extends Schema.Class<ReminderCandidateRow>('ReminderCandidateRow')({
  assignment_id: FeeAssignment.FeeAssignmentId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  user_discord_id: Discord.Snowflake,
  fee_name: Schema.String,
  currency: Schema.String,
  amount_minor: Fee.AmountMinor,
  paid_minor: Fee.AmountMinor,
  effective_due_at: Schema.Date,
  kind: PaymentReminder.PaymentReminderKind,
}) {}

// Row returned by findUnpaidAssignmentsForUser
class UnpaidAssignmentRow extends Schema.Class<UnpaidAssignmentRow>('UnpaidAssignmentRow')({
  assignment_id: FeeAssignment.FeeAssignmentId,
  fee_name: Schema.String,
  currency: Schema.String,
  amount_minor: Fee.AmountMinor,
  paid_minor: Fee.AmountMinor,
  effective_due_at: Schema.Date,
  computed_status: FeeAssignment.FeeAssignmentStatus,
  stored_status: FeeAssignment.StoredAssignmentStatus,
  team_name: Schema.String,
  team_timezone: Schema.String,
}) {}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByIdQuery = SqlSchema.findOneOption({
    Request: FeeAssignment.FeeAssignmentId,
    Result: AssignmentRow,
    execute: (id) => sql`SELECT * FROM fee_assignments WHERE id = ${id}`,
  });

  const findByFeeQuery = SqlSchema.findAll({
    Request: Fee.FeeId,
    Result: AssignmentViewRow,
    execute: (feeId) => sql`
      SELECT
        fa.id, fa.fee_id, fa.team_member_id, fa.amount_minor, fa.paid_minor,
        fa.due_at, fa.stored_status, fa.waived_reason, fa.created_at, fa.updated_at,
        v.fee_name, v.currency, v.due_minor, v.effective_due_at, v.status AS computed_status,
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS member_name
      FROM fee_assignments fa
      JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
      LEFT JOIN team_members tm ON tm.id = fa.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE fa.fee_id = ${feeId}
      ORDER BY fa.created_at ASC
    `,
  });

  const findByTeamMemberQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: AssignmentViewRow,
    execute: (teamMemberId) => sql`
      SELECT
        fa.id, fa.fee_id, fa.team_member_id, fa.amount_minor, fa.paid_minor,
        fa.due_at, fa.stored_status, fa.waived_reason, fa.created_at, fa.updated_at,
        v.fee_name, v.currency, v.due_minor, v.effective_due_at, v.status AS computed_status,
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS member_name
      FROM fee_assignments fa
      JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
      LEFT JOIN team_members tm ON tm.id = fa.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE fa.team_member_id = ${teamMemberId}
      ORDER BY fa.created_at ASC
    `,
  });

  const findByFeeAndMemberQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      fee_id: Fee.FeeId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: AssignmentViewRow,
    execute: (input) => sql`
      SELECT
        fa.id, fa.fee_id, fa.team_member_id, fa.amount_minor, fa.paid_minor,
        fa.due_at, fa.stored_status, fa.waived_reason, fa.created_at, fa.updated_at,
        v.fee_name, v.currency, v.due_minor, v.effective_due_at, v.status AS computed_status,
        COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS member_name
      FROM fee_assignments fa
      JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
      LEFT JOIN team_members tm ON tm.id = fa.team_member_id
      LEFT JOIN users u ON u.id = tm.user_id
      WHERE fa.fee_id = ${input.fee_id} AND fa.team_member_id = ${input.team_member_id}
    `,
  });

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  const findById = (id: FeeAssignment.FeeAssignmentId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findByFee = (feeId: Fee.FeeId) => findByFeeQuery(feeId).pipe(catchSqlErrors);

  const findByTeamMember = (teamMemberId: TeamMember.TeamMemberId) =>
    findByTeamMemberQuery(teamMemberId).pipe(catchSqlErrors);

  const findByFeeAndMember = (feeId: Fee.FeeId, teamMemberId: TeamMember.TeamMemberId) =>
    findByFeeAndMemberQuery({ fee_id: feeId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  /**
   * Bulk-inserts assignments for the given memberIds.
   * Uses ON CONFLICT DO NOTHING for idempotency.
   * Members not belonging to the same team as the fee are silently skipped.
   * Returns ALL assignments (new + existing) for the given member IDs that
   * belong to the fee's team.
   */
  const bulkInsert = (input: {
    feeId: Fee.FeeId;
    memberIds: ReadonlyArray<TeamMember.TeamMemberId>;
    amountMinorOverride: Option.Option<Fee.AmountMinor>;
    dueAtOverride: Option.Option<unknown>;
  }) => {
    if (input.memberIds.length === 0) {
      return Effect.succeed([] as AssignmentViewRow[]);
    }

    // amountOverride / dueAtOverride are SINGLE values applied to ALL members
    // (the input shape carries one override per call, not one per member).
    // Bind each member id individually via sql.join (the codebase's existing
    // pattern, used in the SELECT below) to sidestep Postgres array-binding
    // quirks where pg may serialize a JS array as a record/composite.
    const amountOverrideValue = Option.isSome(input.amountMinorOverride)
      ? (input.amountMinorOverride.value as number)
      : null;
    const dueAtOverrideValue = Option.isSome(input.dueAtOverride)
      ? (input.dueAtOverride.value as Date)
      : null;
    const memberIdFragments = input.memberIds.map((id) => sql`${id}`);
    return sql
      .withTransaction(
        Effect.Do.pipe(
          Effect.tap(
            () =>
              sql`
              INSERT INTO fee_assignments (fee_id, team_member_id, amount_minor, due_at)
              SELECT
                ${input.feeId},
                tm.id,
                COALESCE(${amountOverrideValue}::bigint, f.amount_minor),
                ${dueAtOverrideValue}::timestamptz
              FROM team_members tm
              JOIN fees f ON f.id = ${input.feeId}
              WHERE tm.id IN (${sql.csv(memberIdFragments)})
                AND tm.team_id = f.team_id
              ON CONFLICT (fee_id, team_member_id) DO NOTHING
            `,
          ),
          // Then fetch all assignments for these members (existing or newly inserted)
          Effect.bind('results', () => {
            const memberTuples = input.memberIds.map((id) => sql`${id}`);
            return SqlSchema.findAll({
              Request: Schema.Void,
              Result: AssignmentViewRow,
              execute: () => sql`
                SELECT
                  fa.id, fa.fee_id, fa.team_member_id, fa.amount_minor, fa.paid_minor,
                  fa.due_at, fa.stored_status, fa.waived_reason, fa.created_at, fa.updated_at,
                  v.fee_name, v.currency, v.due_minor, v.effective_due_at, v.status AS computed_status,
                  COALESCE(u.name, u.discord_display_name, u.discord_nickname, u.username) AS member_name
                FROM fee_assignments fa
                JOIN fee_assignment_status_v v ON v.assignment_id = fa.id
                LEFT JOIN team_members tm ON tm.id = fa.team_member_id
                LEFT JOIN users u ON u.id = tm.user_id
                WHERE fa.fee_id = ${input.feeId}
                  AND fa.team_member_id IN (${sql.csv(memberTuples)})
                ORDER BY fa.created_at ASC
              `,
            })(undefined);
          }),
          Effect.map(({ results }) => results),
        ),
      )
      .pipe(catchSqlErrors);
  };

  const update = (
    id: FeeAssignment.FeeAssignmentId | undefined,
    patch: {
      amountMinor: Option.Option<Fee.AmountMinor>;
      dueAt: Option.Option<Option.Option<unknown>>;
      waived: Option.Option<boolean>;
      waivedReason: Option.Option<Option.Option<string>>;
    },
  ) => {
    if (id === undefined) {
      return LogicError.die('Assignment id is required') as never;
    }
    return SqlSchema.findOne({
      Request: Schema.Void,
      Result: AssignmentRow,
      execute: () => {
        const waivedFlag = Option.getOrElse(patch.waived, () => false);
        const isSettingWaived = Option.isSome(patch.waived) && waivedFlag;
        const isUnsettingWaived = Option.isSome(patch.waived) && !waivedFlag;
        const waivedReasonValue = Option.isSome(patch.waivedReason)
          ? Option.getOrNull(Option.getOrElse(patch.waivedReason, () => Option.none<string>()))
          : undefined;

        return sql`
          UPDATE fee_assignments SET
            amount_minor = CASE WHEN ${Option.isSome(patch.amountMinor)} THEN ${Option.getOrNull(patch.amountMinor)} ELSE amount_minor END,
            due_at = CASE WHEN ${Option.isSome(patch.dueAt)} THEN ${
              Option.isNone(patch.dueAt)
                ? null
                : Option.getOrNull(
                    Option.getOrElse(patch.dueAt, () =>
                      Option.none<Date>(),
                    ) as Option.Option<Date | null>,
                  )
            } ELSE due_at END,
            stored_status = CASE
              WHEN ${isSettingWaived} THEN 'waived'
              WHEN ${isUnsettingWaived} THEN 'active'
              ELSE stored_status
            END,
            waived_reason = CASE
              WHEN ${Option.isSome(patch.waivedReason)} THEN ${waivedReasonValue}
              WHEN ${isUnsettingWaived} THEN NULL
              ELSE waived_reason
            END,
            updated_at = now()
          WHERE id = ${id}
          RETURNING *
        `;
      },
    })(undefined).pipe(catchSqlErrors);
  };

  const _findReminderCandidates = SqlSchema.findAll({
    Request: Schema.Date,
    Result: ReminderCandidateRow,
    execute: (now) => sql`
      WITH candidates AS (
        SELECT
          v.assignment_id,
          tm.team_id,
          t.guild_id,
          u.discord_id AS user_discord_id,
          v.fee_name,
          v.currency,
          v.due_minor AS amount_minor,
          v.paid_minor,
          v.effective_due_at,
          (
            DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
            - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
          ) AS day_diff,
          CASE
            WHEN (DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
                  - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))) = -3 THEN 'due_in_3d'
            WHEN (DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
                  - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))) = 0  THEN 'due_today'
            WHEN (DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
                  - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))) = 3  THEN 'overdue_3d'
            WHEN (DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
                  - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))) = 10 THEN 'overdue_10d'
            WHEN (DATE(${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))
                  - DATE(v.effective_due_at AT TIME ZONE COALESCE(ts.timezone, 'UTC'))) = 21 THEN 'overdue_21d'
            ELSE NULL
          END AS kind
        FROM fee_assignment_status_v v
        JOIN fee_assignments fa ON fa.id = v.assignment_id
        JOIN fees f ON f.id = fa.fee_id
        JOIN team_members tm ON tm.id = fa.team_member_id AND tm.active = true
        JOIN users u ON u.id = tm.user_id
        JOIN teams t ON t.id = tm.team_id
        JOIN team_settings ts ON ts.team_id = tm.team_id
        WHERE v.status IN ('pending', 'partial', 'overdue')
          AND v.effective_due_at IS NOT NULL
          AND fa.stored_status != 'waived'
          AND (
            (${now}::timestamptz AT TIME ZONE COALESCE(ts.timezone, 'UTC'))::time
              BETWEEN ts.rsvp_reminder_time
              AND ts.rsvp_reminder_time::time + INTERVAL '5 minutes'
          )
      )
      SELECT
        c.assignment_id,
        c.team_id,
        c.guild_id,
        c.user_discord_id,
        c.fee_name,
        c.currency,
        c.amount_minor,
        c.paid_minor,
        c.effective_due_at,
        c.kind
      FROM candidates c
      WHERE c.kind IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM payment_reminders_sent prs
          WHERE prs.assignment_id = c.assignment_id
            AND prs.kind = c.kind
        )
        AND NOT EXISTS (
          SELECT 1 FROM payment_reminder_sync_events prse
          WHERE prse.assignment_id = c.assignment_id
            AND prse.kind = c.kind
            AND prse.processed_at IS NULL
        )
    `,
  });

  const _findUnpaidAssignmentsForUser = SqlSchema.findAll({
    Request: User.UserId,
    Result: UnpaidAssignmentRow,
    execute: (userId) => sql`
      SELECT
        v.assignment_id,
        v.fee_name,
        v.currency,
        v.due_minor AS amount_minor,
        v.paid_minor,
        v.effective_due_at,
        v.status AS computed_status,
        fa.stored_status,
        t.name AS team_name,
        COALESCE(ts.timezone, 'UTC') AS team_timezone
      FROM fee_assignment_status_v v
      JOIN fee_assignments fa ON fa.id = v.assignment_id
      JOIN team_members tm ON tm.id = fa.team_member_id AND tm.active = true
      JOIN users u ON u.id = tm.user_id
      JOIN teams t ON t.id = tm.team_id
      LEFT JOIN team_settings ts ON ts.team_id = t.id
      WHERE u.id = ${userId}
        AND v.status IN ('pending', 'partial', 'overdue')
        AND v.effective_due_at IS NOT NULL
        AND v.effective_due_at >= now() - INTERVAL '180 days'
      ORDER BY v.effective_due_at ASC
    `,
  });

  const findReminderCandidates = (now: Date) => _findReminderCandidates(now).pipe(catchSqlErrors);

  const findUnpaidAssignmentsForUser = (userId: User.UserId) =>
    _findUnpaidAssignmentsForUser(userId).pipe(catchSqlErrors);

  return {
    findById,
    findByFee,
    findByTeamMember,
    findByFeeAndMember,
    bulkInsert,
    update,
    findReminderCandidates,
    findUnpaidAssignmentsForUser,
  };
});

export class FeeAssignmentsRepository extends ServiceMap.Service<
  FeeAssignmentsRepository,
  Effect.Success<typeof make>
>()('api/FeeAssignmentsRepository') {
  static readonly Default = Layer.effect(FeeAssignmentsRepository, make);
}
