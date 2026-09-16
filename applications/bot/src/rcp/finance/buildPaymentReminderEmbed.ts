import type { FinanceRpcEvents, PaymentReminder } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { Match, Option } from 'effect';
import type { Locale } from '~/locale.js';
import { discordTimestampFromEpochSeconds } from '~/rest/discordTimestamp.js';
import { formatMoney } from '~/rest/finance/formatMoney.js';
import { parseSpaydField } from './parseSpaydField.js';

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

const COLOR_BLUE = 0x5865f2;
const COLOR_YELLOW = 0xfee75c;
const COLOR_RED = 0xed4245;

/** Days-overdue for each overdue kind — the three kinds share one title (`overdueTitle`) but
 * still need distinct body copy, per §10.7's single `bot_payment_reminder_overdueTitle` key. */
const OVERDUE_DAYS: Record<'overdue_3d' | 'overdue_10d' | 'overdue_21d', number> = {
  overdue_3d: 3,
  overdue_10d: 10,
  overdue_21d: 21,
};

type EmbedCopy = { readonly title: string; readonly color: number; readonly body: string };

const copyForKind = (
  kind: PaymentReminder.PaymentReminderKind,
  feeName: string,
  locale: Locale,
): EmbedCopy =>
  Match.value(kind).pipe(
    // [D15b / T10c] Fired once at assignment creation — a neutral first-contact message, not a
    // nag (design §6.4 head, Q9).
    Match.when(
      'assigned',
      (): EmbedCopy => ({
        title: m.bot_payment_reminder_assignedTitle({}, { locale }),
        color: COLOR_BLUE,
        body: m.bot_payment_reminder_assignedBody({ feeName }, { locale }),
      }),
    ),
    Match.when(
      'due_in_3d',
      (): EmbedCopy => ({
        title: m.bot_payment_reminder_dueIn3dTitle({}, { locale }),
        color: COLOR_BLUE,
        body: m.bot_payment_reminder_dueIn3dBody({ feeName }, { locale }),
      }),
    ),
    Match.when(
      'due_today',
      (): EmbedCopy => ({
        title: m.bot_payment_reminder_dueTodayTitle({}, { locale }),
        color: COLOR_YELLOW,
        body: m.bot_payment_reminder_dueTodayBody({ feeName }, { locale }),
      }),
    ),
    Match.when(
      'overdue_3d',
      (k): EmbedCopy => ({
        title: m.bot_payment_reminder_overdueTitle({}, { locale }),
        color: COLOR_RED,
        body: m.bot_payment_reminder_overdueBody(
          { feeName, days: String(OVERDUE_DAYS[k]) },
          { locale },
        ),
      }),
    ),
    Match.when(
      'overdue_10d',
      (k): EmbedCopy => ({
        title: m.bot_payment_reminder_overdueTitle({}, { locale }),
        color: COLOR_RED,
        body: m.bot_payment_reminder_overdueBody(
          { feeName, days: String(OVERDUE_DAYS[k]) },
          { locale },
        ),
      }),
    ),
    Match.when(
      'overdue_21d',
      (k): EmbedCopy => ({
        title: m.bot_payment_reminder_overdueTitle({}, { locale }),
        color: COLOR_RED,
        body: m.bot_payment_reminder_overdueBody(
          { feeName, days: String(OVERDUE_DAYS[k]) },
          { locale },
        ),
      }),
    ),
    Match.exhaustive,
  );

// ---------------------------------------------------------------------------
// QR fallback block
// ---------------------------------------------------------------------------

/**
 * The manual-entry block a payer copies into their banking app when they can't scan the QR
 * (design §6.4). Values are read back out of the SPAYD payload (`parseSpaydField`) rather than
 * recomputed, so the block can never drift from what the QR itself encodes — including the
 * uppercase-ASCII `MSG`, which is shown here VERBATIM (not re-accented): a payer typing it by
 * hand into their bank's own free-text field sees exactly what the QR would have submitted.
 */
