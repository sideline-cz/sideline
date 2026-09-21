/**
 * Recovers a handful of fields from a rendered SPAYD payload string for the payment-reminder
 * DM's plain-text fallback block (T10, design §6.4 "Can't scan it? Enter it by hand").
 *
 * This is deliberately NOT a general SPAYD parser and NOT the inverse of `@sideline/domain`'s
 * `buildSpayd` — `Finance/GetPaymentQr` (`packages/domain/src/rpc/finance/FinanceRpcModels.ts`)
 * returns only the rendered `spayd` string and the PNG, never a structured breakdown, so the
 * fallback block's account/amount/VS/message values are read back out of the one string the bot
 * actually has. Unescaping mirrors `Spayd.ts`'s `encodeSpaydValue` (`%` and `*` only).
 */

import { Option } from 'effect';

const SPAYD_PREFIX = 'SPD*1.0*';

const unescapeSpaydValue = (value: string): string =>
  value.replaceAll('%2A', '*').replaceAll('%25', '%');

/** Returns `Option.none()` when `key` is absent from the payload. */
export const parseSpaydField = (spayd: string, key: string): Option.Option<string> => {
  const body = spayd.startsWith(SPAYD_PREFIX) ? spayd.slice(SPAYD_PREFIX.length) : spayd;
  const prefix = `${key}:`;
  for (const part of body.split('*')) {
    if (part.startsWith(prefix)) {
      return Option.some(unescapeSpaydValue(part.slice(prefix.length)));
    }
  }
  return Option.none();
};
