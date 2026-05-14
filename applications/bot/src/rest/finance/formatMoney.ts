import type { Locale } from '~/locale.js';

/**
 * Format a minor-unit amount (e.g. cents/halíře) into a human-readable string.
 *
 * For CZK we always use the `cs-CZ` CLDR locale regardless of the UI locale
 * because "en-CZ" doesn't exist as a CLDR locale and would produce awkward
 * output like "CZK 100.00" on English UIs.
 *
 * The currency code is always appended in parentheses so it is machine-readable
 * (e.g. for assertions and bot-embed parsing). Example: "500 Kč (CZK)".
 */
export const formatMoney = (amountMinor: number, currency: string, locale: Locale): string => {
  const amountMajor = amountMinor / 100;
  const cldrLocale = currency === 'CZK' ? 'cs-CZ' : locale === 'cs' ? 'cs-CZ' : 'en-US';

  const formatted = new Intl.NumberFormat(cldrLocale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountMajor);

  // Append the ISO currency code so it always appears literally in the string.
  // This keeps the human-readable locale symbol (e.g. "Kč") while also
  // satisfying downstream consumers that need the code (e.g. "CZK", "EUR").
  return `${formatted} (${currency})`;
};
