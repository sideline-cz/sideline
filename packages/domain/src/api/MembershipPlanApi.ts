import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import * as Fee from '~/models/Fee.js';
import { MembershipPlanId, MembershipPlanName } from '~/models/MembershipPlan.js';
import { TeamId } from '~/models/Team.js';

export class MembershipPlanInfo extends Schema.Class<MembershipPlanInfo>('MembershipPlanInfo')({
  membershipPlanId: MembershipPlanId,
  teamId: TeamId,
  // None = render the built-in translated label for the seeded default plan.
  name: Schema.OptionFromNullOr(MembershipPlanName),
  priceMinor: Fee.AmountMinor,
  currency: Fee.CurrencyCode,
  pricePerTrainingMinor: Fee.AmountMinor,
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  isDefault: Schema.Boolean,
}) {}

export class MembershipPlanListResponse extends Schema.Class<MembershipPlanListResponse>(
  'MembershipPlanListResponse',
)({
  canManage: Schema.Boolean,
  plans: Schema.Array(MembershipPlanInfo),
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
  expiresAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
});
export type MembershipPlanRequest = Schema.Schema.Type<typeof MembershipPlanRequest>;

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
  ) {}
