import type { FinanceRpcEvents, PaymentReminder } from '@sideline/domain';
import type * as Discord from 'dfx/types';
import { Match } from 'effect';
import { formatMoney } from '~/rest/finance/formatMoney.js';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const COLOR_BLUE = 0x5865f2;
const COLOR_YELLOW = 0xfee75c;
const COLOR_RED = 0xed4245;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const toDiscordDateTimestamp = (isoString: string): string => {
  const unixSecs = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${unixSecs}:D>`;
};

type EmbedCopy = { title: string; color: number; description: (feeName: string) => string };

const copyForKind = (kind: PaymentReminder.PaymentReminderKind): EmbedCopy =>
  Match.value(kind).pipe(
    Match.when(
      'due_in_3d',
      (): EmbedCopy => ({
        title: 'Heads up — payment due soon',
        color: COLOR_BLUE,
        description: (feeName) => `Just a nudge: **${feeName}** is due in 3 days.`,
      }),
    ),
    Match.when(
      'due_today',
      (): EmbedCopy => ({
        title: 'Payment due today',
        color: COLOR_YELLOW,
        description: (feeName) =>
          `Today's the day for **${feeName}**. Thanks for keeping the team running!`,
      }),
    ),
    Match.when(
      'overdue_3d',
      (): EmbedCopy => ({
        title: 'Payment overdue',
        color: COLOR_RED,
        description: (feeName) =>
          `**${feeName}** is 3 days overdue. No worries — settle it when you can.`,
      }),
    ),
    Match.when(
      'overdue_10d',
      (): EmbedCopy => ({
        title: 'Payment overdue',
        color: COLOR_RED,
        description: (feeName) => `Reminder: **${feeName}** is 10 days overdue.`,
      }),
    ),
    Match.when(
      'overdue_21d',
      (): EmbedCopy => ({
        title: 'Payment overdue',
        color: COLOR_RED,
        description: (feeName) => `Heads up: **${feeName}** is 21 days overdue.`,
      }),
    ),
    Match.exhaustive,
  );

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const buildPaymentReminderEmbed = (
  event: FinanceRpcEvents.PaymentReminderReadyEvent,
): Discord.RichEmbed => {
  const { kind, fee_name, amount_minor, paid_minor, currency, effective_due_at } = event;

  const outstanding = Math.max(0, amount_minor - paid_minor);
  const amountStr = formatMoney(amount_minor, currency, 'en');
  const outstandingStr = formatMoney(outstanding, currency, 'en');
  const dueStr = toDiscordDateTimestamp(effective_due_at);

  const { title, color, description } = copyForKind(kind);

  const fields: Discord.RichEmbedField[] = [
    { name: 'Fee', value: fee_name, inline: true },
    { name: 'Amount', value: amountStr, inline: true },
    { name: 'Due', value: dueStr, inline: true },
    { name: 'Outstanding', value: outstandingStr, inline: true },
  ];

  const footer: Discord.RichEmbedFooter = { text: 'Sideline' };

  return { title, color, description: description(fee_name), fields, footer };
};
