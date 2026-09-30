import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as Fee from '~/models/Fee.js';
import {
  FreeTrainingsIncluded,
  MembershipPlanId,
  MembershipPlanName,
} from '~/models/MembershipPlan.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class MembershipPlanInfo extends Schema.Class<MembershipPlanInfo>('MembershipPlanInfo')({
  membershipPlanId: MembershipPlanId,
  teamId: TeamId,
  // None = render the built-in translated label for the seeded default plan.
  name: Schema.OptionFromNullOr(MembershipPlanName),
  priceMinor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  pricePerTrainingMinor: Fee.AmountMinor,
  // Trainings included at no charge IN TOTAL: an all-time allowance consumed once, counted from
  // `membership_plans.free_trainings_anchor_at`, never reset per billing period. Tolerant decode
  // so an old web bundle and the e2e fixture, both of which predate this field, still decode --
  // on this READ side 0 (no allowance) is the safe direction.
  freeTrainingsIncluded: FreeTrainingsIncluded.pipe(Schema.withDecodingDefaultKey(() => 0)),
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  isDefault: Schema.Boolean,
}) {}

export class MembershipPlanAssignment extends Schema.Class<MembershipPlanAssignment>(
  'MembershipPlanAssignment',
)({
  memberId: TeamMemberId,
  displayName: Schema.String,
  // `None` = never picked — the member falls back to the team default. Same raw-not-resolved
  // stance as `selectedPlanId` below: the caller already holds `plans` and resolves the
  // effective plan from it.
  membershipPlanId: Schema.OptionFromNullOr(MembershipPlanId),
}) {}

export class MembershipPlanListResponse extends Schema.Class<MembershipPlanListResponse>(
  'MembershipPlanListResponse',
)({
  canManage: Schema.Boolean,
  plans: Schema.Array(MembershipPlanInfo),
  // The RAW plan the caller chose — `None` means "never picked one", NOT "on the default
  // plan". This is deliberately not resolved server-side: the web already has the active plan
  // list right here and resolves the effective (chosen-or-default) plan from it. Tolerant
  // decode (missing key or null -> none) so an old web bundle and the e2e fixture (both of
  // which predate this field) still decode. The Type side is a required `Option` — the single
  // construction site (the handler) must pass it explicitly; only the encoded wire key is
  // optional.
  selectedPlanId: Schema.OptionFromOptionalNullOr(MembershipPlanId, { onNoneEncoding: null }),
  // `None` = selection is always open. Same tolerant-decode reasoning as `selectedPlanId`.
  selectionDeadline: Schema.OptionFromOptionalNullOr(Schemas.DateTimeFromIsoString, {
    onNoneEncoding: null,
  }),
  // Who is on which plan — privileged data, so it is EMPTY unless `canManage`. The `[]`
  // decoding default is load-bearing in both directions: the e2e fixture omits the key, and a
  // server rollback must still decode. `[]` is also the only safe default — a peer that does
  // not know about this field must render NO roster, never a phantom one.
  assignments: Schema.Array(MembershipPlanAssignment).pipe(Schema.withDecodingDefaultKey(() => [])),
}) {}

