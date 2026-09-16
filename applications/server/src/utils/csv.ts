/**
 * D8 — pure CSV formatting for the bank-transactions export. No Effect, no DB — see
 * `test/csv.test.ts` for the exact contract every export below implements.
 */

export const CSV_DELIMITER = ';';
export const CSV_BOM = '﻿';
export const CSV_LINE_ENDING = '\r\n';

/** First-character triggers that Excel/Sheets could interpret as the start of a formula. */
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);
/** Characters that force the whole field to be wrapped in quotes. */
const NEEDS_QUOTING_RE = /[;"\r\n]/;

/**
 * Quotes on `;`, `"`, or a newline (LF or CR); doubles an embedded `"`; prefixes a bare `'`
 * when the first character is one of `= + - @ TAB CR`, UNLESS `options.numeric` is true (amounts
 * legitimately start with `-`, and prefixing them would corrupt every outgoing row).
 */
export const escapeCsvField = (raw: string, options?: { readonly numeric?: boolean }): string => {
  const numeric = options?.numeric ?? false;
  const firstChar = raw.length > 0 ? raw[0] : undefined;
  const needsPrefix = !numeric && firstChar !== undefined && FORMULA_TRIGGER_CHARS.has(firstChar);
  const withPrefix = needsPrefix ? `'${raw}` : raw;

  if (!NEEDS_QUOTING_RE.test(withPrefix)) {
    return withPrefix;
  }
  return `"${withPrefix.replaceAll('"', '""')}"`;
};

/** `-13050 -> '-130,50'` — comma decimal separator, always two decimal places. */
export const formatCsvAmount = (minor: number): string => {
  const sign = minor < 0 ? '-' : '';
  const absMinor = Math.abs(minor);
  const major = Math.trunc(absMinor / 100);
  const cents = String(absMinor % 100).padStart(2, '0');
  return `${sign}${String(major)},${cents}`;
};

/**
 * BOM once at index 0, CRLF row endings, delimiter-joined. Performs NO escaping — callers pass
 * already-escaped fields via `escapeCsvField`.
 */
export const buildCsvDocument = (
  header: ReadonlyArray<string>,
  rows: ReadonlyArray<ReadonlyArray<string>>,
): string => {
  const lines = [header, ...rows].map((row) => row.join(CSV_DELIMITER));
  return CSV_BOM + lines.join(CSV_LINE_ENDING) + CSV_LINE_ENDING;
};
