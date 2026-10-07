import { Fee, MembershipPlan, Team, TeamMember } from '@sideline/domain';
import { Schemas, SqlErrors } from '@sideline/effect-lib';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
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
  free_trainings_included: MembershipPlan.FreeTrainingsIncluded,
  // NO `expires_at`. Expiry is a property of the team's SEASON now. The COLUMN still exists in
  // Release A (Release B drops it) and `findByTeamIdQuery` still does `SELECT *` — the excess key
  // is simply ignored on decode.
  is_default: Schema.Boolean,
}) {}

const ScopedRequest = Schema.Struct({
  id: MembershipPlan.MembershipPlanId,
  team_id: Team.TeamId,
});

class MemberSelectionRow extends Schema.Class<MemberSelectionRow>('MemberSelectionRow')({
  // `None` means "on the team's default plan" — see the migration comment.
  membership_plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
  // DELIBERATE NAME. It is kept so `rpc/membership/index.ts`'s `buildView` and
  // `api/membership-plan.ts`'s list handler compile UNCHANGED across this migration. The value is
  // the GOVERNING season's RAW `selection_deadline` — NOT `teams.membership_selection_deadline`
  // any more, and NOT a `LEAST()` of the deadline and the expiry. Do NOT "tidy" this to
  // `selection_deadline`: the rename buys nothing and costs every consumer a diff.
  //
  // Driver returns a JS `Date` here, never an ISO string — `DateTimeFromDate`, NOT
  // `DateTimeFromIsoString` (that one belongs to the API-layer schema).
  membership_selection_deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  // The SAME governing season's expiry, carried SEPARATELY and never collapsed into the deadline:
  // from one instant no consumer can tell "deadline passed" (ask a team admin) from "season
  // ended" (you keep your plan until the next season), and those need different copy.
  season_expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
}) {}

// ONE season's raw columns, as the manager's form seeds its inputs from them. `row_to_json`
// serialises `timestamptz` to a STRING, so these decode with `DateTimeFromIsoString` — unlike
// every flat column in this file, which the driver hands back as a JS `Date`.
class SeasonRow extends Schema.Class<SeasonRow>('SeasonRow')({
  starts_at: Schemas.DateTimeFromIsoString,
  selection_deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
}) {}

// Two NESTED objects rather than six loose instants: nesting is what makes "no season queued"
// (`None` on the object) distinguishable from "a queued season whose three columns are NULL".
class TeamSeasonsRow extends Schema.Class<TeamSeasonsRow>('TeamSeasonsRow')({
  current_season: Schema.OptionFromNullOr(SeasonRow),
  next_season: Schema.OptionFromNullOr(SeasonRow),
}) {}

// `findSeasonsQuery` is a bare SELECT of two scalar subqueries, so it ALWAYS returns exactly one
// row — zero rows is structurally unreachable. `findOneOption` plus this fallback is one line and
// keeps a `NoSuchElementError` out of every caller's error channel; the value is also the honest
// answer ("this team has no seasons") in the case that cannot happen.
const NO_SEASONS = new TeamSeasonsRow({
  current_season: Option.none(),
  next_season: Option.none(),
});

// The TypeScript mirror of `selection_is_open`'s `open(s)` predicate, read off the GOVERNING
// season's pair exactly as `findMemberSelection` reports it.
//
// It exists ONLY to pick which error TAG a zero-row write reports — never as a guard. Every real
// guard lives in the UPDATE's own `WHERE` (Atomic Conditional UPDATE), so this read is
// best-effort under concurrency by design: it can report the wrong tag, never cause a wrong WRITE.
//
// BOTH dates, not just the deadline. A season that ENDED with a NULL `selection_deadline` is
// reachable from the UI today — set an expiry, leave the deadline box empty — and classifying on
// the deadline alone would fall through to "that plan is not available", which is a lie.
export const selectionWindowHasClosed = (row: {
  readonly membership_selection_deadline: Option.Option<DateTime.Utc>;
  readonly season_expires_at: Option.Option<DateTime.Utc>;
}): boolean => {
  const hasPassed = (at: Option.Option<DateTime.Utc>) =>
    Option.isSome(at) && DateTime.isLessThanOrEqualTo(at.value, DateTime.nowUnsafe());
  return hasPassed(row.membership_selection_deadline) || hasPassed(row.season_expires_at);
};