const buildFallbackBlock = (spayd: string, currency: string, locale: Locale): string => {
  const account = Option.getOrElse(parseSpaydField(spayd, 'ACC'), () => '—');
  const variableSymbol = Option.getOrElse(parseSpaydField(spayd, 'X-VS'), () => '—');
  const message = Option.getOrElse(parseSpaydField(spayd, 'MSG'), () => '—');
  const amountMajor = Option.getOrElse(parseSpaydField(spayd, 'AM'), () => '');
  const currencySuffix = currency === 'CZK' ? 'Kč' : currency;
  const amount =
    amountMajor.length === 0 ? '—' : `${amountMajor.replace('.', ',')} ${currencySuffix}`;

  const lines = [
    `${m.bot_payment_reminder_fallbackAccount({}, { locale })}: ${account}`,
    `${m.bot_payment_reminder_fallbackAmount({}, { locale })}: ${amount}`,
    `${m.bot_payment_reminder_fallbackVs({}, { locale })}: ${variableSymbol}`,
    `${m.bot_payment_reminder_fallbackMessage({}, { locale })}: ${message}`,
  ];

  return [m.bot_payment_reminder_fallbackTitle({}, { locale }), '```', ...lines, '```'].join('\n');
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** The QR half of the reminder — `Option.none()` when no QR could be built (T10: no bank
 * config, the member has no variable symbol, or the RPC failed) and the reminder degrades to
 * exactly today's text-only embed rather than failing. */
export interface PaymentReminderQr {
  readonly spayd: string;
  readonly imageUrl: string;
}

export const buildPaymentReminderEmbed = (
  event: FinanceRpcEvents.PaymentReminderReadyEvent,
  locale: Locale,
  qr: Option.Option<PaymentReminderQr>,
): Discord.RichEmbed => {
  const { kind, fee_name, amount_minor, paid_minor, currency, effective_due_at } = event;

  const outstanding = Math.max(0, amount_minor - paid_minor);
  const amountStr = formatMoney(amount_minor, currency, locale);
  const outstandingStr = formatMoney(outstanding, currency, locale);
  const dueStr = discordTimestampFromEpochSeconds(
    Math.floor(new Date(effective_due_at).getTime() / 1000),
    'D',
  );

  const { title, color, body } = copyForKind(kind, fee_name, locale);

  const description = Option.match(qr, {
    onNone: () => body,
    onSome: ({ spayd }) =>
      [
        body,
        m.bot_payment_reminder_qrHint({}, { locale }),
        buildFallbackBlock(spayd, currency, locale),
        m.bot_payment_reminder_vsWarning({}, { locale }),
      ].join('\n\n'),
  });

  // Design §6.4: dropping `Fee` (now the title / the bolded name in `body`) makes room for a
  // fifth field (VS) without an awkward 3+2 grid — Částka / Splatnost / Variabilní symbol / Zbývá.
  // The VS field only exists when there is a QR to match it to.
  const fields: Array<Discord.RichEmbedField> = [
    { name: m.bot_payment_reminder_amount({}, { locale }), value: amountStr, inline: true },
    { name: m.bot_payment_reminder_due({}, { locale }), value: dueStr, inline: true },
    ...Option.match(qr, {
      onNone: (): Array<Discord.RichEmbedField> => [],
      onSome: ({ spayd }): Array<Discord.RichEmbedField> => [
        {
          name: m.bot_payment_reminder_vs({}, { locale }),
          value: Option.getOrElse(parseSpaydField(spayd, 'X-VS'), () => '—'),
          inline: true,
        },
      ],
    }),
    {
      name: m.bot_payment_reminder_outstanding({}, { locale }),
      value: outstandingStr,
      inline: true,
    },
  ];

  const footer: Discord.RichEmbedFooter = { text: 'Sideline' };

  return {
    title,
    color,
    description,
    fields,
    ...Option.match(qr, {
      onNone: () => ({}),
      onSome: ({ imageUrl }) => ({ image: { url: imageUrl } }),
    }),
    footer,
  };
};

/** Single link button — "Moje platby" — per design §6.4 ("two-plus buttons would trigger the
 * row-width ellipsis problem on a phone"). Omitted entirely when `WEB_URL` is unset. */
export const buildPaymentReminderComponents = (
  teamId: string,
  webUrl: Option.Option<string>,
  locale: Locale,
): ReadonlyArray<Discord.ActionRowComponentForMessageRequest> =>
  Option.match(webUrl, {
    onNone: (): ReadonlyArray<Discord.ActionRowComponentForMessageRequest> => [],
    onSome: (url): ReadonlyArray<Discord.ActionRowComponentForMessageRequest> => [
      UI.row([
        UI.button({
          style: Discord.ButtonStyleTypes.LINK,
          label: m.bot_payment_reminder_button({}, { locale }),
          url: `${url.replace(/\/$/, '')}/teams/${teamId}/my-payments`,
        }),
      ]),
    ],
  });
