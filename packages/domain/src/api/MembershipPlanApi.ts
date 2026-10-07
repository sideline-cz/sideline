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
  // Trainings included at no charge PER SEASON, reset at every rollover and counted from the
  // starts_at of the season in effect for the billing period -- see `FreeTrainingsIncluded` for
  // why that reverses half of PR #746. Tolerant decode so an old web bundle and the e2e fixture,
  // both of which predate this field, still decode -- on this READ side 0 (no allowance) is the
  // safe direction.
  freeTrainingsIncluded: FreeTrainingsIncluded.pipe(Schema.withDecodingDefaultKey(() => 0)),
  // DEAD FIELD, kept for one release. Expiry is now a property of the TEAM'S SEASON, never of a
  // plan; the handler hardcodes `Option.none()` and the column is no longer written or read.
  // DELIBERATELY NOT made tolerant: `OptionFromNullOr` already ENCODES `None` as a PRESENT key
  // whose value is `null`, which is exactly what an already-loaded bundle's frozen required-key
  // copy needs. `OptionFromOptionalNullOr` would only add tolerance for an ABSENT key, and no
  // producer in this release emits one -- the change would buy nothing and cost a schema edit.
  // Release B deletes this field and `membership_plans.expires_at` together.
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

// The RAW column values of ONE season. Every field is the column itself, never a derivation --
// these objects exist to SEED FORM INPUTS, and an input seeded from a derived value that it then
// writes back is the data-loss loop this shape exists to make unreachable.
export class SeasonInfo extends Schema.Class<SeasonInfo>('SeasonInfo')({
  startsAt: Schemas.DateTimeFromIsoString,
  // `None` = selection never closes on a deadline for this season.
  selectionDeadline: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  // `None` = the season never ends on its own. Carried SEPARATELY from the deadline, never
  // collapsed into a LEAST() -- a consumer that sees one instant cannot tell "deadline passed"
  // from "season ended", and those need different copy and different next actions.
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
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
  // SEEDING. `currentSeason` feeds the Current block's inputs and is written back by
  // PUT /membership-selection-deadline; `nextSeason` feeds the Next block and is written back by
  // PUT /seasons/next. One block, one row, one Save -- that pairing is what stops a Save landing
  // on a row the box was not seeded from. `None` on `nextSeason` = no season is queued, which is
  // the state the Next block's "start a new season" affordance exists for; `None` on
  // `currentSeason` means every season this team has is still in the future.
  //
  // Tolerant + { onNoneEncoding: null }, and HERE the tolerance is load-bearing in BOTH
  // directions (unlike `MembershipPlanInfo.expiresAt` above): an already-loaded bundle has never
  // heard of these keys and must not fail decoding on them, AND a new bundle must survive a
  // SERVER ROLLBACK that stops emitting them.
  currentSeason: Schema.OptionFromOptionalNullOr(SeasonInfo, { onNoneEncoding: null }),
  nextSeason: Schema.OptionFromOptionalNullOr(SeasonInfo, { onNoneEncoding: null }),
  // DISPLAY ONLY -- the GOVERNING season's deadline/expiry pair, picked server-side by
  // `governing_season_id` (the first OPEN of current/next, else current, else next). `None` =
  // selection is always open.
  //
  // NEVER SEEDED INTO AN INPUT AND NEVER WRITTEN BACK. That is what makes the reseed-and-save
  // hazard UNREACHABLE rather than merely avoided: there is no code path from this pair to any
  // request body. The two season objects above are for the manager's FORM; this pair is for the
  // member's NOTICE.
  //
  // Server-derived, not computed in the web from the two objects above: the two-candidate pick
  // must live in exactly ONE place (SQL). Re-deriving it in TypeScript runs it against the
  // BROWSER clock, which is the drift this whole shape exists to prevent.
  //
  // `selectionDeadline` keeps its name and schema -- an already-loaded bundle still renders it --
  // but its meaning moved from `teams.membership_selection_deadline` to the governing season's
  // raw `selection_deadline`. Release B deletes it once no frozen bundle reads it.
  selectionDeadline: Schema.OptionFromOptionalNullOr(Schemas.DateTimeFromIsoString, {
    onNoneEncoding: null,
  }),
  // The SAME governing season's expiry. Separate from the deadline so every consumer can tell
  // "deadline passed" (ask a team admin) from "season ended" (you keep your plan until the next
  // season starts). Tolerant for the same two-directional reason as the season objects.
  seasonExpiresAt: Schema.OptionFromOptionalNullOr(Schemas.DateTimeFromIsoString, {
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
  // The PER-SEASON allowance, counted from the starts_at of the season in effect for the billing
  // period and reset at every rollover -- not per billing period, and no longer all-time (see
  // `FreeTrainingsIncluded` on PR #746). OPTIONAL KEY, absent = KEEP THE
  // STORED VALUE (`applications/server/AGENTS.md` rule 5): web deploys LAST, so a new server
  // serves old bundles that omit this key for the whole rollout -- a required field 400s every
  // one of their saves. Absent must NOT mean 0 either, or a full-row overwrite from such a bundle
  // silently zeroes the allowance. The repository implements "keep" by COALESCEing THE PARAMETER
  // against the column; on CREATE there is no stored value, so absent COALESCEs to 0.
  // Deliberately asymmetric with `MembershipPlanInfo.freeTrainingsIncluded`, which keeps a
  // `withDecodingDefaultKey(() => 0)` -- on the READ side 0 is the safe direction.
  freeTrainingsIncluded: Schema.OptionFromOptional(FreeTrainingsIncluded),
  // No `expiresAt` -- expiry is a property of the team's SEASON now, set via
  // PUT /membership-selection-deadline (current) or PUT /seasons/next. Removing the key outright
  // is safe in the same release the web still sends it: `onExcessProperty` defaults to `"ignore"`
  // and nothing in this repo overrides it, so an already-loaded bundle's save carries a key the
  // server silently drops rather than 400s on.
});
export type MembershipPlanRequest = Schema.Schema.Type<typeof MembershipPlanRequest>;

// Slice 2 of "Setup memberships": a member picks which plan they're on. Struct, never Class —
// same reasoning as `MembershipPlanRequest` above.
export const SelectMembershipPlanRequest = Schema.Struct({
  membershipPlanId: MembershipPlanId,
});
export type SelectMembershipPlanRequest = Schema.Schema.Type<typeof SelectMembershipPlanRequest>;

// Writes the team's CURRENT season -- the one with the greatest `starts_at` not after now(). Not
// "the latest season": once a next season is queued those are different rows, and a box seeded
// from one and saved into the other silently overwrites the queued season's dates.
//
// There is deliberately NO `startsAt` here. A running season's start is history, and a date box
// that could move it would fire the fee recompute and re-price the open month with no
// confirmation. Start dates are editable on the NEXT slot only.
export const SetSelectionDeadlineRequest = Schema.Struct({
  // `None` clears the deadline (selection stays open indefinitely). UNCHANGED shape, so an
  // already-loaded bundle keeps working -- and against the CURRENT-season target its "this is the
  // team's deadline" mental model is exactly right.
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  // OPTIONAL KEY, absent = KEEP THE STORED VALUE (`applications/server/AGENTS.md` rule 5): web
  // deploys LAST, so old bundles omit it for the whole rollout window and a required key would
  // 400 every one of their saves. The inner `OptionFromNullOr` is what lets a NEW bundle send an
  // explicit `null` to CLEAR the expiry -- absent and null must not mean the same thing here.
  expiresAt: Schema.OptionFromOptional(Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString)),
  // OPTIMISTIC CONCURRENCY ON THE ROW'S IDENTITY, and the only thing that answers "which row was
  // this form SEEDED from". The slot keys answer "which endpoint owns which slot"; they resolve
  // the target at SAVE time, from `now()`. A manager who leaves the tab open across a season
  // rollover would otherwise write the Current block's values -- seeded at LOAD time from season
  // A -- into season B, destroying B's deadline and expiry behind a success toast (or 500ing on
  // `CHECK (expires_at > starts_at)`). The caller sends the `startsAt` of the very `currentSeason`
  // object the box was seeded from; a mismatch is a 409, never a silent success.
  //
  // `OptionFromOptional`, i.e. an OPTIONAL KEY, and that is LOAD-BEARING (`applications/server/
  // AGENTS.md` rule 5): deploy order is bot -> server -> web, so a new server serves FROZEN old
  // bundles for the entire rollout window and those bundles will never send this key. ABSENT MUST
  // MEAN "NO OPTIMISTIC CHECK" -- exactly today's behaviour -- and must NEVER 400. A required
  // field, or a required field with a client-side default, breaks every one of their saves.
  //
  // No inner `OptionFromNullOr` (unlike `expiresAt` above): there is nothing to CLEAR here, so an
  // explicit `null` would have no meaning distinct from absent. Only the key's presence matters.
  currentSeasonStartsAt: Schema.OptionFromOptional(Schemas.DateTimeFromIsoString),
});
export type SetSelectionDeadlineRequest = Schema.Schema.Type<typeof SetSelectionDeadlineRequest>;

// Writes the team's NEXT season -- the earliest one starting after now(). PUT, not POST, because
// the SLOT is the identity: a double-submit rewrites the same row with the same values and still
// returns 204. That idempotence is why there is no create endpoint, no `SeasonAlreadyExists` and
// no 409 -- a create has to tell "already exists" apart from success; a slot does not.
//
// `startsAt` is required and must be in the future (`SeasonStartNotInFuture`), which is what makes
// this request STRUCTURALLY incapable of addressing the running season's row.
export const UpsertNextSeasonRequest = Schema.Struct({
  startsAt: Schemas.DateTimeFromIsoString,
  // Both `None` = this season has no deadline / never ends on its own. `OptionFromNullOr`, not
  // `OptionFromOptional`: this endpoint is new, so there is no old bundle to be tolerant of, and
  // every Save sends the whole block -- a missing key would be a bug, not a rollout artefact.
  deadline: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
});
export type UpsertNextSeasonRequest = Schema.Schema.Type<typeof UpsertNextSeasonRequest>;

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

// `upsertNextSeason` was handed a `startsAt` at or before now(). 400, not 409: the slot is "the
// earliest FUTURE season", so a non-future start does not collide with anything — it simply fails
// to name the slot. It fires on a value the form's own `min` attribute should already have
// rejected, which is why this replaced a 409 that fired on a SUCCESSFUL action.
export class SeasonStartNotInFuture extends Schema.TaggedErrorClass<SeasonStartNotInFuture>()(
  'SeasonStartNotInFuture',
  {},
) {}

// The Current block was seeded from one season and Saved while a DIFFERENT one had become
// current — a rollover happened under an open tab. 409, not 400 or a silent 204: the request is
// well-formed and the caller did nothing wrong, the row they addressed simply is not the current
// one any more. The web's only correct response is "your page is stale" + a refetch; writing the
// values anywhere would destroy the newly-current season's dates.
//
// Only reachable when the caller SENDS `currentSeasonStartsAt`. A frozen old bundle omits it and
// gets exactly today's behaviour.
export class CurrentSeasonChanged extends Schema.TaggedErrorClass<CurrentSeasonChanged>()(
  'CurrentSeasonChanged',
  {},
) {}

// The GOVERNING season's window is shut — the member's own SELECT/PUT is rejected. "Governing" is
// the two-candidate rule and nothing else: of `current` (greatest starts_at <= now()) and `next`
// (the EARLIEST starts_at > now()), the first that is OPEN governs, else `current`, else `next`.
// Do not reintroduce either of the two rules this replaced — "the season in effect governs" made
// picking for a future season impossible, and "ANY season with an open window" let one finished
// season with a NULL deadline hold selection open forever.
//
// Raised by `selectMembershipPlan` ONLY: the window binds members, not managers, so
// `assignMembershipPlan` / `reassignMembershipPlan` deliberately do not list it.
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
    //
    // Owns the CURRENT season's slot. The path keeps its old name even though it now writes an
    // expiry too: renaming it would strand every already-loaded bundle for the whole rollout
    // window, and the name is still accurate about the key that matters to those bundles.
    HttpApiEndpoint.put(
      'setMembershipSelectionDeadline',
      '/teams/:teamId/membership-selection-deadline',
      {
        success: Schema.Void.pipe(HttpApiSchema.status(204)),
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          CurrentSeasonChanged.pipe(HttpApiSchema.status(409)),
        ],
        payload: SetSelectionDeadlineRequest,
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    // Owns the NEXT season's slot — the other half of the pair above. Two slot-keyed PUTs and no
    // POST: with a single PUT aimed at "the latest season", queueing a next season made the
    // current one's dates unwritable from any endpoint. One slot, one row, one Save.
    //
    // No `GET`, no list, no delete: the list response already carries both seasons, and nothing
    // in this release deletes one.
    HttpApiEndpoint.put('upsertNextSeason', '/teams/:teamId/seasons/next', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        SeasonStartNotInFuture.pipe(HttpApiSchema.status(400)),
      ],
      payload: UpsertNextSeasonRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
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
