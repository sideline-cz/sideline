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

/**
 * D11 / T10b — the T-14/T-7/T-1 Discord DM to the treasurer that a connected Fio token is about
 * to expire (`token_created_at + 180d`). Emitted by `BankTokenExpiryCron` into its own outbox
 * table (`bank_token_expiry_events`, migration `1792000004`) — `payment_reminder_sync_events`
 * cannot be reused, it is FK'd to `fee_assignments` with several NOT NULL columns this event has
 * no equivalent for.
 */
export class BankTokenExpiringEvent extends Schema.TaggedClass<BankTokenExpiringEvent>()(
  'bank_token_expiring',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    user_discord_id: Discord.Snowflake,
    days_until_expiry: Schema.Int,
  },
) {}

export const UnprocessedBankTokenExpiryEvent = Schema.Union([BankTokenExpiringEvent]);

export type UnprocessedBankTokenExpiryEvent = Schema.Schema.Type<
  typeof UnprocessedBankTokenExpiryEvent
>;
