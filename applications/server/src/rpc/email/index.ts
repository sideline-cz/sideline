import {
  type Discord,
  type EmailForwarding,
  EmailRpcGroup,
  EmailRpcModels,
  type Team,
} from '@sideline/domain';
import { Bind } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { hasPermission } from '~/api/permissions.js';
import { EmailMessagesRepository } from '~/repositories/EmailMessagesRepository.js';
import { EmailPostSyncEventsRepository } from '~/repositories/EmailPostSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { EmailApprovalService } from '~/services/EmailApprovalService.js';

const MANAGE_PERMISSION = 'team:manage' as const;

interface EmailDecisionInput {
  readonly team_id: Team.TeamId;
  readonly email_id: EmailForwarding.EmailMessageId;
  readonly discord_user_id: Discord.Snowflake;
}

const rpcHandlers = Effect.Do.pipe(
  Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
  Effect.bind('syncEventsRepo', () => EmailPostSyncEventsRepository.asEffect()),
  Effect.bind('membersRepo', () => TeamMembersRepository.asEffect()),
  Effect.bind('approvalService', () => EmailApprovalService.asEffect()),

  // RecordApproval / RecordRejection share the same guard sequence (email
  // ownership + team:manage authorization) and differ only in the approval
  // service method invoked.
  Effect.let('recordDecision', ({ messagesRepo, membersRepo, approvalService }) => {
    const guard = ({ team_id, email_id, discord_user_id }: EmailDecisionInput) =>
      Effect.Do.pipe(
        // Lookup email — must exist and belong to the team
        Effect.bind('rowOpt', () => messagesRepo.findById(email_id)),
        Effect.tap(({ rowOpt }) =>
          Option.match(rowOpt, {
            onNone: () => Effect.fail(new EmailRpcModels.EmailRpcMessageNotFound()),
            onSome: (row) =>
              row.team_id !== team_id
                ? Effect.fail(new EmailRpcModels.EmailRpcMessageNotFound())
                : Effect.void,
          }),
        ),
        // Authorize discord user has team:manage permission
        Effect.tap(() =>
          membersRepo.findMembershipByDiscordAndTeam(discord_user_id, team_id).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new EmailRpcModels.EmailApprovalForbidden()),
                onSome: (m) =>
                  hasPermission(m, MANAGE_PERMISSION)
                    ? Effect.void
                    : Effect.fail(new EmailRpcModels.EmailApprovalForbidden()),
              }),
            ),
          ),
        ),
      );

    return <Outcome>(
      decide: (
        teamId: Team.TeamId,
        emailId: EmailForwarding.EmailMessageId,
        actorId: Discord.Snowflake,
      ) => Effect.Effect<Outcome>,
      input: EmailDecisionInput,
    ) =>
      guard(input).pipe(
        Effect.flatMap(() => decide(input.team_id, input.email_id, input.discord_user_id)),
        Effect.map((outcome) => ({ outcome })),
      );
  }),

  Effect.let(
    'Email/RecordApproval',
    ({ recordDecision, approvalService }) =>
      (input: EmailDecisionInput) =>
        recordDecision(approvalService.approve, input),
  ),

  Effect.let(
    'Email/RecordRejection',
    ({ recordDecision, approvalService }) =>
      (input: EmailDecisionInput) =>
        recordDecision(approvalService.reject, input),
  ),

  // GetUnprocessedEmailPostEvents
  Effect.let(
    'Email/GetUnprocessedEmailPostEvents',
    ({ syncEventsRepo }) =>
      ({ limit }: { readonly limit: number }) =>
        syncEventsRepo.findUnprocessed(limit),
  ),

  // MarkEmailPostEventProcessed
  Effect.let(
    'Email/MarkEmailPostEventProcessed',
    ({ syncEventsRepo, messagesRepo }) =>
      ({
        id,
        deliveredAt: _deliveredAt,
        email_message_id,
        kind,
        posted_channel_id,
      }: {
        readonly id: string;
        readonly deliveredAt: import('effect').DateTime.Utc;
        readonly email_message_id: import('@sideline/domain').EmailForwarding.EmailMessageId;
        readonly kind: import('@sideline/domain').EmailRpcEvents.EmailPostEventKind;
        readonly posted_channel_id: import('@sideline/domain').Discord.Snowflake;
      }) =>
        syncEventsRepo.markProcessed(id).pipe(
          Effect.flatMap(() => {
            if (kind === 'post_summary') {
              return messagesRepo.setPosted(email_message_id, 'posted_summary', posted_channel_id);
            }
            if (kind === 'post_original') {
              return messagesRepo.setPosted(email_message_id, 'posted_original', posted_channel_id);
            }
            return Effect.void;
          }),
        ),
  ),

  // MarkEmailPostEventFailed
  Effect.let(
    'Email/MarkEmailPostEventFailed',
    ({ syncEventsRepo }) =>
      ({ id, error }: { readonly id: string; readonly error: string }) =>
        syncEventsRepo.markFailed(id, error),
  ),

  Bind.remove('messagesRepo'),
  Bind.remove('syncEventsRepo'),
  Bind.remove('membersRepo'),
  Bind.remove('approvalService'),
  Bind.remove('recordDecision'),
  (handlers) => EmailRpcGroup.EmailRpcGroup.toLayer(handlers),
);

export const EmailRpcLive = rpcHandlers;
