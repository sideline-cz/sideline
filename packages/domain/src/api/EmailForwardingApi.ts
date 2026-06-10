import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { Snowflake } from '~/models/Discord.js';
import {
  EmailAttachmentId,
  EmailAttachmentMeta,
  EmailMessageId,
  EmailStatus,
} from '~/models/EmailForwarding.js';
import { TeamId } from '~/models/Team.js';

// ---------------------------------------------------------------------------
// View types (response DTOs)
// ---------------------------------------------------------------------------

/**
 * Config view returned to web clients — inbound_token and imap_secret_encrypted are intentionally omitted.
 */
export class EmailForwardingConfigView extends Schema.Class<EmailForwardingConfigView>(
  'EmailForwardingConfigView',
)({
  teamId: TeamId,
  enabled: Schema.Boolean,
  targetChannelId: Snowflake,
  coachChannelId: Snowflake,
  monitoredAddresses: Schema.Array(Schema.String),
  imapEnabled: Schema.Boolean,
  imapHost: Schema.OptionFromNullOr(Schema.String),
  imapPort: Schema.OptionFromNullOr(Schema.Int),
  imapUsername: Schema.OptionFromNullOr(Schema.String),
  imapUseTls: Schema.Boolean,
  imapFolder: Schema.OptionFromNullOr(Schema.String),
  imapSecretSet: Schema.Boolean,
  imapLastSeenUid: Schema.OptionFromNullOr(Schema.Int),
  imapLastSyncedAt: Schema.OptionFromNullOr(Schema.DateTimeUtc),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc,
}) {}

/**
 * Token-only response — the only place the inbound token is returned.
 */
export class RegenerateTokenResponse extends Schema.Class<RegenerateTokenResponse>(
  'RegenerateTokenResponse',
)({
  inbound_token: Schema.String,
}) {}

export class EmailDetailView extends Schema.Class<EmailDetailView>('EmailDetailView')({
  emailId: EmailMessageId,
  teamId: TeamId,
  status: EmailStatus,
  fromAddress: Schema.String,
  subject: Schema.String,
  body: Schema.String,
  summary: Schema.OptionFromNullOr(Schema.String),
  shortSummary: Schema.OptionFromNullOr(Schema.String),
  receivedAt: Schema.DateTimeUtc,
  approvedBy: Schema.OptionFromNullOr(Schema.String),
  rejectedBy: Schema.OptionFromNullOr(Schema.String),
  postedChannelId: Schema.OptionFromNullOr(Snowflake),
  attachments: Schema.Array(EmailAttachmentMeta),
}) {}

// ---------------------------------------------------------------------------
// Request DTOs
// ---------------------------------------------------------------------------

export const UpsertEmailForwardingConfigRequest = Schema.Struct({
  enabled: Schema.Boolean,
  target_channel_id: Snowflake,
  coach_channel_id: Snowflake,
  monitored_addresses: Schema.Array(Schema.String),
  imap_enabled: Schema.Boolean,
  imap_host: Schema.OptionFromNullOr(Schema.String),
  imap_port: Schema.OptionFromNullOr(Schema.Int),
  imap_username: Schema.OptionFromNullOr(Schema.String),
  imap_use_tls: Schema.Boolean,
  imap_folder: Schema.OptionFromNullOr(Schema.String),
  imap_secret: Schema.OptionFromOptional(Schema.NonEmptyString),
});
export type UpsertEmailForwardingConfigRequest = Schema.Schema.Type<
  typeof UpsertEmailForwardingConfigRequest
>;

export const UpdateEmailSummaryRequest = Schema.Struct({
  summary: Schema.String.pipe(Schema.check(Schema.isMaxLength(8000))),
  short_summary: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
});
export type UpdateEmailSummaryRequest = Schema.Schema.Type<typeof UpdateEmailSummaryRequest>;

// ---------------------------------------------------------------------------
// Result types
// ---------------------------------------------------------------------------

export const EmailActionResult = Schema.Struct({
  outcome: Schema.Literals(['approved', 'sent_original', 'dismissed', 'already_handled']),
});
export type EmailActionResult = Schema.Schema.Type<typeof EmailActionResult>;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailForbidden extends Schema.TaggedErrorClass<EmailForbidden>()(
  'EmailForbidden',
  {},
) {}

export class EmailMessageNotFound extends Schema.TaggedErrorClass<EmailMessageNotFound>()(
  'EmailMessageNotFound',
  {},
) {}

export class EmailNotPending extends Schema.TaggedErrorClass<EmailNotPending>()(
  'EmailNotPending',
  {},
) {}

export class EmailAttachmentNotFound extends Schema.TaggedErrorClass<EmailAttachmentNotFound>()(
  'EmailAttachmentNotFound',
  {},
) {}

// ---------------------------------------------------------------------------
// API group
// ---------------------------------------------------------------------------

export class EmailForwardingApiGroup extends HttpApiGroup.make('emailForwarding')
  .add(
    HttpApiEndpoint.get('getEmailForwardingConfig', '/teams/:teamId/email-forwarding', {
      success: EmailForwardingConfigView,
      error: EmailForbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('upsertEmailForwardingConfig', '/teams/:teamId/email-forwarding', {
      success: EmailForwardingConfigView,
      error: EmailForbidden.pipe(HttpApiSchema.status(403)),
      payload: UpsertEmailForwardingConfigRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'regenerateEmailForwardingToken',
      '/teams/:teamId/email-forwarding/regenerate-token',
      {
        success: RegenerateTokenResponse,
        error: [
          EmailForbidden.pipe(HttpApiSchema.status(403)),
          EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getEmail', '/teams/:teamId/emails/:emailId', {
      success: EmailDetailView,
      error: [
        EmailForbidden.pipe(HttpApiSchema.status(403)),
        EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, emailId: EmailMessageId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('updateEmailSummary', '/teams/:teamId/emails/:emailId/summary', {
      success: EmailDetailView,
      error: [
        EmailForbidden.pipe(HttpApiSchema.status(403)),
        EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: UpdateEmailSummaryRequest,
      params: { teamId: TeamId, emailId: EmailMessageId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('approveEmail', '/teams/:teamId/emails/:emailId/approve', {
      success: EmailActionResult,
      error: [
        EmailForbidden.pipe(HttpApiSchema.status(403)),
        EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
        EmailNotPending.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, emailId: EmailMessageId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('sendOriginalEmail', '/teams/:teamId/emails/:emailId/send-original', {
      success: EmailActionResult,
      error: [
        EmailForbidden.pipe(HttpApiSchema.status(403)),
        EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
        EmailNotPending.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, emailId: EmailMessageId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('rejectEmail', '/teams/:teamId/emails/:emailId/reject', {
      success: EmailActionResult,
      error: [
        EmailForbidden.pipe(HttpApiSchema.status(403)),
        EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
        EmailNotPending.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, emailId: EmailMessageId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'downloadEmailAttachment',
      '/teams/:teamId/emails/:emailId/attachments/:attachmentId',
      {
        success: Schema.Void,
        error: [
          EmailForbidden.pipe(HttpApiSchema.status(403)),
          EmailMessageNotFound.pipe(HttpApiSchema.status(404)),
          EmailAttachmentNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: {
          teamId: TeamId,
          emailId: EmailMessageId,
          attachmentId: EmailAttachmentId,
        },
      },
    ).middleware(AuthMiddleware),
  ) {}
