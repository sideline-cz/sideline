import { Array, Effect, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { FeeAssignmentsRepository } from '~/repositories/FeeAssignmentsRepository.js';
import { PaymentReminderSyncEventsRepository } from '~/repositories/PaymentReminderSyncEventsRepository.js';

// Concurrency safety: overlapping cron ticks cannot double-emit reminders
// because `findReminderCandidates` excludes assignments that already have an
// unprocessed `payment_reminder_sync_events` row for the same kind. Once a
// candidate is emitted, the next tick sees the unprocessed row and skips it
// until the bot acks (markProcessed/markFailed).
export const paymentReminderCronEffect = Effect.Do.pipe(
  Effect.bind('feeAssignmentsRepo', () => FeeAssignmentsRepository.asEffect()),
  Effect.bind('paymentSyncRepo', () => PaymentReminderSyncEventsRepository.asEffect()),
  Effect.tap(() => Effect.logInfo('PaymentReminderCron: starting reminder cycle')),
  Effect.bind('now', () => Effect.sync(() => new Date())),
  Effect.bind('candidates', ({ feeAssignmentsRepo, now }) =>
    feeAssignmentsRepo.findReminderCandidates(now),
  ),
  Effect.tap(({ candidates, paymentSyncRepo }) =>
    Effect.all(
      Array.map(candidates, (candidate) =>
        paymentSyncRepo.emit(candidate.assignment_id, candidate.guild_id, candidate.kind).pipe(
          Effect.tap(() =>
            Effect.logInfo(
              `PaymentReminderCron: queued ${candidate.kind} reminder for assignment ${candidate.assignment_id}`,
            ),
          ),
          Effect.tapError((e) =>
            Effect.logWarning(
              `PaymentReminderCron: failed for assignment ${candidate.assignment_id}`,
              e,
            ),
          ),
          Effect.exit,
        ),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ candidates }) =>
    Effect.logInfo(
      `PaymentReminderCron: cycle complete, ${String(candidates.length)} candidate(s) processed`,
    ),
  ),
  Effect.asVoid,
  withCronMetrics('payment-reminder'),
);

const cronSchedule = Schedule.cron('* * * * *');

export const PaymentReminderCron = paymentReminderCronEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
