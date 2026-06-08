import type { EmailForwarding } from '@sideline/domain';
import { Effect, Layer, Option, ServiceMap } from 'effect';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface EmailApprovalServiceInterface {
  readonly approve: (
    teamId: string,
    emailId: EmailForwarding.EmailMessageId,
    actorId: string,
  ) => Effect.Effect<'approved' | 'already_handled'>;
  readonly reject: (
    teamId: string,
    emailId: EmailForwarding.EmailMessageId,
    actorId: string,
  ) => Effect.Effect<'rejected' | 'already_handled'>;
}

// ---------------------------------------------------------------------------
// make
// ---------------------------------------------------------------------------

const make = Effect.Do.pipe(
  Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
  Effect.bind('syncEventsRepo', () => EmailPostSyncEventsRepository.asEffect()),
  Effect.map(
    ({ messagesRepo, syncEventsRepo }): EmailApprovalServiceInterface => ({
      approve: (teamId, emailId, actorId) =>
        messagesRepo.approve(emailId, actorId).pipe(
          Effect.flatMap((result) => {
            if (Option.isSome(result)) {
              return syncEventsRepo
                .enqueue(emailId, teamId, 'post_summary')
                .pipe(Effect.as('approved' as const));
            }
            return Effect.succeed('already_handled' as const);
          }),
        ),

      reject: (teamId, emailId, actorId) =>
        messagesRepo.reject(emailId, actorId).pipe(
          Effect.flatMap((result) => {
            if (Option.isSome(result)) {
              return syncEventsRepo
                .enqueue(emailId, teamId, 'post_original')
                .pipe(Effect.as('rejected' as const));
            }
            return Effect.succeed('already_handled' as const);
          }),
        ),
    }),
  ),
);

export class EmailApprovalService extends ServiceMap.Service<
  EmailApprovalService,
  EmailApprovalServiceInterface
>()('api/EmailApprovalService') {
  static readonly Default = Layer.effect(EmailApprovalService, make);
}
