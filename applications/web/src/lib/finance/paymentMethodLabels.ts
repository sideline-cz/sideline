import type { Payment } from '@sideline/domain';
import { tr } from '~/lib/translations.js';

/**
 * Closed copy for every `Payment.PaymentMethod` literal the domain currently knows about.
 * Keyed off the IMPORTED domain union (never re-declared here) per `AGENTS.md` → "Closed-Union
 * Copy Comes From An Explicit `Record`, Never A Computed Key": adding a fourth method literal to
 * the domain fails the web build here until its copy exists, instead of shipping a raw i18n key.
 */
const paymentMethodLabels: Record<Payment.PaymentMethod, () => string> = {
  cash: () => tr('finance_payment_method_cash'),
  bank_transfer: () => tr('finance_payment_method_bank_transfer'),
  // System-minted only (MemberCreditsRepository.settle) — never chosen by a human, but it
  // still needs copy for the payment history / settle-dialog void hint.
  credit: () => tr('finance_payment_method_credit'),
};

/**
 * `Object.entries` widens the key type to `string` without a cast — this is what lets a wire
 * value the domain hasn't been told about yet (`PaymentView.method` is a tolerant `Schema.String`,
 * see `packages/domain/src/api/FinanceApi.ts` §2.3) fail the `.get` lookup safely instead of
 * indexing an exhaustive `Record` with an unchecked key.
 */
const lookup: ReadonlyMap<string, () => string> = new Map(Object.entries(paymentMethodLabels));

/**
 * Resolves the display label for a payment's `method`. Never build the i18n key from `method`
 * (`` tr(`finance_payment_method_${method}`) `` is banned) — an unknown method (a rolling-deploy
 * window, or a future literal this build hasn't shipped copy for) renders the neutral fallback
 * instead of a raw key or a crash.
 */
export function paymentMethodLabel(method: string): string {
  const label = lookup.get(method);
  return label ? label() : tr('finance_payment_method_unknown');
}