// Payloads are Schema.Struct, never Schema.Class — a Schema.Class payload fails client-side
// encode with a generic toast and an empty Network tab (commit d72fa1be).
//
// One shared struct for create AND update, full-replace semantics. `currency` IS included --
// the web edit form must seed it from the row, or a full-replace update silently rewrites an
// EUR plan to CZK. `name` is null/None = keep rendering the built-in translated label; a
// non-empty string = the captain's own name. This mirrors MembershipPlanInfo.name -- an update
// must be able to leave the seeded default plan's NULL name alone (or restore it), not just set
// one, or the first captain to open the default plan's edit form freezes their own locale's
// translated label into the column forever.
export const MembershipPlanRequest = Schema.Struct({
  name: Schema.OptionFromNullOr(MembershipPlanName),
  priceMinor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  pricePerTrainingMinor: Fee.AmountMinor,
  // The all-time allowance, counted from `membership_plans.free_trainings_anchor_at` -- included
  // once for the life of the membership, not per billing period. OPTIONAL KEY, absent = KEEP THE
  // STORED VALUE (`applications/server/AGENTS.md` rule 5): web deploys LAST, so a new server
  // serves old bundles that omit this key for the whole rollout -- a required field 400s every
  // one of their saves. Absent must NOT mean 0 either, or a full-row overwrite from such a bundle
  // silently zeroes the allowance. The repository implements "keep" by COALESCEing THE PARAMETER
  // against the column; on CREATE there is no stored value, so absent COALESCEs to 0.
  // Deliberately asymmetric with `MembershipPlanInfo.freeTrainingsIncluded`, which keeps a
  // `withDecodingDefaultKey(() => 0)` -- on the READ side 0 is the safe direction.
  freeTrainingsIncluded: Schema.OptionFromOptional(FreeTrainingsIncluded),
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
});
export type MembershipPlanRequest = Schema.Schema.Type<typeof MembershipPlanRequest>;

// Slice 2 of "Setup memberships": a member picks which plan they're on. Struct, never Class —
// same reasoning as `MembershipPlanRequest` above.
export const SelectMembershipPlanRequest = Schema.Struct({
  membershipPlanId: MembershipPlanId,
});
export type SelectMembershipPlanRequest = Schema.Schema.Type<typeof SelectMembershipPlanRequest>;

// `None` clears the deadline (selection stays open indefinitely).
export const SetSelectionDeadlineRequest = Schema.Struct({
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
});
export type SetSelectionDeadlineRequest = Schema.Schema.Type<typeof SetSelectionDeadlineRequest>;

// Captain-side counterpart of `SelectMembershipPlanRequest`. `None` clears the assignment (the
// member falls back to the team default) — hence `OptionFromNullOr` and not
// `OptionFromOptional`: `null` is an explicit "clear it", never "don't touch".
export const AssignMembershipPlanRequest = Schema.Struct({
  membershipPlanId: Schema.OptionFromNullOr(MembershipPlanId),
});
export type AssignMembershipPlanRequest = Schema.Schema.Type<typeof AssignMembershipPlanRequest>;

// Bulk move: every member on plan A lands on plan B. `from` `None` = the members who never
// picked (matched with `IS NOT DISTINCT FROM`, so NULLs actually match) — a DIFFERENT set from
// the default plan's own id, which is a real plan with a real id. `to` `None` = clear to the
// team default, symmetric with `AssignMembershipPlanRequest`.
export const ReassignMembershipPlanRequest = Schema.Struct({
  fromMembershipPlanId: Schema.OptionFromNullOr(MembershipPlanId),
  toMembershipPlanId: Schema.OptionFromNullOr(MembershipPlanId),
});
export type ReassignMembershipPlanRequest = Schema.Schema.Type<
  typeof ReassignMembershipPlanRequest
>;

// 200 with a count, not 204: the dialog's own count is advisory (a concurrent single assign can
// change the set), so the UI toasts the number the server actually moved. `movedCount: 0` is a
// success — a no-op sweep is legitimate; the 404 is reserved for an invalid TARGET.
export const ReassignMembershipPlanResponse = Schema.Struct({
  movedCount: Schema.Int,
});
export type ReassignMembershipPlanResponse = Schema.Schema.Type<
  typeof ReassignMembershipPlanResponse
>;

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  'MembershipPlanForbidden',
  {},
) {}

export class MembershipPlanNotFound extends Schema.TaggedErrorClass<MembershipPlanNotFound>()(
  'MembershipPlanNotFound',
  {},
) {}

export class MembershipPlanNameAlreadyTaken extends Schema.TaggedErrorClass<MembershipPlanNameAlreadyTaken>()(
  'MembershipPlanNameAlreadyTaken',
  {},
) {}

