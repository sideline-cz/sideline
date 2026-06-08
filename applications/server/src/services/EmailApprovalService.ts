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
  readonly sendOriginal: (
    teamId: string,
    emailId: EmailForwarding.EmailMessageId,
    actorId: string,
  ) => Effect.Effect<'sent_original' | 'already_handled'>;
  readonly dismiss: (
    teamId: string,
    emailId: EmailForwarding.EmailMessageId,
    actorId: string,
  ) => Effect.Effect<'dismissed' | 'already_handled'>;
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

      sendOriginal: (teamId, emailId, actorId) =>
        messagesRepo.sendOriginal(emailId, actorId).pipe(
          Effect.flatMap((result) => {
            if (Option.isSome(result)) {
              return syncEventsRepo
                .enqueue(emailId, teamId, 'post_original')
                .pipe(Effect.as('sent_original' as const));
            }
            return Effect.succeed('already_handled' as const);
          }),
        ),

      dismiss: (_teamId, emailId, actorId) =>
        messagesRepo.dismiss(emailId, actorId).pipe(
          Effect.map((result) => {
            if (Option.isSome(result)) {
              return 'dismissed' as const;
            }
            return 'already_handled' as const;
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
