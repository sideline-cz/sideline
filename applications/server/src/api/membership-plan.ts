import {
  Auth,
  DisplayName,
  type MembershipPlan,
  MembershipPlanApi,
  type Team,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Layer, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import type { PlanAssignmentRow } from '~/repositories/MembershipPlansRepository.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

type MembershipPlanRowLike = {
  readonly id: MembershipPlan.MembershipPlanId;
  readonly team_id: Team.TeamId;
  readonly name: Option.Option<MembershipPlan.MembershipPlanName>;
  readonly price_minor: MembershipPlanApi.MembershipPlanInfo['priceMinor'];
  readonly currency: MembershipPlanApi.MembershipPlanInfo['currency'];
  readonly price_per_training_minor: MembershipPlanApi.MembershipPlanInfo['pricePerTrainingMinor'];
  readonly free_trainings_included: MembershipPlanApi.MembershipPlanInfo['freeTrainingsIncluded'];
  readonly expires_at: MembershipPlanApi.MembershipPlanInfo['expiresAt'];
  readonly is_default: boolean;
};

// Handlers must construct `MembershipPlanApi.MembershipPlanInfo` explicitly (never return a
// repo row directly) — `scripts/check-rpc-encoding.mjs` fails the lint otherwise, and a repo
// row type-checks fine here but dies at encode.
export const toMembershipPlanInfo = (
  row: MembershipPlanRowLike,
): MembershipPlanApi.MembershipPlanInfo =>
  new MembershipPlanApi.MembershipPlanInfo({
    membershipPlanId: row.id,
    teamId: row.team_id,
    name: row.name,
    priceMinor: row.price_minor,
    currency: row.currency,
    pricePerTrainingMinor: row.price_per_training_minor,
    freeTrainingsIncluded: row.free_trainings_included,
    expiresAt: row.expires_at,
    isDefault: row.is_default,
  });

// The explicit `new` is REQUIRED for correctness — `Schema.Class` is nominal, so a repo row
// type-checks here but dies at encode. `scripts/check-rpc-encoding.mjs` does NOT catch this one:
// it only resolves an endpoint's `success:` value, and a `Schema.Class` nested in a FIELD (here,
// `MembershipPlanListResponse.assignments`) is invisible to it. The real guard is the API
// integration test that reads `displayName` off the encoded JSON.
//
// `pickDisplayName` is the ONE display-name resolver (same call shape as `api/roster.ts`'s
// `toRosterPlayer`) — it skips blank strings, which a SQL `COALESCE` would not, which is why the
// repository returns the raw parts instead of resolving them.
const toAssignment = (row: PlanAssignmentRow): MembershipPlanApi.MembershipPlanAssignment =>
  new MembershipPlanApi.MembershipPlanAssignment({
    memberId: row.member_id,
    displayName: Option.getOrElse(
      DisplayName.pickDisplayName({
        name: row.name,
        nickname: row.discord_nickname,
        displayName: row.discord_display_name,
        username: Option.some(row.username),
      }),
      () => row.username,
    ),
    membershipPlanId: row.membership_plan_id,
  });

const forbidden = new MembershipPlanApi.Forbidden();
const notFound = new MembershipPlanApi.MembershipPlanNotFound();
const selectionClosed = new MembershipPlanApi.MembershipSelectionClosed();

export const MembershipPlanApiLive = HttpApiBuilder.group(
  Api,
  'membershipPlan',
  (handlers) =>
    Effect.Do.pipe(
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.bind('plans', () => MembershipPlansRepository.asEffect()),
      Effect.map(({ members, plans }) =>
        handlers
          // Membership-gated only — any member may read the catalogue (Slice 2 needs players to
          // list plans to choose one). `canManage` tells the caller whether they may
          // create/update/archive/set-default.
          .handle('listMembershipPlans', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.let('canManage', ({ membership }) =>
                hasPermission(membership, 'finance:manage_fees'),
              ),
              Effect.bind('list', () => plans.findMembershipPlansByTeamId(teamId)),
              // `findMemberSelection` returns `Option<row>` (`findOneOption`) — a missing row
              // (should never happen for a real member, but the query has no reason to assume
              // it can't) must flatten to `Option.none()` for both fields, not throw.
              Effect.bind('selection', ({ membership }) =>
                plans.findMemberSelection(membership.id, teamId),
              ),
              // THE PRIVACY BOUNDARY. Every member of the team hits this endpoint; only
              // Admin/Treasurer may see who is on which fee tier, so the roster is `[]` for
              // everyone else. `finance:manage_fees` and nothing weaker — `finance:view` is held
              // by every Captain AND Treasurer (`Role.ts:68,81`). This ternary is also why the
              // extra query does not run for the other 99% of callers.
              Effect.bind('assignments', ({ canManage }) =>
                canManage ? plans.findPlanAssignments(teamId) : Effect.succeed([]),
              ),
              Effect.map(({ list, canManage, selection, assignments }) =>
                Option.match(selection, {
                  // A real branch, not dead code: the member was deactivated between
                  // `requireMembership` above and this read — `findMemberSelectionQuery` filters
                  // `tm.active` (same race as the `findOneOption` note six lines up). NOT a
                  // global admin: this handler gates on `requireMembership`, which has no
                  // global-admin branch and already failed with 403. `assignments` belongs in
                  // BOTH arms — the Type side of the field is required, only the wire key is
                  // optional.
                  onNone: () =>
                    new MembershipPlanApi.MembershipPlanListResponse({
                      canManage,
                      plans: Array.map(list, toMembershipPlanInfo),
                      selectedPlanId: Option.none(),
                      selectionDeadline: Option.none(),
                      assignments: Array.map(assignments, toAssignment),
                    }),
                  onSome: (row) =>
                    new MembershipPlanApi.MembershipPlanListResponse({
                      canManage,
                      plans: Array.map(list, toMembershipPlanInfo),
                      selectedPlanId: row.membership_plan_id,
                      selectionDeadline: row.membership_selection_deadline,
                      assignments: Array.map(assignments, toAssignment),
                    }),
                }),
              ),
            ),
          )
          .handle('createMembershipPlan', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              // Deliberately `finance:manage_fees`, NOT `team:manage` — pricing is finance, and
              // `team:manage` would lock out the Treasurer, the role that exists to own money.
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('created', () =>
                plans.insertMembershipPlan({
                  team_id: teamId,
                  name: payload.name,
                  price_minor: payload.priceMinor,
                  currency: payload.currency,
                  price_per_training_minor: payload.pricePerTrainingMinor,
                  free_trainings_included: payload.freeTrainingsIncluded,
                  expires_at: payload.expiresAt,
                }),
              ),
              Effect.map(({ created }) => toMembershipPlanInfo(created)),
              Effect.catchTag('MembershipPlanNameAlreadyTakenError', () =>
                Effect.fail(new MembershipPlanApi.MembershipPlanNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed creating membership plan — no row returned'),
              ),
            ),
          )
          .handle('updateMembershipPlan', ({ params: { teamId, membershipPlanId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('existing', () =>
                plans.findMembershipPlanByIdScoped(membershipPlanId, teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(notFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('updated', () =>
                plans.updateMembershipPlan({
                  id: membershipPlanId,
                  team_id: teamId,
                  name: payload.name,
                  price_minor: payload.priceMinor,
                  currency: payload.currency,
                  price_per_training_minor: payload.pricePerTrainingMinor,
                  free_trainings_included: payload.freeTrainingsIncluded,
                  expires_at: payload.expiresAt,
                }),
              ),
              Effect.map(({ updated }) => toMembershipPlanInfo(updated)),
              Effect.catchTag('MembershipPlanNameAlreadyTakenError', () =>
                Effect.fail(new MembershipPlanApi.MembershipPlanNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed updating membership plan — no row returned'),
              ),
            ),
          )
          .handle('setDefaultMembershipPlan', ({ params: { teamId, membershipPlanId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('rowsAffected', () =>
                plans.setDefaultMembershipPlan(membershipPlanId, teamId),
              ),
              // 0 rows affected IS the tenancy + archived-plan check — `markDefaultQuery` scopes
              // by `team_id` and requires `archived_at IS NULL`, so a foreign-team id and an
              // archived id both land here. There is deliberately no separate pre-check: adding
              // one back would make it the only unscoped path to a tenancy decision again.
              Effect.flatMap(({ rowsAffected }) =>
                rowsAffected === 0 ? Effect.fail(notFound) : Effect.void,
              ),
            ),
          )
          .handle('deleteMembershipPlan', ({ params: { teamId, membershipPlanId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.tap(() =>
                plans.findMembershipPlanByIdScoped(membershipPlanId, teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(notFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('rowsAffected', () =>
                plans.archiveMembershipPlan(membershipPlanId, teamId),
              ),
              // 0 rows affected means EITHER the `NOT is_default` predicate refused (still
              // active, still default) OR a concurrent request archived it first (already gone).
              // The scoped lookup above already ruled out not-found/foreign-team at the START of
              // this request, but a second captain's request can land between that lookup and
              // this UPDATE, so it is not enough to tell the two 0-row causes apart — re-read the
              // row's CURRENT state instead of assuming which one happened.
              Effect.flatMap(
                ({
                  rowsAffected,
                }): Effect.Effect<
                  void,
                  | MembershipPlanApi.MembershipPlanNotFound
                  | MembershipPlanApi.MembershipPlanIsDefault
                > =>
                  rowsAffected === 0
                    ? plans.findMembershipPlanByIdScoped(membershipPlanId, teamId).pipe(
                        Effect.flatMap(
                          (
                            found,
                          ): Effect.Effect<
                            never,
                            | MembershipPlanApi.MembershipPlanNotFound
                            | MembershipPlanApi.MembershipPlanIsDefault
                          > =>
                            // Gone — a concurrent request already archived it. Still active —
                            // the only remaining reason the UPDATE affected 0 rows is that it is
                            // still the team's default.
                            Option.isNone(found)
                              ? Effect.fail<
                                  | MembershipPlanApi.MembershipPlanNotFound
                                  | MembershipPlanApi.MembershipPlanIsDefault
                                >(notFound)
                              : Effect.fail<
                                  | MembershipPlanApi.MembershipPlanNotFound
                                  | MembershipPlanApi.MembershipPlanIsDefault
                                >(new MembershipPlanApi.MembershipPlanIsDefault()),
                        ),
                      )
                    : Effect.void,
              ),
            ),
          )
          // Self-service — `requireMembership` ONLY, never `requirePermission` and never
          // `requireReadAccess`. Any member may pick their OWN plan; there is no member id to
          // forge because the payload never carries one — `membership.id` from
          // `requireMembership` IS the self-service handle. `requireReadAccess` is wrong here on
          // purpose: it mints a `GLOBAL_ADMIN_SENTINEL_ID` membership with no real `team_members`
          // row when the caller is a global admin who isn't a member, and writing against that
          // sentinel id would be a bug, not a permission escalation.
          .handle('selectMembershipPlan', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('rowsAffected', ({ membership }) =>
                plans.selectMembershipPlan({
                  member_id: membership.id,
                  team_id: teamId,
                  plan_id: payload.membershipPlanId,
                }),
              ),
              // 0 rows affected is the Atomic Conditional UPDATE's combined guard result (not a
              // real member / wrong team / archived-or-foreign plan / deadline passed) — re-read
              // ONCE to pick the better-fitting error message. This classification is
              // best-effort under concurrency, same stance as `deleteMembershipPlan`'s re-read
              // above: a captain changing the deadline between the UPDATE and this re-read can
              // make the response say "closed" when it was really "not found" or vice versa, but
              // it can never produce a wrong WRITE — every real guard already lives in the SQL,
              // and this read only chooses which error tag to report. `findMemberSelection` now
              // requires `tm.active` too, so a member deactivated between `requireMembership` and
              // the UPDATE reads back `None` here — report `forbidden`, not the misleading
              // "membership plan not found".
              Effect.flatMap(
                ({
                  membership,
                  rowsAffected,
                }): Effect.Effect<
                  void,
                  | MembershipPlanApi.Forbidden
                  | MembershipPlanApi.MembershipPlanNotFound
                  | MembershipPlanApi.MembershipSelectionClosed
                > =>
                  rowsAffected === 0
                    ? plans.findMemberSelection(membership.id, teamId).pipe(
                        Effect.flatMap(
                          (
                            selection,
                          ): Effect.Effect<
                            never,
                            | MembershipPlanApi.Forbidden
                            | MembershipPlanApi.MembershipPlanNotFound
                            | MembershipPlanApi.MembershipSelectionClosed
                          > =>
                            Option.match(selection, {
                              onNone: () => Effect.fail(forbidden),
                              onSome: (row) =>
                                Option.isSome(row.membership_selection_deadline) &&
                                DateTime.isLessThanOrEqualTo(
                                  row.membership_selection_deadline.value,
                                  DateTime.nowUnsafe(),
                                )
                                  ? Effect.fail(selectionClosed)
                                  : Effect.fail(notFound),
                            }),
                        ),
                      )
                    : Effect.void,
              ),
            ),
          )
          // The captain-side sibling of `selectMembershipPlan` above. `requireMembership`, NEVER
          // `requireReadAccess` — the latter mints a `GLOBAL_ADMIN_SENTINEL_ID` membership with
          // no real `team_members` row (see the comment on `selectMembershipPlan`), and this
          // handler's permission check must run against a real membership.
          //
          // No deadline check: the deadline binds members, not the treasurer (§B.2).
          .handle('assignMembershipPlan', ({ params: { teamId, memberId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('rowsAffected', () =>
                plans.assignMembershipPlan({
                  member_id: memberId,
                  team_id: teamId,
                  plan_id: payload.membershipPlanId,
                }),
              ),
              // 0 rows IS the Atomic Conditional UPDATE's combined guard result. ONE 404 covers
              // both "plan bad/archived/foreign" and "member gone/inactive/wrong team" — unlike
              // `selectMembershipPlan` there is no deadline to tell apart, both mean "reload the
              // page", and classifying would cost a query. Deliberately NO re-read.
              Effect.flatMap(({ rowsAffected }) =>
                rowsAffected === 0 ? Effect.fail(notFound) : Effect.void,
              ),
            ),
          )
          // Bulk move, same gate. Unlike the single assign above this one DOES classify its 0
          // rows, because here 0 has two causes a caller must tell apart: "nobody matched the
          // source" (a legitimate success, §B.8) and "the target is archived/foreign" (404).
          .handle('reassignMembershipPlan', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.bind('rowsAffected', () =>
                plans.reassignMembershipPlan({
                  team_id: teamId,
                  from_plan_id: payload.fromMembershipPlanId,
                  to_plan_id: payload.toMembershipPlanId,
                }),
              ),
              // The real guard stays in the SQL; this re-read only chooses the reply. A `None`
              // target has no plan to validate, so it can only ever be the no-op. Its TOCTOU (a
              // concurrent archive turning a legitimate 200/0 into a 404) is accepted — same
              // best-effort stance as `deleteMembershipPlan`: no wrong write, no leak,
              // team-scoped.
              Effect.flatMap(
                ({
                  rowsAffected,
                }): Effect.Effect<
                  MembershipPlanApi.ReassignMembershipPlanResponse,
                  MembershipPlanApi.MembershipPlanNotFound
                > =>
                  rowsAffected > 0
                    ? Effect.succeed({ movedCount: rowsAffected })
                    : Option.match(payload.toMembershipPlanId, {
                        onNone: () => Effect.succeed({ movedCount: 0 }),
                        onSome: (targetId) =>
                          plans
                            .findMembershipPlanByIdScoped(targetId, teamId)
                            .pipe(
                              Effect.flatMap((found) =>
                                Option.isNone(found)
                                  ? Effect.fail(notFound)
                                  : Effect.succeed({ movedCount: 0 }),
                              ),
                            ),
                      }),
              ),
            ),
          )
          // Deliberately `finance:manage_fees`, NOT `team:manage` — same gate as
          // create/update/archive above: pricing is finance, and `team:manage` would lock out
          // the Treasurer.
          .handle('setMembershipSelectionDeadline', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'finance:manage_fees', forbidden),
              ),
              Effect.flatMap(() => plans.setSelectionDeadline(teamId, payload.deadline)),
            ),
          ),
      ),
    ),
  // Provided internally so every pre-existing test that composes its own custom API layer
  // doesn't need a new `MembershipPlansRepository` mock just because this group exists. It is
  // ALSO listed in `AppLive.ts`'s `Repositories` (same as `EventTypesRepository`) — that second
  // listing isn't for a different consumer, it works around a real `tsc` cliff: once a second
  // "self-providing" API group's Layer needs its own repository subtracted out of its R, the
  // combined `ApiLive` type becomes too deep for the checker, which then silently widens some
  // unrelated distant expression's inferred type to `unknown` (surfaced far away, e.g. in
  // `run.ts`) instead of raising a diagnostic here. Listing the repository globally too avoids
  // that specific R-subtraction shape without changing this group's own self-containment.
).pipe(Layer.provide(MembershipPlansRepository.Default));
