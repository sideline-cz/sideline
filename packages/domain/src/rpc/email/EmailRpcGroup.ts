import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import { EmailMessageId } from '../../models/EmailForwarding.js';
import * as Team from '../../models/Team.js';
import { EmailPostEventKind, UnprocessedEmailPostEvent } from './EmailRpcEvents.js';
import { EmailApprovalForbidden, EmailRpcMessageNotFound } from './EmailRpcModels.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export const EmailRpcGroup = RpcGroup.make(
  Rpc.make('RecordApproval', {
    payload: {
      team_id: Team.TeamId,
      email_id: EmailMessageId,
      discord_user_id: Discord.Snowflake,
    },
    success: Schema.Struct({
      outcome: Schema.Literals(['approved', 'already_handled']),
    }),
    error: Schema.Union([EmailApprovalForbidden, EmailRpcMessageNotFound]),
  }),
  Rpc.make('RecordRejection', {
    payload: {
      team_id: Team.TeamId,
      email_id: EmailMessageId,
      discord_user_id: Discord.Snowflake,
    },
    success: Schema.Struct({
      outcome: Schema.Literals(['rejected', 'already_handled']),
    }),
    error: Schema.Union([EmailApprovalForbidden, EmailRpcMessageNotFound]),
  }),
  Rpc.make('GetUnprocessedEmailPostEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedEmailPostEvent),
  }),
  Rpc.make('MarkEmailPostEventProcessed', {
    payload: {
      id: UUIDString,
      deliveredAt: Schema.DateTimeUtc,
      email_message_id: EmailMessageId,
      kind: EmailPostEventKind,
      posted_channel_id: Discord.Snowflake,
    },
  }),
  Rpc.make('MarkEmailPostEventFailed', {
    payload: { id: UUIDString, error: Schema.String },
  }),
).prefix('Email/');
