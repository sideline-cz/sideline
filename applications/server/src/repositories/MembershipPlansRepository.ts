import { Fee, MembershipPlan, Team, TeamMember } from '@sideline/domain';
import { Schemas, SqlErrors } from '@sideline/effect-lib';
import { type DateTime, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class MembershipPlanNameAlreadyTakenError extends Schema.TaggedErrorClass<MembershipPlanNameAlreadyTakenError>()(
  'MembershipPlanNameAlreadyTakenError',
  {},
) {}

// Internal only — never leaves `setDefaultMembershipPlan`. Signals that `markDefaultQuery`
// matched no row, so the transaction must roll back rather than commit a cleared default.
class MarkDefaultNoOp extends Schema.TaggedErrorClass<MarkDefaultNoOp>()('MarkDefaultNoOp', {}) {}

class MembershipPlanRow extends Schema.Class<MembershipPlanRow>('MembershipPlanRow')({
  id: MembershipPlan.MembershipPlanId,
  team_id: Team.TeamId,
  // None = render the built-in translated label for the seeded default plan.
  name: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  // Driver returns a JS `Date` here, never an ISO string — `DateTimeFromDate`, NOT
  // `DateTimeFromIsoString` (that one belongs to the API-layer schema).
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  is_default: Schema.Boolean,
}) {}

const ScopedRequest = Schema.Struct({
  id: MembershipPlan.MembershipPlanId,
  team_id: Team.TeamId,
});

class MemberSelectionRow extends Schema.Class<MemberSelectionRow>('MemberSelectionRow')({
  // `None` means "on the team's default plan" — see the migration comment.
  membership_plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
  // Driver returns a JS `Date` here, never an ISO string — `DateTimeFromDate`, same as
  // `expires_at` above.
  membership_selection_deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
});

const UpdateInput = Schema.Struct({
  id: MembershipPlan.MembershipPlanId,
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamIdQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: MembershipPlanRow,
    execute: (teamId) => sql`
      SELECT * FROM membership_plans
      WHERE team_id = ${teamId} AND archived_at IS NULL
      ORDER BY is_default DESC, created_at ASC
    `,
  });

  const findByIdScopedQuery = SqlSchema.findOneOption({
    Request: ScopedRequest,
    Result: MembershipPlanRow,
    execute: (input) => sql`
      SELECT * FROM membership_plans
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
    `,
  });

  // Self-healing default: a team is only ever left without a default plan by a bug, never by
  // deliberate app behaviour, so the newly-inserted plan volunteers as the default the moment
  // the team's active set is caught empty-handed. `idx_membership_plans_team_default` is the
  // real enforcement point when two concurrent creates race on a defaultless team — exactly one
  // wins, and the loser's 23505 is deliberately NOT mapped to `MembershipPlanNameAlreadyTakenError`
  // below (see `catchUniqueViolationOn`'s constraint scoping).
  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: MembershipPlanRow,
    execute: (input) => sql`
      INSERT INTO membership_plans (team_id, name, price_minor, currency, price_per_training_minor, expires_at, is_default)
      SELECT ${input.team_id}, ${input.name}, ${input.price_minor}, ${input.currency},
             ${input.price_per_training_minor}, ${input.expires_at},
             NOT EXISTS (
               SELECT 1 FROM membership_plans
               WHERE team_id = ${input.team_id} AND archived_at IS NULL AND is_default
             )
      RETURNING *
    `,
  });

  const updateQuery = SqlSchema.findOne({
    Request: UpdateInput,
    Result: MembershipPlanRow,
    execute: (input) => sql`
      UPDATE membership_plans SET
        name = ${input.name},
        price_minor = ${input.price_minor},
        currency = ${input.currency},
        price_per_training_minor = ${input.price_per_training_minor},
        expires_at = ${input.expires_at},
        updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
      RETURNING *
    `,
  });

  // Locks every plan row of the plan's team for the rest of the transaction. Without it, two
  // concurrent `setDefaultMembershipPlan` calls both 23505 under READ COMMITTED — the same
  // hazard documented on `RolesRepository.setDefaultRole`.
  const lockTeamPlansQuery = SqlSchema.findAll({
    Request: MembershipPlan.MembershipPlanId,
    Result: Schema.Struct({ id: MembershipPlan.MembershipPlanId }),
    execute: (id) => sql`
      SELECT id FROM membership_plans
      WHERE team_id = (SELECT team_id FROM membership_plans WHERE id = ${id})
      FOR UPDATE
    `,
  });

  // Deliberately NOT filtered on `archived_at` — a stale `is_default` flag on an archived row
  // must be cleared too, or the team can end up with an archived row still flagged default
  // after `markDefaultQuery` below moves the live default elsewhere.
  const clearDefaultByPlanTeamQuery = SqlSchema.void({
    Request: MembershipPlan.MembershipPlanId,
    execute: (id) => sql`
      UPDATE membership_plans SET is_default = false
      WHERE team_id = (SELECT team_id FROM membership_plans WHERE id = ${id}) AND is_default = true
    `,
  });

  // THE ARCHIVED GUARD IS MANDATORY. Without `archived_at IS NULL` here, `PUT
  // /membership-plans/:archivedPlanId/default` would clear the live default (above) and mark an
  // ARCHIVED row default instead — the partial index never sees the archived row so nothing
  // raises, and the team is left with zero active defaults. `AND team_id = ` is the ONLY tenancy
  // boundary for this method — every sibling repository method scopes its own SQL by team_id,
  // and this one must too, so a caller can never rely on a pre-check elsewhere. Rows affected
  // here is how the API layer tells "the plan doesn't exist / isn't yours" apart from "it exists
  // but is archived", both of which must 404.
  const markDefaultQuery = SqlSchema.findAll({
    Request: ScopedRequest,
    Result: Schema.Struct({ id: MembershipPlan.MembershipPlanId }),
    execute: (input) => sql`
      UPDATE membership_plans SET is_default = true, updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL
      RETURNING id
    `,
  });

  // No transaction: the `NOT is_default` predicate lives in the UPDATE's own WHERE (not a
  // preceding read-then-check) so Postgres re-evaluates it against the row's latest committed
  // version. A read-then-check-then-archive would let a concurrent `setDefaultMembershipPlan`
  // interleave: TX-B reads the plan as non-default, blocks on TX-A's row lock, then applies
  // anyway once TX-A commits, leaving an archived row flagged default. Putting the predicate in
  // the UPDATE itself makes TX-B correctly refuse once TX-A's default switch has landed.
  const archiveQuery = SqlSchema.findAll({
    Request: ScopedRequest,
    Result: Schema.Struct({ id: MembershipPlan.MembershipPlanId }),
    execute: (input) => sql`
      UPDATE membership_plans SET archived_at = now(), updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND archived_at IS NULL AND NOT is_default
      RETURNING id
    `,
  });

  // Slice 2 of "Setup memberships". The RAW chosen plan id and the team's deadline — no fallback
  // resolution here, the caller (web) already has the active plan list and resolves the
  // effective (chosen-or-default) plan from it. `team_id` is a real tenancy boundary here, not a
  // redundant belt-and-braces check — every sibling method in this file scopes its own SQL by
  // team_id (see `markDefaultQuery`'s comment), so a caller can never rely on a pre-check done
  // elsewhere. `tm.active` too: a member deactivated between the caller's own membership check
  // and this read must read back as "gone", not as their last selection.
  const findMemberSelectionQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ member_id: TeamMember.TeamMemberId, team_id: Team.TeamId }),
    Result: MemberSelectionRow,
    execute: (input) => sql`
      SELECT tm.membership_plan_id, t.membership_selection_deadline
      FROM team_members tm
      JOIN teams t ON t.id = tm.team_id
      WHERE tm.id = ${input.member_id} AND tm.team_id = ${input.team_id} AND tm.active
    `,
  });

  // Atomic Conditional UPDATE (AGENTS.md): every guard lives in this one UPDATE's own `WHERE`,
  // never a preceding read-then-check, or a concurrent deadline change / plan archive could slip
  // past between the read and the write. `mp.team_id = tm.team_id`, NOT a bare `team_id` param —
  // the row itself is the tenancy boundary, same as `markDefaultQuery` above. `NULL >
  // now()` is NULL (neither true nor false), hence the explicit `IS NULL` disjunct for "always
  // open". `team_members` has no `updated_at` column — none is set here.
  const selectMembershipPlanQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      member_id: TeamMember.TeamMemberId,
      team_id: Team.TeamId,
      plan_id: MembershipPlan.MembershipPlanId,
    }),
    Result: Schema.Struct({ id: TeamMember.TeamMemberId }),
    execute: (input) => sql`
      UPDATE team_members tm
      SET membership_plan_id = ${input.plan_id}
      WHERE tm.id = ${input.member_id} AND tm.team_id = ${input.team_id} AND tm.active
        AND EXISTS (
          SELECT 1 FROM teams t
          WHERE t.id = tm.team_id
            AND (t.membership_selection_deadline IS NULL OR t.membership_selection_deadline > now())
        )
        AND EXISTS (
          SELECT 1 FROM membership_plans mp
          WHERE mp.id = ${input.plan_id} AND mp.team_id = tm.team_id AND mp.archived_at IS NULL
        )
      RETURNING tm.id
    `,
  });

  // Plain UPDATE, no upsert — a `teams` row always exists, unlike `team_settings` (see the
  // migration comment for why the deadline lives here and not there).
  const setSelectionDeadlineQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    }),
    execute: (input) => sql`
      UPDATE teams SET membership_selection_deadline = ${input.deadline} WHERE id = ${input.team_id}
    `,
  });

  const findMembershipPlansByTeamId = (teamId: Team.TeamId) =>
    findByTeamIdQuery(teamId).pipe(catchSqlErrors);

  const findMembershipPlanByIdScoped = (id: MembershipPlan.MembershipPlanId, teamId: Team.TeamId) =>
    findByIdScopedQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const insertMembershipPlan = (input: {
    team_id: Team.TeamId;
    name: Option.Option<MembershipPlan.MembershipPlanName>;
    price_minor: Fee.AmountMinor;
    currency: Fee.CurrencyCode;
    price_per_training_minor: Fee.AmountMinor;
    expires_at: Option.Option<DateTime.Utc>;
  }) =>
    insertQuery(input).pipe(
      SqlErrors.catchUniqueViolationOn(
        'idx_membership_plans_team_name',
        () => new MembershipPlanNameAlreadyTakenError(),
      ),
      catchSqlErrors,
    );

  const updateMembershipPlan = (input: {
    id: MembershipPlan.MembershipPlanId;
    team_id: Team.TeamId;
    name: Option.Option<MembershipPlan.MembershipPlanName>;
    price_minor: Fee.AmountMinor;
    currency: Fee.CurrencyCode;
    price_per_training_minor: Fee.AmountMinor;
    expires_at: Option.Option<DateTime.Utc>;
  }) =>
    updateQuery(input).pipe(
      SqlErrors.catchUniqueViolationOn(
        'idx_membership_plans_team_name',
        () => new MembershipPlanNameAlreadyTakenError(),
      ),
      catchSqlErrors,
    );

  // Two UPDATEs, not one `SET is_default = (id = ${id})`: a single multi-row UPDATE transiently
  // holds two `is_default` rows for the team and trips `idx_membership_plans_team_default`.
  // Returns the number of rows the final `mark` UPDATE affected, so the caller can 404 when it
  // is 0 (the archived-plan case, OR a foreign-team plan id — see `markDefaultQuery` above).
  const setDefaultMembershipPlan = (id: MembershipPlan.MembershipPlanId, teamId: Team.TeamId) =>
    sql
      .withTransaction(
        lockTeamPlansQuery(id).pipe(
          Effect.flatMap(() => clearDefaultByPlanTeamQuery(id)),
          Effect.flatMap(() => markDefaultQuery({ id, team_id: teamId })),
          // Returning 0 here would COMMIT the clear above with nothing to replace it, leaving
          // the team with zero active defaults — and a team whose last active plan is not the
          // default is a team whose last plan can be archived. Fail so `withTransaction` rolls
          // the clear back; the catch below restores the 0 the API layer reads as "archived".
          Effect.flatMap((rows) =>
            rows.length === 0 ? Effect.fail(new MarkDefaultNoOp()) : Effect.succeed(rows.length),
          ),
        ),
      )
      .pipe(
        Effect.catchTag('MarkDefaultNoOp', () => Effect.succeed(0)),
        catchSqlErrors,
      );

  const archiveMembershipPlan = (id: MembershipPlan.MembershipPlanId, teamId: Team.TeamId) =>
    archiveQuery({ id, team_id: teamId }).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  const findMemberSelection = (memberId: TeamMember.TeamMemberId, teamId: Team.TeamId) =>
    findMemberSelectionQuery({ member_id: memberId, team_id: teamId }).pipe(catchSqlErrors);

  const selectMembershipPlan = (input: {
    member_id: TeamMember.TeamMemberId;
    team_id: Team.TeamId;
    plan_id: MembershipPlan.MembershipPlanId;
  }) =>
    selectMembershipPlanQuery(input).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  const setSelectionDeadline = (teamId: Team.TeamId, deadline: Option.Option<DateTime.Utc>) =>
    setSelectionDeadlineQuery({ team_id: teamId, deadline }).pipe(catchSqlErrors);

  return {
    findMembershipPlansByTeamId,
    findMembershipPlanByIdScoped,
    insertMembershipPlan,
    updateMembershipPlan,
    setDefaultMembershipPlan,
    archiveMembershipPlan,
    findMemberSelection,
    selectMembershipPlan,
    setSelectionDeadline,
  };
});

export class MembershipPlansRepository extends ServiceMap.Service<
  MembershipPlansRepository,
  Effect.Success<typeof make>
>()('api/MembershipPlansRepository') {
  static readonly Default = Layer.effect(MembershipPlansRepository, make);
}
