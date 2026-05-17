import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import { FeeAssignmentId } from '../../models/FeeAssignment.js';
import { PaymentReminderKind } from '../../models/PaymentReminder.js';
import { UnprocessedPaymentReminderEvent } from './FinanceRpcEvents.js';
import {
  FinanceGuildNotFound,
  FinanceMemberNotFound,
  GetMyStatusResult,
} from './FinanceRpcModels.js';

const UUIDString = Schema.String.pipe(Schema.check(Schema.isUUID()));

export const FinanceRpcGroup = RpcGroup.make(
  Rpc.make('GetMyStatus', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: GetMyStatusResult,
    error: Schema.Union([FinanceGuildNotFound, FinanceMemberNotFound]),
  }),
  Rpc.make('GetUnprocessedPaymentReminders', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedPaymentReminderEvent),
  }),
  Rpc.make('MarkPaymentReminderProcessed', {
    payload: { id: UUIDString },
  }),
  Rpc.make('MarkPaymentReminderFailed', {
    payload: { id: UUIDString, error: Schema.String },
  }),
  Rpc.make('MarkReminderSent', {
    payload: { assignment_id: FeeAssignmentId, kind: PaymentReminderKind },
  }),
).prefix('Finance/');
