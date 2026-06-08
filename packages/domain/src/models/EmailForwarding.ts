import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import * as Discord from '~/models/Discord.js';
import * as Team from '~/models/Team.js';

// ---------------------------------------------------------------------------
// Branded IDs
// ---------------------------------------------------------------------------

export const EmailForwardingConfigId = Schema.String.pipe(Schema.brand('EmailForwardingConfigId'));
export type EmailForwardingConfigId = typeof EmailForwardingConfigId.Type;

export const EmailMessageId = Schema.String.pipe(Schema.brand('EmailMessageId'));
export type EmailMessageId = typeof EmailMessageId.Type;

export const EmailAttachmentId = Schema.String.pipe(Schema.brand('EmailAttachmentId'));
export type EmailAttachmentId = typeof EmailAttachmentId.Type;

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

export const EmailStatus = Schema.Literals([
  'received',
  'summarizing',
  'pending_approval',
  'approved',
  'send_original',
  'rejected',
  'posted_summary',
  'posted_original',
  'failed',
]);
export type EmailStatus = typeof EmailStatus.Type;

// ---------------------------------------------------------------------------
// Config model (DB row — includes inbound_token)
// ---------------------------------------------------------------------------

export class EmailForwardingConfig extends Model.Class<EmailForwardingConfig>(
  'EmailForwardingConfig',
)({
  team_id: Team.TeamId,
  enabled: Schema.Boolean,
  target_channel_id: Discord.Snowflake,
  coach_channel_id: Discord.Snowflake,
  monitored_addresses: Schema.Array(Schema.String),
  inbound_token: Schema.String,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

// ---------------------------------------------------------------------------
// Inbound email webhook payload (provider-neutral)
// ---------------------------------------------------------------------------

export class EmailAttachmentPayload extends Schema.Class<EmailAttachmentPayload>(
  'EmailAttachmentPayload',
)({
  filename: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))),
  content_type: Schema.String.pipe(Schema.check(Schema.isMaxLength(255))),
  size: Schema.Int,
  content_base64: Schema.String,
}) {}

export class InboundEmailPayload extends Schema.Class<InboundEmailPayload>('InboundEmailPayload')({
  from: Schema.String,
  to: Schema.Array(Schema.String),
  subject: Schema.String,
  text: Schema.String,
  html: Schema.OptionFromNullOr(Schema.String),
  received_at: Schema.OptionFromNullOr(Schema.DateTimeUtcFromString),
  attachments: Schema.OptionFromNullOr(Schema.Array(EmailAttachmentPayload)),
}) {}

// ---------------------------------------------------------------------------
// Attachment metadata (no bytes — for list/detail views)
// ---------------------------------------------------------------------------

export class EmailAttachmentMeta extends Schema.Class<EmailAttachmentMeta>('EmailAttachmentMeta')({
  attachmentId: EmailAttachmentId,
  filename: Schema.String,
  contentType: Schema.String,
  sizeBytes: Schema.Int,
  createdAt: Schema.DateTimeUtc,
}) {}
