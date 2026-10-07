import { Schema } from 'effect';

export const MembershipPlanId = Schema.String.pipe(Schema.brand('MembershipPlanId'));
export type MembershipPlanId = typeof MembershipPlanId.Type;

export const MembershipPlanName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type MembershipPlanName = typeof MembershipPlanName.Type;

// Trainings a plan includes at no charge PER SEASON -- the allowance resets at every season
// rollover, counted from the `starts_at` of the season in effect FOR THE BILLING PERIOD. That is
// the season-in-effect rule (period-aligned), NOT the selection-gate rule, which picks between two
// candidates and would mis-bill. Still NOT a per-billing-period quota: one allowance spans every
// month of a season.
//
// This REVERSES the "all-time, never reset" half of PR #746, deliberately -- a product decision,
// not a regression. #746 was correct against the requirement it was given, and the column it
// anchored on (`membership_plans.free_trainings_anchor_at`) is dropped with this change. #746's
// ANTI-FARMING reasoning survives untouched: a season is manager-controlled and team-wide, so a
// member still cannot mint a fresh allowance by toggling plans.
//
// Bounded so the charge engine's GREATEST(count - allowance, 0) can never be handed a number that
// makes the whole month free by accident; 999 is far above any real club's training count.
export const FreeTrainingsIncluded = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 999 })),
  Schema.brand('FreeTrainingsIncluded'),
);
export type FreeTrainingsIncluded = typeof FreeTrainingsIncluded.Type;
