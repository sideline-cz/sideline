import { Effect, Schedule } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';

/**
 * Days a finished email keeps its body and attachments.
 *
 * Fixed rather than per-team on purpose: the published privacy policy has to
 * state a single retention period, and a per-team column would mostly be a way
 * for one admin to quietly set it to "never" — which is the state this job
 * exists to end. Exported so the test asserts against the same number the
 * policy quotes rather than a copy of it.
 */
export const RETENTION_DAYS = 90;

/**
 * Empties the body and deletes the attachments of forwarded emails that
 * finished being handled more than `RETENTION_DAYS` ago.
 *
 * **Why this exists at all.** `email_messages.body` holds the full text of
 * every email sent to a team's connected mailbox and `email_attachments`
 * holds the raw files, both previously forever, and that content is also sent
 * to OpenAI for summarising. Unlike every other table here, the people who
 * wrote those emails never signed up for Sideline: no account, no consent, no
 * way to ask for deletion. `docs/database.md` recorded the gap and the
 * published privacy policy states it.
 *
 * The `summary` survives, because it is what actually got posted to Discord
 * and is the only part anyone reads back. Keeping from/subject/status leaves
 * "why did the bot post this?" answerable long after the source text is gone.
 *
 * Runs daily rather than hourly: the window is 90 days, so the difference
 * between purging at 90 days and 90 days 23 hours is not worth a wakeup.
 */
const cronEffect = Effect.Do.pipe(
  Effect.bind('emails', () => EmailMessagesRepository.asEffect()),
  Effect.bind('purged', ({ emails }) => emails.purgeOlderThan(RETENTION_DAYS)),
  Effect.tap(({ purged }) =>
    // Silent on a no-op run, which is what almost every run will be once the
    // backlog has cleared. A daily "purged 0" line is noise that trains you to
    // stop reading the ones that matter.
    purged === 0
      ? Effect.void
      : Effect.logInfo(
          `EmailRetentionCron: purged the body and attachments of ${String(purged)} email(s) older than ${String(RETENTION_DAYS)} days`,
        ),
  ),
  Effect.asVoid,
  withCronMetrics('email-retention'),
);

/** 03:30 — after the 02:00 age check, in the same quiet window. */
const cronSchedule = Schedule.cron('30 3 * * *');

export const EmailRetentionCron = cronEffect.pipe(Effect.repeat(cronSchedule), Effect.asVoid);
