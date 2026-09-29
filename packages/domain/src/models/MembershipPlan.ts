import { Schema } from 'effect';

export const MembershipPlanId = Schema.String.pipe(Schema.brand('MembershipPlanId'));
export type MembershipPlanId = typeof MembershipPlanId.Type;

export const MembershipPlanName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type MembershipPlanName = typeof MembershipPlanName.Type;

// Trainings a plan includes at no charge IN TOTAL -- an all-time allowance, consumed once and
// never reset, counted from `membership_plans.free_trainings_anchor_at` (stamped when a manager
// first sets a non-zero allowance). This is NOT a per-billing-period quota. Bounded so the charge
// engine's GREATEST(count - allowance, 0) can never be handed a number that makes the whole month
// free by accident; 999 is far above any real club's training count.
export const FreeTrainingsIncluded = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  Schema.brand('FreeTrainingsIncluded'),
);
export type FreeTrainingsIncluded = typeof FreeTrainingsIncluded.Type;
