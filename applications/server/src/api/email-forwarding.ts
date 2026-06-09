import { Auth, Discord, EmailForwardingApi, type Team } from '@sideline/domain';
import { DateTime, Effect, Option, Schema } from 'effect';
import { HttpServerResponse } from 'effect/unstable/http';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { EmailAttachmentsRepository } from '~/repositories/EmailAttachmentsRepository.js';
import {
  EmailForwardingConfigRepository,
  type EmailForwardingConfigRow,
} from '~/repositories/EmailForwardingConfigRepository.js';
import {
  type EmailMessageRow,
  EmailMessagesRepository,
} from '~/repositories/EmailMessagesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { EmailApprovalService } from '~/services/EmailApprovalService.js';

// ---------------------------------------------------------------------------
// Permission constant — coach/captain authority
// ---------------------------------------------------------------------------

const MANAGE_PERMISSION = 'team:manage' as const;

// ---------------------------------------------------------------------------
// Error sentinels
// ---------------------------------------------------------------------------

const forbidden = new EmailForwardingApi.EmailForbidden();
const notFound = new EmailForwardingApi.EmailMessageNotFound();
const attachmentNotFound = new EmailForwardingApi.EmailAttachmentNotFound();

// ---------------------------------------------------------------------------
// Helper: map config row → view DTO
// ---------------------------------------------------------------------------

