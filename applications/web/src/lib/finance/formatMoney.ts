/**
 * Formats a minor-unit amount (e.g. 150000 = 1500 CZK) as a localized currency string.
 *
 * CZK always uses cs-CZ locale because "en-CZ" doesn't exist in Intl and Czech
 * currency formatting (Kč, space-separated thousands) is always expected for CZK.
 */
export function formatMoney(amountMinor: number, currency: string, locale: 'en' | 'cs'): string {
  const fmtLocale = currency === 'CZK' ? 'cs-CZ' : locale === 'cs' ? 'cs-CZ' : 'en-US';
  return new Intl.NumberFormat(fmtLocale, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  }).format(amountMinor / 100);
}
