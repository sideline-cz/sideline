import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '../../models/Discord.js';
import { FeeAssignmentId } from '../../models/FeeAssignment.js';
import { PaymentReminderKind } from '../../models/PaymentReminder.js';
import * as Team from '../../models/Team.js';
import {
  UnprocessedBankTokenExpiryEvent,
  UnprocessedPaymentReminderEvent,
} from './FinanceRpcEvents.js';
import {
  FinanceGuildNotFound,
  FinanceMemberNotFound,
  FinanceQrUnavailable,
  GetMyStatusResult,
  PaymentQrResult,
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
  Rpc.make('GetPaymentQr', {
    payload: { assignment_id: FeeAssignmentId },
    success: PaymentQrResult,
    error: FinanceQrUnavailable,
  }),
  Rpc.make('GetUnprocessedBankTokenExpiryEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedBankTokenExpiryEvent),
  }),
  Rpc.make('MarkBankTokenExpiryProcessed', {
    payload: { id: UUIDString },
  }),
  Rpc.make('MarkBankTokenExpiryFailed', {
    payload: { id: UUIDString, error: Schema.String },
  }),
  Rpc.make('MarkBankTokenExpirySent', {
    payload: {
      team_id: Team.TeamId,
      token_created_at: Schema.String,
      threshold_days: Schema.Int,
    },
  }),
).prefix('Finance/');
