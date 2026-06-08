import { Schema } from 'effect';
import * as Discord from '../../models/Discord.js';
import { EmailMessageId } from '../../models/EmailForwarding.js';
import * as Team from '../../models/Team.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export const EmailPostEventKind = Schema.Literals([
  'approval_request',
  'post_summary',
  'post_original',
]);
export type EmailPostEventKind = typeof EmailPostEventKind.Type;

export class EmailPostEvent extends Schema.Class<EmailPostEvent>('EmailPostEvent')({
  id: UUIDString,
  email_message_id: EmailMessageId,
  team_id: Team.TeamId,
  kind: EmailPostEventKind,
  coach_channel_id: Discord.Snowflake,
  target_channel_id: Discord.Snowflake,
  subject: Schema.String,
  from_address: Schema.String,
  summary: Schema.OptionFromNullOr(Schema.String),
  body: Schema.String,
  received_at: Schema.DateTimeUtc,
}) {}

export const UnprocessedEmailPostEvent = Schema.Union([EmailPostEvent]);
export type UnprocessedEmailPostEvent = Schema.Schema.Type<typeof UnprocessedEmailPostEvent>;
