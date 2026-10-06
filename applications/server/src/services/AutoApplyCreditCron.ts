import { Array, DateTime, Effect, Option, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { MemberCreditsRepository } from '~/repositories/MemberCreditsRepository.js';

/**
 * Spends held member credit against what the member owes, without a treasurer opening the
 * settle dialog. Opt-in per team via `team_settings.auto_apply_credit_enabled`.
 *
 * THIS FILE CONTAINS NO MONEY ARITHMETIC AND TAKES NO LOCKS. It is a candidate query plus a
 * call to `MemberCreditsRepository.settle` with `amountMinor: 0` -- a shape `CreateSettlementRequest`
 * has documented as legal from the start ("0 is legal: pure credit application, or a no-op").
 * `settle` then reaches `planSettlement(candidates, balance, 0)`, the exact mirror of the bank
 * matcher's `planSettlement(candidates, 0, amount)`, so every line it emits is `source: 'credit'`
 * and `creditAddedMinor` is 0. Allocation order, partial coverage and the canonical lock order are
 * identical to a treasurer's manual Settle BY CONSTRUCTION, not by convention -- there is no
 * second allocation path here to drift out of agreement with the first.
 *
 * It is deliberately NOT a database trigger on `fee_assignments`. A trigger fires with
 * `fee_assignments` already locked, so taking `member_credit_accounts` from inside one inverts
 * the canonical order (root AGENTS.md invariant 2, `fees` -> `member_credit_accounts` ->
 * `payments` -> `bank_transactions` -> `fee_assignments`) and deadlocks 40P01 on a money write,
 * which Postgres reports as an untyped SqlError. It is also not hung off credit CREATION: the
 * matcher's auto-credit path passes a credit pool of 0 on purpose, so that `/unmatch` never
 * refunds credit a transfer did not create, and that reasoning is untouched here.
 *
 * DOUBLE-SPEND. The state is the idempotency key and `settle` already enforces it: the debit is
 * a conditional `UPDATE ... WHERE balance_minor >= applied` taken under the account's FOR UPDATE,
 * never a SELECT-then-UPDATE. A second tick over the same state reads the decremented balance and
 * the incremented `paid_minor`, finds no candidate, and writes nothing -- no marker table, and
 * safe across replicas. `recompute_training_period_fees` is idempotent by recomputing from
 * scratch; that pattern explicitly does NOT transfer to spending credit, which is a transfer and
 * not a derivation.
 *
 * Cadence matches PaymentReminderCron so the two can never disagree about state. The steady state
 * is one selective SELECT per minute and zero writes: a member stops being a candidate the moment
 * their credit is spent.
 */

export const autoApplyCreditCronEffect = Effect.Do.pipe(
  Effect.bind('creditsRepo', () => MemberCreditsRepository.asEffect()),
  Effect.bind('candidates', ({ creditsRepo }) => creditsRepo.findAutoApplyCandidates()),
  Effect.tap(({ candidates, creditsRepo }) =>
    Effect.all(
      Array.map(candidates, (candidate) =>
        DateTime.now.pipe(
          Effect.flatMap((now) =>
            creditsRepo.settle({
              teamId: candidate.teamId,
              teamMemberId: candidate.teamMemberId,
              currency: candidate.currency,
              // The whole point: allocate no cash, only the held balance.
              amountMinor: 0,
              // Ignored when amountMinor is 0 -- no 'payment'-source line can exist, so this
              // never reaches a payments row. Every row this writes carries method 'credit'.
              method: 'bank_transfer',
              paidAt: now,
              note: Option.none(),
              expectedOutstandingMinor: candidate.outstandingMinor,
              expectedCreditMinor: candidate.balanceMinor,
              recordedByUserId: candidate.recordedByUserId,
            }),
          ),
          Effect.flatMap((result) =>
            Effect.logInfo(
              `AutoApplyCreditCron: applied ${String(result.creditAppliedMinor)} ${candidate.currency} of credit for member ${candidate.teamMemberId} across ${String(result.allocations.length)} fee(s)`,
            ),
          ),
          // The EXPECTED outcome of a race, not a fault: the candidate read takes no locks, so a
          // treasurer settling (or a bank transfer landing) between it and settle's own locked
          // re-read moves exactly the figures the stale check reconciles. InsufficientCredit is
          // the same race seen from the balance side. Debug, not warning -- and per-member, so one
          // raced member never aborts the sweep for the members behind it.
          // FinanceMemberNotFound joins them: the member (or their account row) can be gone by
          // the time settle re-reads, and a deactivation mid-sweep is not an incident.
          Effect.catchTag(['SettlementStale', 'InsufficientCredit', 'FinanceMemberNotFound'], () =>
            Effect.logDebug(
              `AutoApplyCreditCron: skipped member ${candidate.teamMemberId} — figures moved under the candidate read, retrying next tick`,
            ),
          ),
          Effect.tapError((error) =>
            Effect.logWarning(
              `AutoApplyCreditCron: failed for member ${candidate.teamMemberId}`,
              error,
            ),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.asVoid,
  withCronMetrics('auto-apply-credit'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const AutoApplyCreditCron = autoApplyCreditCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
