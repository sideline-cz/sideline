import type { FeeAssignment } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';
import { parseSpaydField } from '~/rcp/finance/parseSpaydField.js';
import { formatMoney } from '~/rest/finance/formatMoney.js';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const COLOR_GREEN = 0x2ecc71;
const COLOR_AMBER = 0xe67e22;
const COLOR_RED = 0xe74c3c;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** One currency's credit balance, as `Finance/GetMyStatus` reports it. */
export type CreditInput = {
  currency: string;
  balanceMinor: number;
};

/** The single standing code `/finance` shows. `spayd` is read only to tell the two QR states
 * apart: a payload carrying `AM` asks for a specific sum, one without it is the "any amount"
 * top-up code. The server decides which; the bot must not re-derive it from the fee list,
 * which does not know about credit the way the server does. */
export type StatusQrInput = {
  spayd: string;
  imageUrl: string;
};

export type AssignmentInput = {
  feeName: string;
  currency: string;
  dueMinor: number;
  paidMinor: number;
  status: FeeAssignment.FeeAssignmentStatus;
  effectiveDueAt: string | null;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const formatDueDate = (effectiveDueAt: string | null): string => {
  if (!effectiveDueAt) return '—';
  const date = new Date(effectiveDueAt);
  return date.toLocaleDateString('en-CA'); // YYYY-MM-DD
};

const overdueDays = (effectiveDueAt: string | null): number => {
  if (!effectiveDueAt) return 0;
  const due = new Date(effectiveDueAt);
  const now = new Date();
  return Math.max(0, Math.floor((now.getTime() - due.getTime()) / (1000 * 60 * 60 * 24)));
};

// ---------------------------------------------------------------------------
// Build embed fields for outstanding assignments
// ---------------------------------------------------------------------------

const buildFields = (
  assignments: ReadonlyArray<AssignmentInput>,
  locale: Locale,
): Array<Discord.RichEmbedField> => {
  const outstanding = assignments.filter(
    (a) => a.status === 'pending' || a.status === 'partial' || a.status === 'overdue',
  );

  return outstanding.map((assignment): Discord.RichEmbedField => {
    const remaining = assignment.dueMinor - assignment.paidMinor;
    const amountStr = formatMoney(
      remaining > 0 ? remaining : assignment.dueMinor,
      assignment.currency,
      locale,
    );
    const dateStr = formatDueDate(assignment.effectiveDueAt);

    if (assignment.status === 'overdue') {
      const days = overdueDays(assignment.effectiveDueAt);
      return {
        name: m.bot_finance_status_feeOverdue({ fee: assignment.feeName }, { locale }),
        value: m.bot_finance_status_feeOverdueValue(
          { amount: amountStr, date: dateStr, days: String(days) },
          { locale },
        ),
        inline: false,
      };
    }

    if (assignment.status === 'partial') {
      return {
        name: m.bot_finance_status_feePartial({ fee: assignment.feeName }, { locale }),
        value: m.bot_finance_status_feePartialValue(
          { amount: amountStr, date: dateStr },
          { locale },
        ),
        inline: false,
      };
    }

    // pending
    return {
      name: m.bot_finance_status_feePending({ fee: assignment.feeName }, { locale }),
      value: m.bot_finance_status_feePendingValue({ amount: amountStr, date: dateStr }, { locale }),
      inline: false,
    };
  });
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FinanceStatusEmbedResult = {
  embeds: Array<Discord.RichEmbed>;
};

export const buildFinanceStatusEmbed = (opts: {
  assignments: ReadonlyArray<AssignmentInput>;
  credits?: ReadonlyArray<CreditInput>;
  qr?: Option.Option<StatusQrInput>;
  locale: Locale;
}): FinanceStatusEmbedResult => {
  const { assignments, credits = [], qr = Option.none(), locale } = opts;

  const outstanding = assignments.filter(
    (a) => a.status === 'pending' || a.status === 'partial' || a.status === 'overdue',
  );

  // Net, per currency: credit is a real balance the server will spend on these very fees (the
  // auto-apply cron does it unattended), so a member holding 100 CZK against a 100 CZK fee owes
  // nothing and must not be told otherwise. The per-fee fields below stay GROSS — they are the
  // fees themselves, and credit belongs to the member, not to any one fee.
  const creditByCurrency = new Map(credits.map((c) => [c.currency, c.balanceMinor]));
  const netTotals = new Map<string, number>();
  for (const a of outstanding) {
    netTotals.set(a.currency, (netTotals.get(a.currency) ?? 0) + (a.dueMinor - a.paidMinor));
  }
  for (const [currency, gross] of netTotals) {
    netTotals.set(currency, Math.max(0, gross - (creditByCurrency.get(currency) ?? 0)));
  }

  const owedEntries = Array.from(netTotals.entries()).filter(([, minor]) => minor > 0);
  const isAllClear = outstanding.length === 0;
  // Open fees that credit already covers in full. Green like "all paid", because that is what it
  // means for the member — but the fee list stays, so they can still see what the credit went on.
  const isCoveredByCredit = !isAllClear && owedEntries.length === 0;

  const hasOverdue = outstanding.some((a) => a.status === 'overdue');
  const hasPartialOrPending = outstanding.some(
    (a) => a.status === 'partial' || a.status === 'pending',
  );

  const color =
    isAllClear || isCoveredByCredit
      ? COLOR_GREEN
      : hasOverdue
        ? COLOR_RED
        : hasPartialOrPending
          ? COLOR_AMBER
          : COLOR_GREEN;

  const title = m.bot_finance_status_title({}, { locale });
  const nowStr = new Date().toLocaleDateString(locale === 'cs' ? 'cs-CZ' : 'en-US');
  const footer: Discord.RichEmbedFooter = {
    text: m.bot_finance_status_footer({ date: nowStr }, { locale }),
  };

  // Which of the two codes the server sent, read off the payload rather than re-derived: `AM`
  // present means "pay exactly this", absent means "send whatever you like".
  const qrHint = Option.map(qr, ({ spayd }) =>
    Option.isSome(parseSpaydField(spayd, 'AM'))
      ? m.bot_finance_status_qrHint({}, { locale })
      : m.bot_finance_status_qrHintOpen({}, { locale }),
  );

  const creditLines = credits
    .filter((c) => c.balanceMinor > 0)
    .map((c) =>
      m.bot_finance_status_credit(
        { amount: formatMoney(c.balanceMinor, c.currency, locale) },
        { locale },
      ),
    );

  const summary = isAllClear
    ? m.bot_finance_status_summaryClear({}, { locale })
    : isCoveredByCredit
      ? m.bot_finance_status_summaryCovered({ count: String(outstanding.length) }, { locale })
      : m.bot_finance_status_summary(
          {
            amount: owedEntries
              .map(([currency, minor]) => formatMoney(minor, currency, locale))
              .join(' + '),
            count: String(outstanding.length),
          },
          { locale },
        );

  const description = [summary, ...creditLines, ...Option.toArray(qrHint)].join('\n\n');

  const embed: Discord.RichEmbed = {
    title,
    color,
    description,
    // No fields when there is nothing open — the all-clear embed stays a one-liner.
    ...(isAllClear ? {} : { fields: buildFields(assignments, locale) }),
    ...Option.match(qr, {
      onNone: () => ({}),
      onSome: ({ imageUrl }) => ({ image: { url: imageUrl } }),
    }),
    footer,
  };

  return { embeds: [embed] };
};