// RAW name parts, never a resolved string: `DisplayName.pickDisplayName` is the one resolver and
// it lives in the API layer (`api/roster.ts`). It also skips BLANK strings, which `COALESCE`
// does not — resolving here would quietly disagree with every other display name in the app.
export class PlanAssignmentRow extends Schema.Class<PlanAssignmentRow>('PlanAssignmentRow')({
  member_id: TeamMember.TeamMemberId,
  // `None` = never picked — falls back to the team default, same as `MemberSelectionRow`.
  membership_plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
  name: Schema.OptionFromNullOr(Schema.String),
  discord_nickname: Schema.OptionFromNullOr(Schema.String),
  discord_display_name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.String,
}) {}

// `free_trainings_included` is an `Option` end to end (see `MembershipPlanApi` rule 5): `None`
// means the caller's bundle predates the field. `OptionFromNullOr` here, not `OptionFromOptional`
// -- `execute` receives the ENCODED request, and an encoded `None` must arrive as an explicit
// `null` so the SQL can `COALESCE` it.
const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  free_trainings_included: Schema.OptionFromNullOr(MembershipPlan.FreeTrainingsIncluded),
});

const UpdateInput = Schema.Struct({
  id: MembershipPlan.MembershipPlanId,
  team_id: Team.TeamId,
  name: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanName),
  price_minor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  price_per_training_minor: Fee.AmountMinor,
  free_trainings_included: Schema.OptionFromNullOr(MembershipPlan.FreeTrainingsIncluded),
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
      INSERT INTO membership_plans (team_id, name, price_minor, currency, price_per_training_minor, free_trainings_included, is_default)
      SELECT ${input.team_id}, ${input.name}, ${input.price_minor}, ${input.currency},
             ${input.price_per_training_minor}, COALESCE(${input.free_trainings_included}::int, 0),
             NOT EXISTS (
               SELECT 1 FROM membership_plans
               WHERE team_id = ${input.team_id} AND archived_at IS NULL AND is_default
             )
      RETURNING *
    `,
  });

  // `free_trainings_included = COALESCE(<param>, free_trainings_included)` is rule 5's "absent =
  // keep the stored value" (AGENTS.md → Wire-value projection & effective-value guards). It
  // COALESCEs THE PARAMETER against the column, never `EXCLUDED`. `execute` receives the ENCODED
  // request, so the field is `number | null`, not an `Option` — precedent: `setSelectionDeadlineQuery`
  // below. The `::int` cast is required: the `sql` template emits an untyped placeholder.
  //
  // The re-stamp trigger (`membership_plans_stamp_free_trainings_anchor_trg`, 1793500000) fires
  // only `WHEN (OLD.free_trainings_included = 0 AND NEW.free_trainings_included > 0)`. A `null`
  // parameter writes the stored value straight back, so OLD = NEW and the anchor is left alone —
  // an old bundle's save can never re-open the allowance.
  const updateQuery = SqlSchema.findOne({
    Request: UpdateInput,
    Result: MembershipPlanRow,
    execute: (input) => sql`
      UPDATE membership_plans SET
        name = ${input.name},
        price_minor = ${input.price_minor},
        currency = ${input.currency},
        price_per_training_minor = ${input.price_per_training_minor},
        free_trainings_included = COALESCE(${input.free_trainings_included}::int, free_trainings_included),
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
      SELECT tm.membership_plan_id,
             s.selection_deadline AS membership_selection_deadline,
             s.expires_at         AS season_expires_at
      FROM team_members tm
      LEFT JOIN seasons s ON s.id = governing_season_id(tm.team_id)
      WHERE tm.id = ${input.member_id} AND tm.team_id = ${input.team_id} AND tm.active
    `,
  });

  // The two rows the manager's FORM seeds its inputs from. Deliberately the RAW candidates and
  // NOT the governing pick: in the "current expired, next open" state `governing` is NEXT, and
  // the Current block must still render its own dates.
  //
  // These two subqueries are the SAME two candidates `governing_season_id` picks between, scanned
  // in the same two directions. If one is ever changed, change both — and note that this query is
  // why `UNIQUE (team_id, starts_at)` serves four scans and not two.
  const findSeasonsQuery = SqlSchema.findOneOption({
    Request: Team.TeamId,
    Result: TeamSeasonsRow,
    execute: (teamId) => sql`
      SELECT
        (SELECT row_to_json(c) FROM (
           SELECT s.starts_at, s.selection_deadline, s.expires_at FROM seasons s
           WHERE s.team_id = ${teamId} AND s.starts_at <= now()
           ORDER BY s.starts_at DESC LIMIT 1) c) AS current_season,
        (SELECT row_to_json(n) FROM (
           SELECT s.starts_at, s.selection_deadline, s.expires_at FROM seasons s
           WHERE s.team_id = ${teamId} AND s.starts_at > now()
           ORDER BY s.starts_at ASC LIMIT 1) n) AS next_season
    `,
  });

  // Atomic Conditional UPDATE (AGENTS.md): every guard lives in this one UPDATE's own `WHERE`,
  // never a preceding read-then-check, or a concurrent deadline change / plan archive could slip
  // past between the read and the write. `mp.team_id = tm.team_id`, NOT a bare `team_id` param —
  // the row itself is the tenancy boundary, same as `markDefaultQuery` above. `team_members` has
  // no `updated_at` column — none is set here.
  //
  // THE SELECTION GATE IS `selection_is_open(tm.team_id)`, AND NOTHING ELSE. The two-candidate
  // rule (of `current` and `next`, the first that is OPEN governs, else `current`, else `next`)
  // lives in SQL in exactly ONE place. Do NOT re-derive it in TypeScript, and do NOT read it and
  // then act on it — the gate stays inside this one UPDATE's own `WHERE`. It evaluates `open()`
  // on the very row `governing_season_id` returns, so the dates `findMemberSelectionQuery` shows
  // the member are provably the dates that gate them.
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
        AND selection_is_open(tm.team_id)
        AND EXISTS (
          SELECT 1 FROM membership_plans mp
          WHERE mp.id = ${input.plan_id} AND mp.team_id = tm.team_id AND mp.archived_at IS NULL
        )
      RETURNING tm.id
    `,
  });

  // THE CURRENT SEASON'S SLOT. "The season with the greatest `starts_at` not after now()", NOT
  // "the latest season": the moment a next season is queued those are DIFFERENT ROWS, and a box
  // seeded from one and saved into the other silently overwrites the queued season's dates behind
  // a success toast. One slot, one row, one Save — which is why this predicate must stay
  // character-identical to `findSeasonsQuery`'s `current_season` leg, the place the box was
  // seeded from.
  //
  // No `starts_at` leg: a running season's start is history, so no `23505` is reachable from this
  // endpoint and there is no unique-violation catch.
  //
  // `expires_at_present` is rule 5's "absent = KEEP THE STORED VALUE" branched in SQL, never in
  // JS. `execute` receives the ENCODED request, so the pair arrives as `boolean` + `Date | null`,
  // never as an `Option` (precedent: `assignMembershipPlanQuery` below). Both `::` casts are
  // required — the `sql` template emits untyped placeholders.
  const setCurrentSeasonQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      expires_at_present: Schema.Boolean,
      expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    }),
    execute: (input) => sql`
      UPDATE seasons SET
        selection_deadline = ${input.deadline},
        expires_at = CASE WHEN ${input.expires_at_present}::boolean
                          THEN ${input.expires_at}::timestamptz ELSE expires_at END,
        updated_at = now()
      WHERE id = (
        SELECT s.id FROM seasons s
        WHERE s.team_id = ${input.team_id} AND s.starts_at <= now()
        ORDER BY s.starts_at DESC LIMIT 1
      )
    `,
  });

  // THE NEXT SEASON'S SLOT — the other half of the pair. "The EARLIEST season starting after
  // now()", which makes this UPDATE structurally incapable of touching the running season. Same
  // character-for-character match with `findSeasonsQuery`'s `next_season` leg, for the same
  // seeded-from / written-to reason.
  //
  // A non-future `startsAt` is rejected by the API layer with a 400 BEFORE this runs — it is a
  // REQUEST validation, not a DB constraint, because the DB cannot express "future relative to
  // the request".
  const updateNextSeasonQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      starts_at: Schemas.DateTimeFromDate,
      deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    }),
    Result: Schema.Struct({ id: Schema.String }),
    execute: (input) => sql`
      UPDATE seasons SET
        starts_at = ${input.starts_at},
        selection_deadline = ${input.deadline},
        expires_at = ${input.expires_at},
        updated_at = now()
      WHERE id = (
        SELECT s.id FROM seasons s
        WHERE s.team_id = ${input.team_id} AND s.starts_at > now()
        ORDER BY s.starts_at ASC LIMIT 1
      )
      RETURNING id::text AS id
    `,
  });

  // Runs ONLY when the UPDATE above affected zero rows, i.e. the slot is empty. The slot IS the
  // identity, so "create" and "update" are one endpoint and a double-submit is a success either
  // way — that idempotence is what replaced a `SeasonAlreadyExists` 409.
  const insertNextSeasonQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      starts_at: Schemas.DateTimeFromDate,
      deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
      expires_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
    }),
    execute: (input) => sql`
      INSERT INTO seasons (team_id, starts_at, selection_deadline, expires_at)
      VALUES (${input.team_id}, ${input.starts_at}, ${input.deadline}, ${input.expires_at})
    `,
  });

  // THE SLOT LOCK, and it is load-bearing. Without it two concurrent `upsertNextSeason` calls
  // with DIFFERENT `startsAt` both find the slot empty and both INSERT — and `UNIQUE (team_id,
  // starts_at)` CANNOT fire, because the keys differ. The result is a second queued season the
  // slot can never address again: invisible to `governing_season_id` (it only ever takes the
  // EARLIEST future season) and hidden by the UI. A live row, wrong, and unreachable from every
  // surface. Three words, and it is the same team-row lock idiom `lockTeamPlansQuery` above uses.
  const lockTeamQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: Schema.Struct({ id: Team.TeamId }),
    execute: (teamId) => sql`SELECT id FROM teams WHERE id = ${teamId} FOR UPDATE`,
  });

  // THE RELEASE-A LEGACY MIRROR (§S6), shared VERBATIM by both season writers above.
  //
  // It is ONE-DIRECTIONAL: it exists so that a rollback to the previous server — which reads
  // `teams.membership_selection_deadline` and has never heard of `seasons` — still sees the
  // deadline a manager set. The two losses this knowingly accepts: the old column has no slot for
  // the EXPIRY, and it is a single value so it cannot carry PER-SEASON history. Release B deletes
  // this query and the column together.
  //
  // It writes the RAW `selection_deadline`, never a `LEAST(deadline, expiry)` — the old server's
  // column means "the deadline", and a rollback has to read it that way.
  //
  // It is a SEPARATE statement inside `sql.withTransaction`, never a trailing leg of a `WITH` on
  // the writer: a data-modifying CTE and the outer statement share ONE snapshot, so the subquery
  // would read the PRE-update value. Precedent: `setDefaultMembershipPlan` in this file.
  const mirrorLegacyDeadlineQuery = SqlSchema.void({
    Request: Team.TeamId,
    execute: (teamId) => sql`
      UPDATE teams SET membership_selection_deadline = (
        SELECT s.selection_deadline FROM seasons s WHERE s.id = governing_season_id(${teamId})
      ) WHERE id = ${teamId}
    `,
  });

  // Slice 3 — who is on which plan, for the manager-side roster. `ORDER BY tm.id` is for
  // STABILITY only: without any ORDER BY Postgres guarantees no order and the list reshuffles
  // between loads. Deliberately NOT `ORDER BY COALESCE(u.name, ...)` — `pickDisplayName` skips
  // blank strings and `COALESCE` skips only NULL, so a member with `name = ''` would sort under
  // `''` while rendering as their Discord nickname. The client filters on the RESOLVED
  // `displayName`, so the sort key and the filter key must be the same one — both live there.
  const findPlanAssignmentsQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: PlanAssignmentRow,
    execute: (teamId) => sql`
      SELECT tm.id AS member_id, tm.membership_plan_id,
             u.name, u.discord_nickname, u.discord_display_name, u.username
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${teamId} AND tm.active
      ORDER BY tm.id
    `,
  });

  // The captain-side sibling of `selectMembershipPlanQuery`. Atomic Conditional UPDATE
  // (AGENTS.md): every guard lives in this one UPDATE's own WHERE. `mp.team_id = tm.team_id` is
  // the tenancy boundary — the row itself, same as `selectMembershipPlanQuery`.
  //
  // THE DEADLINE `EXISTS` IS ABSENT ON PURPOSE (§B.2). The deadline stops MEMBERS churning after
  // the captain locks selection; fixing stragglers after that lock is the entire point of this
  // path. Do not restore it here — `selectMembershipPlanQuery` above is the one that keeps it.
  //
  // `execute` receives the ENCODED request, so `plan_id` is `string | null`, NOT an `Option` —
  // hence the plain `=== null` comparison and the direct interpolation (precedent:
  // `setSelectionDeadlineQuery` above). The `=== null` disjunct is the "clear to the team
  // default" case: there is no plan to validate, but the member guards still apply.
  // `team_members` has no `updated_at` column — none is set here.
  const assignMembershipPlanQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      member_id: TeamMember.TeamMemberId,
      team_id: Team.TeamId,
      plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
    }),
    Result: Schema.Struct({ id: TeamMember.TeamMemberId }),
    execute: (input) => sql`
      UPDATE team_members tm
      SET membership_plan_id = ${input.plan_id}
      WHERE tm.id = ${input.member_id} AND tm.team_id = ${input.team_id} AND tm.active
        AND (${input.plan_id === null} OR EXISTS (
          SELECT 1 FROM membership_plans mp
          WHERE mp.id = ${input.plan_id} AND mp.team_id = tm.team_id AND mp.archived_at IS NULL
        ))
      RETURNING tm.id
    `,
  });

  // Bulk move (§B.5): every active member on plan A lands on plan B. ONE statement, no loop, no
  // read-then-write — a client-side loop has no atomicity and leaves a half-moved team.
  //
  // `IS NOT DISTINCT FROM ${from}`, NEVER `=`: `= NULL` matches zero rows, which would make the
  // sweep of never-picked members (the `None` source) quietly report a cheerful 0.
  //
  // `IS DISTINCT FROM ${to}` is what keeps `movedCount` HONEST. Postgres counts a same-value
  // UPDATE as an affected row, so without it a source == target request reports N moved while
  // changing nothing. This guard — not a client-side check — is why no `source === target`
  // special case exists anywhere else in the stack.
  //
  // The SOURCE is deliberately unvalidated: no `archived_at`, no existence check. An archived
  // source is the POINT (its members silently fall back to the default when billed, so sweeping
  // them onto a real plan is the most valuable bulk case there is); an unmatched source yields 0
  // rows, a legitimate success (§B.8). Not a cross-tenant probe either — `tm.team_id` scopes
  // every counted row, so an arbitrary `from` uuid can only ever report this team's own members.
  //
  // The archived-TARGET `EXISTS` takes NO LOCK under READ COMMITTED: a concurrent archive
  // committing inside this statement's window can still land members on a just-archived plan.
  // That outcome is indistinguishable from "assign, then archive", which no design prevents —
  // no `FOR SHARE` (it would add a `membership_plans` lock leg no other path takes).
  //
  // Same absent deadline clause and same encoded-request interpolation as the query above.
  const reassignMembershipPlanQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      from_plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
      to_plan_id: Schema.OptionFromNullOr(MembershipPlan.MembershipPlanId),
    }),
    Result: Schema.Struct({ id: TeamMember.TeamMemberId }),
    execute: (input) => sql`
      UPDATE team_members tm
      SET membership_plan_id = ${input.to_plan_id}
      WHERE tm.team_id = ${input.team_id} AND tm.active
        AND tm.membership_plan_id IS NOT DISTINCT FROM ${input.from_plan_id}
        AND tm.membership_plan_id IS DISTINCT FROM ${input.to_plan_id}
        AND (${input.to_plan_id === null} OR EXISTS (
          SELECT 1 FROM membership_plans mp
          WHERE mp.id = ${input.to_plan_id} AND mp.team_id = tm.team_id AND mp.archived_at IS NULL
        ))
      RETURNING tm.id
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
    free_trainings_included: Option.Option<MembershipPlan.FreeTrainingsIncluded>;
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
    free_trainings_included: Option.Option<MembershipPlan.FreeTrainingsIncluded>;
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

  const findSeasons = (teamId: Team.TeamId) =>
    findSeasonsQuery(teamId).pipe(Effect.map(Option.getOrElse(() => NO_SEASONS)), catchSqlErrors);

  const selectMembershipPlan = (input: {
    member_id: TeamMember.TeamMemberId;
    team_id: Team.TeamId;
    plan_id: MembershipPlan.MembershipPlanId;
  }) =>
    selectMembershipPlanQuery(input).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  // `expiresAt` is the wire's value-AND-PRESENCE pair, kept nested all the way down: the OUTER
  // `Option` is PRESENCE (`None` = the key was absent, keep the stored value — what every old
  // bundle sends for the whole rollout window), the INNER one is the VALUE (`None` = an explicit
  // null, clear it). Defaulted to absent so existing two-argument callers keep working.
  const setSelectionDeadline = (
    teamId: Team.TeamId,
    deadline: Option.Option<DateTime.Utc>,
    expiresAt: Option.Option<Option.Option<DateTime.Utc>> = Option.none(),
  ) =>
    sql
      .withTransaction(
        setCurrentSeasonQuery({
          team_id: teamId,
          deadline,
          expires_at_present: Option.isSome(expiresAt),
          expires_at: Option.flatten(expiresAt),
        }).pipe(Effect.flatMap(() => mirrorLegacyDeadlineQuery(teamId))),
      )
      .pipe(catchSqlErrors);

  // Four statements, one transaction: lock the slot, UPDATE it, INSERT only if the UPDATE found
  // nothing, then mirror. The lock is the FIRST statement — see `lockTeamQuery` for the race it
  // closes and for the falsification procedure that proves it.
  const upsertNextSeason = (input: {
    team_id: Team.TeamId;
    starts_at: DateTime.Utc;
    deadline: Option.Option<DateTime.Utc>;
    expires_at: Option.Option<DateTime.Utc>;
  }) =>
    sql
      .withTransaction(
        lockTeamQuery(input.team_id).pipe(
          Effect.flatMap(() => updateNextSeasonQuery(input)),
          Effect.flatMap((rows) =>
            rows.length === 0 ? insertNextSeasonQuery(input) : Effect.void,
          ),
          Effect.flatMap(() => mirrorLegacyDeadlineQuery(input.team_id)),
        ),
      )
      .pipe(catchSqlErrors);

  const findPlanAssignments = (teamId: Team.TeamId) =>
    findPlanAssignmentsQuery(teamId).pipe(catchSqlErrors);

  const assignMembershipPlan = (input: {
    member_id: TeamMember.TeamMemberId;
    team_id: Team.TeamId;
    plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
  }) =>
    assignMembershipPlanQuery(input).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  const reassignMembershipPlan = (input: {
    team_id: Team.TeamId;
    from_plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
    to_plan_id: Option.Option<MembershipPlan.MembershipPlanId>;
  }) =>
    reassignMembershipPlanQuery(input).pipe(
      Effect.map((rows) => rows.length),
      catchSqlErrors,
    );

  return {
    findMembershipPlansByTeamId,
    findMembershipPlanByIdScoped,
    insertMembershipPlan,
    updateMembershipPlan,
    setDefaultMembershipPlan,
    archiveMembershipPlan,
    findMemberSelection,
    findSeasons,
    selectMembershipPlan,
    setSelectionDeadline,
    upsertNextSeason,
    findPlanAssignments,
    assignMembershipPlan,
    reassignMembershipPlan,
  };
});

export class MembershipPlansRepository extends ServiceMap.Service<
  MembershipPlansRepository,
  Effect.Success<typeof make>
>()('api/MembershipPlansRepository') {
  static readonly Default = Layer.effect(MembershipPlansRepository, make);
}