const toConfigView = (row: EmailForwardingConfigRow) =>
  new EmailForwardingApi.EmailForwardingConfigView({
    teamId: row.team_id,
    enabled: row.enabled,
    targetChannelId: row.target_channel_id,
    coachChannelId: row.coach_channel_id,
    monitoredAddresses: [...row.monitored_addresses],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const emptySnowflake = Schema.decodeSync(Discord.Snowflake)('');

const defaultConfigView = (teamId: Team.TeamId) =>
  new EmailForwardingApi.EmailForwardingConfigView({
    teamId,
    enabled: false,
    targetChannelId: emptySnowflake,
    coachChannelId: emptySnowflake,
    monitoredAddresses: [],
    createdAt: DateTime.makeUnsafe(0),
    updatedAt: DateTime.makeUnsafe(0),
  });

// ---------------------------------------------------------------------------
// Helper: map message row + attachments → detail view DTO
// ---------------------------------------------------------------------------

const toDetailView = (
  row: EmailMessageRow,
  attachments: ReadonlyArray<EmailForwardingApi.EmailDetailView['attachments'][number]>,
) =>
  new EmailForwardingApi.EmailDetailView({
    emailId: row.id,
    teamId: row.team_id,
    status: row.status,
    fromAddress: row.from_address,
    subject: row.subject,
    body: row.body,
    summary: row.summary,
    shortSummary: row.short_summary,
    receivedAt: row.received_at,
    approvedBy: row.approved_by,
    rejectedBy: row.rejected_by,
    postedChannelId: row.posted_channel_id,
    attachments: [...attachments],
  });

// ---------------------------------------------------------------------------
// Handler group
// ---------------------------------------------------------------------------

export const EmailForwardingApiLive = HttpApiBuilder.group(Api, 'emailForwarding', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('configRepo', () => EmailForwardingConfigRepository.asEffect()),
    Effect.bind('messagesRepo', () => EmailMessagesRepository.asEffect()),
    Effect.bind('attachmentsRepo', () => EmailAttachmentsRepository.asEffect()),
    Effect.bind('approvalService', () => EmailApprovalService.asEffect()),
    Effect.map(({ members, configRepo, messagesRepo, attachmentsRepo, approvalService }) => {
      // Load an email by id and assert it belongs to the given team.
      const findOwnedEmail = (
        emailId: EmailForwardingApi.EmailDetailView['emailId'],
        teamId: Team.TeamId,
      ) =>
        messagesRepo.findById(emailId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(notFound),
              onSome: (row) =>
                row.team_id !== teamId ? Effect.fail(notFound) : Effect.succeed(row),
            }),
          ),
        );

      return (
        handlers
          // GET /teams/:teamId/email-forwarding
          .handle('getEmailForwardingConfig', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.map(({ configOpt }) =>
                Option.match(configOpt, {
                  onNone: () => defaultConfigView(teamId),
                  onSome: toConfigView,
                }),
              ),
            ),
          )

          // PUT /teams/:teamId/email-forwarding
          .handle('upsertEmailForwardingConfig', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              Effect.bind('row', () =>
                configRepo.upsert({
                  team_id: teamId,
                  enabled: payload.enabled,
                  target_channel_id: payload.target_channel_id,
                  coach_channel_id: payload.coach_channel_id,
                  monitored_addresses: [...payload.monitored_addresses],
                }),
              ),
              Effect.map(({ row }) => toConfigView(row)),
            ),
          )

          // POST /teams/:teamId/email-forwarding/regenerate-token
          .handle('regenerateEmailForwardingToken', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              // Guard: config row must exist before regenerating token
              Effect.bind('configOpt', () => configRepo.findByTeam(teamId)),
              Effect.tap(({ configOpt }) =>
                Option.isNone(configOpt) ? Effect.fail(notFound) : Effect.void,
              ),
              Effect.bind('row', () => configRepo.regenerateToken(teamId)),
              Effect.map(
                ({ row }) =>
                  new EmailForwardingApi.RegenerateTokenResponse({
                    inbound_token: row.inbound_token,
                  }),
              ),
            ),
          )

          // GET /teams/:teamId/emails/:emailId
          .handle('getEmail', ({ params: { teamId, emailId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.tap(({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.bind('row', () => findOwnedEmail(emailId, teamId)),
              Effect.bind('attachments', () => attachmentsRepo.listMetaByEmail(emailId)),
              Effect.map(({ row, attachments }) => toDetailView(row, attachments)),
            ),
          )

          // PUT /teams/:teamId/emails/:emailId/summary
          .handle('updateEmailSummary', ({ params: { teamId, emailId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              // Verify email belongs to this team before mutating
              Effect.tap(() => findOwnedEmail(emailId, teamId)),
              Effect.bind('updateResult', () =>
                messagesRepo.updateSummary(emailId, payload.summary, payload.short_summary),
              ),
              Effect.tap(({ updateResult }) =>
                Option.isNone(updateResult) ? Effect.fail(notFound) : Effect.void,
              ),
              // Reload the updated row
              Effect.bind('row', () => findOwnedEmail(emailId, teamId)),
              Effect.bind('attachments', () => attachmentsRepo.listMetaByEmail(emailId)),
              Effect.map(({ row, attachments }) => toDetailView(row, attachments)),
            ),
          )

          // POST /teams/:teamId/emails/:emailId/approve
          .handle('approveEmail', ({ params: { teamId, emailId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              // Verify email belongs to team
              Effect.tap(() => findOwnedEmail(emailId, teamId)),
              Effect.bind('outcome', ({ currentUser }) =>
                approvalService.approve(teamId, emailId, currentUser.id),
              ),
              Effect.map(({ outcome }) => ({ outcome })),
            ),
          )

          // POST /teams/:teamId/emails/:emailId/send-original
          .handle('sendOriginalEmail', ({ params: { teamId, emailId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              // Verify email belongs to team
              Effect.tap(() => findOwnedEmail(emailId, teamId)),
              Effect.bind('outcome', ({ currentUser }) =>
                approvalService.sendOriginal(teamId, emailId, currentUser.id),
              ),
              Effect.map(({ outcome }) => ({ outcome })),
            ),
          )

          // POST /teams/:teamId/emails/:emailId/reject
          .handle('rejectEmail', ({ params: { teamId, emailId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, MANAGE_PERMISSION, forbidden),
              ),
              // Verify email belongs to team
              Effect.tap(() => findOwnedEmail(emailId, teamId)),
              Effect.bind('outcome', ({ currentUser }) =>
                approvalService.dismiss(teamId, emailId, currentUser.id),
              ),
              Effect.map(({ outcome }) => ({ outcome })),
            ),
          )

          // GET /teams/:teamId/emails/:emailId/attachments/:attachmentId
          .handle('downloadEmailAttachment', ({ params: { teamId, emailId, attachmentId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.tap(({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              // Verify email belongs to team
              Effect.tap(() => findOwnedEmail(emailId, teamId)),
              Effect.bind('attOpt', () => attachmentsRepo.findByIdWithBytes(attachmentId, emailId)),
              Effect.bind('att', ({ attOpt }) =>
                Option.match(attOpt, {
                  onNone: () => Effect.fail(attachmentNotFound),
                  onSome: Effect.succeed,
                }),
              ),
              Effect.map(({ att }) => {
                // Sanitize filename — strip CR/LF/quotes/semicolons/commas
                const safeFilename = att.filename.replace(/[\r\n";,]/g, '_');
                return HttpServerResponse.uint8Array(att.content, {
                  headers: {
                    'content-type': att.contentType,
                    'content-disposition': `attachment; filename="${safeFilename}"`,
                    'content-length': String(att.content.byteLength),
                  },
                });
              }),
            ),
          )
      );
    }),
  ),
);
