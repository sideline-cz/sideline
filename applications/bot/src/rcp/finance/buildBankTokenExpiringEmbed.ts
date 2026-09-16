/**
 * T10b — the T-14 / T-7 / T-1 treasurer DM warning that a connected Fio token is about to
 * expire. Fio tokens last at most 180 days and only auto-renew when the treasurer logs into
 * Internetbanking/Smartbanking, so a dormant treasurer's token dies silently; this DM (plus the
 * settings-page banner) is the only defence. See design §6.5 and §2.5's `expiringSoon` banner —
 * the T−7 colour switch here matches the banner's own switch so the two surfaces never disagree
 * about how alarmed to be.
 */

import type { FinanceRpcEvents } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { UI } from 'dfx';
import * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';

const COLOR_AMBER = 0xfee75c;
const COLOR_RED = 0xed4245;

/** T−14 is amber ("plenty of time, but act"); T−7 and T−1 are red. */
const colorFor = (daysUntilExpiry: number): number =>
  daysUntilExpiry <= 7 ? COLOR_RED : COLOR_AMBER;

export const buildBankTokenExpiringEmbed = (
  event: FinanceRpcEvents.BankTokenExpiringEvent,
  locale: Locale,
): Discord.RichEmbed => ({
  title: m.bot_fio_tokenExpiring_title({ days: String(event.days_until_expiry) }, { locale }),
  color: colorFor(event.days_until_expiry),
  description: m.bot_fio_tokenExpiring_body({}, { locale }),
  footer: { text: 'Sideline' },
});

/** Single link button to the team's bank-connection settings card (design §2 — `FioBankCard`).
 * Omitted entirely when `WEB_URL` is unset, same as the payment reminder's "Moje platby" link. */
export const buildBankTokenExpiringComponents = (
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
          label: m.bot_fio_tokenExpiring_button({}, { locale }),
          url: `${url.replace(/\/$/, '')}/teams/${teamId}/settings`,
        }),
      ]),
    ],
  });
