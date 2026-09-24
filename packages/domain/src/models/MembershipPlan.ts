import { Schema } from 'effect';

export const MembershipPlanId = Schema.String.pipe(Schema.brand('MembershipPlanId'));
export type MembershipPlanId = typeof MembershipPlanId.Type;

export const MembershipPlanName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type MembershipPlanName = typeof MembershipPlanName.Type;
