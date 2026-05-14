import type { FeeAssignment } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import type { Locale } from '~/locale.js';
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
  locale: Locale;
}): FinanceStatusEmbedResult => {
  const { assignments, locale } = opts;

  const outstanding = assignments.filter(
    (a) => a.status === 'pending' || a.status === 'partial' || a.status === 'overdue',
  );

  const hasOverdue = outstanding.some((a) => a.status === 'overdue');
  const hasPartialOrPending = outstanding.some(
    (a) => a.status === 'partial' || a.status === 'pending',
  );

  const isAllClear = outstanding.length === 0;

  const color = isAllClear
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

  if (isAllClear) {
    const embed: Discord.RichEmbed = {
      title,
      color,
      description: m.bot_finance_status_summaryClear({}, { locale }),
      footer,
    };
    return { embeds: [embed] };
  }

  // Group currencies to compute totals for the summary line
  const currencyTotals = new Map<string, number>();
  for (const a of outstanding) {
    const remaining = a.dueMinor - a.paidMinor;
    currencyTotals.set(a.currency, (currencyTotals.get(a.currency) ?? 0) + remaining);
  }

  const totalStr = Array.from(currencyTotals.entries())
    .map(([currency, minor]) => formatMoney(minor, currency, locale))
    .join(' + ');

  const description = m.bot_finance_status_summary(
    { amount: totalStr, count: String(outstanding.length) },
    { locale },
  );

  const fields = buildFields(assignments, locale);

  const embed: Discord.RichEmbed = {
    title,
    color,
    description,
    fields,
    footer,
  };

  return { embeds: [embed] };
};
