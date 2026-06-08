import type { EmailForwarding } from '@sideline/domain';
import { Array, Effect, Option, Schedule, type ServiceMap } from 'effect';
import { withCronMetrics } from '~/metrics.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import { LlmClient } from '~/services/LlmClient.js';

const MAX_SUMMARIZE_ATTEMPTS = 3;
const BATCH_SIZE = 10;

// ---------------------------------------------------------------------------
// Single-email processor (uses service shapes directly)
// ---------------------------------------------------------------------------

const processEmailId = (
  messagesRepo: ServiceMap.Service.Shape<typeof EmailMessagesRepository>,
  syncEventsRepo: ServiceMap.Service.Shape<typeof EmailPostSyncEventsRepository>,
  llm: ServiceMap.Service.Shape<typeof LlmClient>,
  emailId: EmailForwarding.EmailMessageId,
) =>
  Effect.Do.pipe(
    // Try to claim the row (status: received → summarizing). Skip if already taken.
    Effect.bind('claimed', () => messagesRepo.claimForSummarizing(emailId)),
    Effect.flatMap(({ claimed }) => {
      if (Option.isNone(claimed)) return Effect.void;

      return Effect.Do.pipe(
        // Load the full row to get subject/from/body
        Effect.bind('row', () =>
          messagesRepo.findById(emailId).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (row) =>
                  // Summarize — never log body
                  llm
                    .summarizeEmail({
                      subject: row.subject,
                      from: row.from_address,
                      body: row.body,
                    })
                    .pipe(
                      // Success: mark pending_approval + enqueue approval_request
                      Effect.flatMap((summary) =>
                        messagesRepo
                          .setSummaryPendingApproval(emailId, summary)
                          .pipe(
                            Effect.tap(() =>
                              syncEventsRepo.enqueue(emailId, row.team_id, 'approval_request'),
                            ),
                          ),
                      ),
                      Effect.tap(() =>
                        Effect.logInfo(`EmailSummarizer: summarized email ${emailId}`),
                      ),
                      // On LlmError: increment attempts, possibly cap to 'failed'
                      Effect.catchTag('LlmError', (e) =>
                        messagesRepo.incrementAttemptsAndMaybeFail(
                          emailId,
                          MAX_SUMMARIZE_ATTEMPTS,
                          e.message,
                        ),
                      ),
                    ),
              }),
            ),
          ),
        ),
        Effect.asVoid,
      );
    }),
  );

// ---------------------------------------------------------------------------
// Cron effect
// ---------------------------------------------------------------------------

export const emailSummarizerEffect = Effect.Do.pipe(
  Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
  Effect.bind('syncEventsRepo', () => EmailPostSyncEventsRepository.asEffect()),
  Effect.bind('llm', () => LlmClient.asEffect()),
  Effect.tap(() => Effect.logInfo('EmailSummarizer: starting cycle')),
  Effect.bind('emailIds', ({ messagesRepo }) => messagesRepo.findReceivedBatch(BATCH_SIZE)),
  Effect.tap(({ emailIds, messagesRepo, syncEventsRepo, llm }) =>
    Effect.all(
      Array.map(emailIds, (emailId) =>
        processEmailId(messagesRepo, syncEventsRepo, llm, emailId).pipe(Effect.exit),
      ),
      { concurrency: 1 },
    ),
  ),
  Effect.tap(({ emailIds }) =>
    Effect.logInfo(`EmailSummarizer: cycle complete, ${String(emailIds.length)} candidate(s)`),
  ),
  Effect.asVoid,
  withCronMetrics('email-summarizer'),
);

// ---------------------------------------------------------------------------
// Cron registration
// ---------------------------------------------------------------------------

const cronSchedule = Schedule.cron('* * * * *');

export const EmailSummarizer = emailSummarizerEffect.pipe(
  Effect.repeat(cronSchedule),
  Effect.asVoid,
);
