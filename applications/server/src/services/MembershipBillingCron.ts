import { Array, DateTime, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { MembershipPlansRepository } from '~/repositories/MembershipPlansRepository.js';

/**
 * Bills each member their membership plan's price once per season, and refunds the difference as
 * member credit when they move to a cheaper plan. Opt-in per team via
 * `team_settings.membership_billing_by_user_id` -- the column is both the flag and the user every
 * credit deposit the sweep writes is recorded under.
 *
 * THIS FILE CONTAINS NO SQL AND NO MONEY ARITHMETIC. It is a candidate query plus one call to
 * `recompute_membership_season_fees(team_id)` per team -- the same split `AutoApplyCreditCron`
 * uses. All of the derivation (the per-member delta, the refund floor, the shell fee keyed on
 * `(team, season, plan, currency)`, the lock order) lives in that function, in
 * `packages/migrations`.
 *
 * IDEMPOTENT BY DERIVATION, not by a marker column: the function recomputes the net from what is
 * already charged, refunded and held, so `delta = 0` is the steady state and a second tick over
 * unchanged state writes nothing. Same property `recompute_training_period_fees` has.
 *
 * THE RUNNING SEASON, NOT THE GOVERNING ONE. Both the candidate query and the function resolve
 * the latest season with `starts_at <= now()`. `governing_season_id` answers a different question
 * ("which season is the member picking for") and prefers an OPEN season, so it returns a queued
 * future one for months at a time -- which would switch billing off for the live season, silently,
 * on a money feature. Do not swap it in.
 *
 * It is deliberately NOT a database trigger on `team_members.membership_plan_id`. A trigger fires
 * with `team_members` already locked and would have to take `seasons`, `fees` AND
 * `member_credit_accounts` from inside one, inverting the canonical lock order (root AGENTS.md
 * invariant 2) and deadlocking 40P01 on a money write -- the same reasoning
 * `AutoApplyCreditCron`'s header gives.
 *
 * ACCEPTED RISK: ONE PLAN COLUMN, TWO SEASONS IN FLIGHT. `team_members.membership_plan_id` is the
 * ONLY record of a member's pick -- there is no `(team_member_id, season_id, plan_id)` selection
 * row anywhere in the schema. So while next season's selection window is open and the current
 * season is still running, a member who picks next season's CHEAPER plan moves the CURRENT
 * season's delta and earns a refund they have not earned. Exposure window: the current season's
 * window is closed AND an open next season is queued. This is NOT fixed by freezing billing -- an
 * earlier draft did exactly that and traded an occasional wrong refund for a total, silent,
 * months-long outage. The honest fix is a per-season selection row, which is a separate and
 * larger ticket.
 *
 * Cadence matches the other finance crons so the two can never disagree about state. The steady
 * state is one selective SELECT per minute plus one early-returning function call per opted-in
 * team, and zero writes.
 */

export const membershipBillingCronEffect = Effect.Do.pipe(
  Effect.bind('plans', () => MembershipPlansRepository.asEffect()),
  Effect.bind('candidates', ({ plans }) => plans.findMembershipBillingTeams()),
  Effect.tap(({ candidates, plans }) =>
    Effect.all(
      Array.map(candidates, (candidate) =>
        (Option.isNone(candidate.recordedByUserId)
          ? // Hourly, not every tick. The candidate query returns this team on EVERY tick for as
            // long as the condition holds, and the condition is sticky (nobody is going to
            // re-save the setting within the minute), so an unconditional warning is 1 440
            // identical lines/day/team forever in a log that then nobody reads. One predicate is
            // the whole rate limiter.
            DateTime.now.pipe(
              Effect.flatMap((now) =>
                DateTime.getPartUtc(now, 'minute') === 0
                  ? Effect.logWarning(
                      `MembershipBillingCron: team ${candidate.teamId} has membership fees but ` +
                        'membership_billing_by_user_id is NULL — billing is OFF (the admin who ' +
                        'enabled it was removed). Re-save the Finance setting to resume.',
                    )
                  : Effect.void,
              ),
            )
          : plans
              .recomputeMembershipSeasonFees(candidate.teamId)
              .pipe(
                Effect.flatMap(() =>
                  Effect.logDebug(
                    `MembershipBillingCron: recomputed membership season fees for team ${candidate.teamId}`,
                  ),
                ),
              )
        ).pipe(
          // `tapDefect`, NOT `tapError`: this branch is `Effect<void, never, _>`. Every real
          // failure -- 40P01, a 23514 on `fees_kind_season_check`, a dropped connection -- goes
          // through `catchSqlErrors`, which is `LogicError.withMessage`, which is `Effect.die`.
          // A defect, so `tapError` never fires and `Effect.exit` below absorbs it into a success
          // value before `withCronMetrics` can count it. With `tapError` here a team whose
          // recompute fails on all 1 440 ticks a day logs NOTHING and the cron reports
          // `result="success"` every minute -- a total billing outage, invisible on the dashboard.
          Effect.tapDefect((cause) =>
            Effect.logWarning(`MembershipBillingCron: failed for team ${candidate.teamId}`, cause),
          ),
          // Per TEAM, so one team's failure never aborts the sweep for the teams behind it (the
          // sweep is `{ concurrency: 1 }`, so without this the teams AFTER the bad one are never
          // visited, and the escaping defect kills `Effect.repeat` for the pod's lifetime). The
          // function is a pure derivation, so the next tick simply recomputes it. Pinned by B23.
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.asVoid,
  withCronMetrics('membership-billing'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const MembershipBillingCron = membershipBillingCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