// The plan is the team's default -- a captain must promote another plan first.
export class MembershipPlanIsDefault extends Schema.TaggedErrorClass<MembershipPlanIsDefault>()(
  'MembershipPlanIsDefault',
  {},
) {}

// The team's `membership_selection_deadline` has passed — the member's own SELECT/PUT is
// rejected. It is raised by `selectMembershipPlan` ONLY: the deadline binds members, not
// managers, so `assignMembershipPlan` / `reassignMembershipPlan` deliberately do not list it.
export class MembershipSelectionClosed extends Schema.TaggedErrorClass<MembershipSelectionClosed>()(
  'MembershipSelectionClosed',
  {},
) {}

export class MembershipPlanApiGroup extends HttpApiGroup.make('membershipPlan')
  .add(
    HttpApiEndpoint.get('listMembershipPlans', '/teams/:teamId/membership-plans', {
      success: MembershipPlanListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createMembershipPlan', '/teams/:teamId/membership-plans', {
      success: MembershipPlanInfo.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        MembershipPlanNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: MembershipPlanRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch(
      'updateMembershipPlan',
      '/teams/:teamId/membership-plans/:membershipPlanId',
      {
        success: MembershipPlanInfo,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
          MembershipPlanNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
        ],
        payload: MembershipPlanRequest,
        params: { teamId: TeamId, membershipPlanId: MembershipPlanId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put(
      'setDefaultMembershipPlan',
      '/teams/:teamId/membership-plans/:membershipPlanId/default',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, membershipPlanId: MembershipPlanId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    // Archives, never hard-deletes — see AGENTS.md ownership statement.
    HttpApiEndpoint.delete(
      'deleteMembershipPlan',
      '/teams/:teamId/membership-plans/:membershipPlanId',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
          MembershipPlanIsDefault.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, membershipPlanId: MembershipPlanId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    // Self-service — mirrors `PATCH /teams/:teamId/me/event-preferences` (`TeamApi.ts`). No
    // member id in the path or payload: `requireMembership`'s own membership row is the handle.
    HttpApiEndpoint.put('selectMembershipPlan', '/teams/:teamId/me/membership-plan', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
        MembershipSelectionClosed.pipe(HttpApiSchema.status(409)),
      ],
      payload: SelectMembershipPlanRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // NOT nested under `/membership-plans/...` — that collides with the `:membershipPlanId`
    // path segment above.
    HttpApiEndpoint.put(
      'setMembershipSelectionDeadline',
      '/teams/:teamId/membership-selection-deadline',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: Forbidden.pipe(HttpApiSchema.status(403)),
        payload: SetSelectionDeadlineRequest,
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    // The captain-side sibling of `selectMembershipPlan`. Deliberately NO
    // `MembershipSelectionClosed` — the deadline binds members, not the treasurer; fixing
    // stragglers AFTER the lock is the entire point of this screen.
    //
    // ponytail: a single 404 covers both "plan bad/archived/foreign" and "member
    // gone/inactive/wrong team". There is no deadline to tell them apart, both mean "reload the
    // page", and classifying costs a query. Split with a `findMemberSelection` re-read if the UI
    // ever needs distinct copy.
    HttpApiEndpoint.put(
      'assignMembershipPlan',
      '/teams/:teamId/members/:memberId/membership-plan',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
        ],
        payload: AssignMembershipPlanRequest,
        params: { teamId: TeamId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    // FLAT path, deliberately NOT under `/membership-plans/...` — same dodge as
    // `setMembershipSelectionDeadline` above, which was flattened to avoid the
    // `:membershipPlanId` param segment. Both plan ids live in the payload, where either may be
    // `None`, which a path segment cannot express anyway.
    //
    // Same deliberate omission of `MembershipSelectionClosed` as `assignMembershipPlan`.
    HttpApiEndpoint.post('reassignMembershipPlan', '/teams/:teamId/membership-plan-reassign', {
      success: ReassignMembershipPlanResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        MembershipPlanNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: ReassignMembershipPlanRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
