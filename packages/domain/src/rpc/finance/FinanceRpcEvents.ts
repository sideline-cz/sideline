import { Schema } from 'effect';
import * as Discord from '../../models/Discord.js';
import { AmountMinor, CurrencyCode } from '../../models/Fee.js';
import { FeeAssignmentId } from '../../models/FeeAssignment.js';
import { PaymentReminderKind } from '../../models/PaymentReminder.js';
import * as Team from '../../models/Team.js';

export class PaymentReminderReadyEvent extends Schema.TaggedClass<PaymentReminderReadyEvent>()(
  'payment_reminder_ready',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    assignment_id: FeeAssignmentId,
    kind: PaymentReminderKind,
    fee_name: Schema.String,
    effective_due_at: Schema.String,
    currency: CurrencyCode,
    amount_minor: AmountMinor,
    paid_minor: AmountMinor,
    user_discord_id: Discord.Snowflake,
  },
) {}

export const UnprocessedPaymentReminderEvent = Schema.Union([PaymentReminderReadyEvent]);

export type UnprocessedPaymentReminderEvent = Schema.Schema.Type<
  typeof UnprocessedPaymentReminderEvent
>;
