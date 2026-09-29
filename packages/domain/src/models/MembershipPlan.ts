import { Schema } from 'effect';

export const MembershipPlanId = Schema.String.pipe(Schema.brand('MembershipPlanId'));
export type MembershipPlanId = typeof MembershipPlanId.Type;

export const MembershipPlanName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type MembershipPlanName = typeof MembershipPlanName.Type;

// Trainings a plan includes at no charge, per billing period. Bounded so the charge engine's
// GREATEST(count - allowance, 0) can never be handed a number that makes the whole month free
// by accident; 999 is far above any real club's monthly training count.
export const FreeTrainingsPerPeriod = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  Schema.brand('FreeTrainingsPerPeriod'),
);
export type FreeTrainingsPerPeriod = typeof FreeTrainingsPerPeriod.Type;
