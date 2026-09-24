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
import { type DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';
import { nestedOptionToNullable } from '~/repositories/patchHelpers.js';

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
  // D15b/T10c — NULL for an 'assigned' candidate whose fee has no due date at all (the
  // assigned_candidates branch deliberately does not filter `effective_due_at IS NOT NULL`).
  effective_due_at: Schema.OptionFromNullOr(Schema.Date),
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
    dueAtOverride: Option.Option<DateTime.Utc>;
  }) => {
    if (input.memberIds.length === 0) {
      return Effect.succeed<ReadonlyArray<AssignmentViewRow>>([]);
    }

    // amountOverride / dueAtOverride are SINGLE values applied to ALL members
    // (the input shape carries one override per call, not one per member).
    // Bind each member id individually via sql.join (the codebase's existing
    // pattern, used in the SELECT below) to sidestep Postgres array-binding
    // quirks where pg may serialize a JS array as a record/composite.
    const amountOverrideValue = Option.getOrNull(input.amountMinorOverride);
    const dueAtOverrideValue = Option.getOrNull(input.dueAtOverride);
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
      dueAt: Option.Option<Option.Option<DateTime.Utc>>;
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
        const waivedReasonValue = nestedOptionToNullable(patch.waivedReason);

        return sql`
          UPDATE fee_assignments SET
            amount_minor = CASE WHEN ${Option.isSome(patch.amountMinor)} THEN ${Option.getOrNull(patch.amountMinor)} ELSE amount_minor END,
            due_at = CASE WHEN ${Option.isSome(patch.dueAt)} THEN ${nestedOptionToNullable(patch.dueAt)} ELSE due_at END,
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
          -- The club already holds enough of this member's money, in this fee's currency,
          -- to cover EVERYTHING they owe in it. Read-only: no FOR UPDATE, no lock.
          -- Deliberately absent from the lock-order table.
          --
          -- Compare against the member's TOTAL outstanding in this currency, never against
          -- this row's own gap. The predicate is evaluated per candidate row, so a row-local
          -- comparison silences every fee the credit could individually cover: 1700 of credit
          -- against two unpaid 1700 fees satisfies it on BOTH, and both go quiet permanently
          -- even though the credit can only ever pay one. The total is the only comparison
          -- that never wrongly silences.
          --
          -- Only FULL coverage suppresses: 300 of credit against 1700 outstanding is still a
          -- real debt and is still reminded.
          -- NOTE: never use backticks in this comment - the whole query is a template literal.
          AND NOT EXISTS (
            SELECT 1 FROM member_credit_accounts mca
             WHERE mca.team_member_id = fa.team_member_id
               AND mca.currency       = f.currency
               AND mca.balance_minor >= (
                 SELECT COALESCE(SUM(v2.due_minor - v2.paid_minor), 0)
                   FROM fee_assignment_status_v v2
                  WHERE v2.team_member_id = fa.team_member_id
                    AND v2.currency       = f.currency
                    AND v2.status IN ('pending', 'partial', 'overdue')
               )
          )
      ),
      -- D15b/T10c — the 'assigned' reminder is a UNION ALL branch OUTSIDE the
      -- 'rsvp_reminder_time' gate above: it fires immediately at assignment creation, not up to
      -- 24h later. It deliberately does NOT require 'v.effective_due_at IS NOT NULL' — a
      -- date-less fee is exactly the case an early QR helps most (migration 1792000003 dropped
      -- the outbox's NOT NULL for this reason). Gated on an enabled bank-sync config so teams
      -- that never connected Fio don't suddenly get a new DM family.
      -- NOTE: never use backticks in this comment — the whole query is a template literal.
      assigned_candidates AS (
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
          'assigned' AS kind
        FROM fee_assignment_status_v v
        JOIN fee_assignments fa ON fa.id = v.assignment_id
        JOIN fees f ON f.id = fa.fee_id
        JOIN team_members tm ON tm.id = fa.team_member_id AND tm.active = true
        JOIN users u ON u.id = tm.user_id
        JOIN teams t ON t.id = tm.team_id
        WHERE v.status IN ('pending', 'partial', 'overdue')
          AND fa.stored_status != 'waived'
          AND EXISTS (
            SELECT 1 FROM bank_sync_config bsc
            WHERE bsc.team_id = tm.team_id AND bsc.enabled = true
          )
          -- The club already holds enough of this member's money, in this fee's currency,
          -- to cover EVERYTHING they owe in it. Read-only: no FOR UPDATE, no lock.
          -- Deliberately absent from the lock-order table.
          --
          -- Compare against the member's TOTAL outstanding in this currency, never against
          -- this row's own gap. The predicate is evaluated per candidate row, so a row-local
          -- comparison silences every fee the credit could individually cover: 1700 of credit
          -- against two unpaid 1700 fees satisfies it on BOTH, and both go quiet permanently
          -- even though the credit can only ever pay one. The total is the only comparison
          -- that never wrongly silences.
          --
          -- Only FULL coverage suppresses: 300 of credit against 1700 outstanding is still a
          -- real debt and is still reminded.
          -- NOTE: never use backticks in this comment - the whole query is a template literal.
          AND NOT EXISTS (
            SELECT 1 FROM member_credit_accounts mca
             WHERE mca.team_member_id = fa.team_member_id
               AND mca.currency       = f.currency
               AND mca.balance_minor >= (
                 SELECT COALESCE(SUM(v2.due_minor - v2.paid_minor), 0)
                   FROM fee_assignment_status_v v2
                  WHERE v2.team_member_id = fa.team_member_id
                    AND v2.currency       = f.currency
                    AND v2.status IN ('pending', 'partial', 'overdue')
               )
          )
      ),
      all_candidates AS (
        SELECT
          assignment_id, team_id, guild_id, user_discord_id, fee_name, currency,
          amount_minor, paid_minor, effective_due_at, kind
        FROM candidates
        UNION ALL
        SELECT
          assignment_id, team_id, guild_id, user_discord_id, fee_name, currency,
          amount_minor, paid_minor, effective_due_at, kind
        FROM assigned_candidates
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
      FROM all_candidates c
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
