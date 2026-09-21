import { Option } from 'effect';

/**
 * Czech IBAN construction and the Czech bank-account modulo-11 checksum.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * ## IBAN construction (`buildCzIban`)
 *
 * ```
 * BBAN  = bankCode(4, zero-padded) + prefix(6, zero-padded) + accountNumber(10, zero-padded)
 * check = 98 - (BigInt(BBAN + "1235" + "00") % 97n)   // "CZ" -> C=12, Z=35
 * IBAN  = "CZ" + String(check).padStart(2, "0") + BBAN   // length 24
 * ```
 *
 * **Bank code FIRST, then prefix, then account** — prefix-first is the classic bug (see the
 * paired test's "prefix-first regression" case). `BigInt` is mandatory: the rearranged numeric
 * string is 26 digits and overflows `Number`'s safe integer range.
 *
 * Verified vectors (do NOT use the IBANs printed in Fio's own PDF or the `fiobank` npm
 * package's fixtures as test vectors — they are anonymised data with un-recomputed check
 * digits and fail mod-97):
 *   - `19-2000145399/0800` → `CZ6508000000192000145399`
 *   - `1265098001/5500` → `CZ5855000000001265098001`
 *   - `76327632/0300` → `CZ7603000000000076327632`
 *   - `2703474850/2010` → `CZ7120100000002703474850`
 *   - `123456-2703474850/2010` → `CZ6920101234562703474850`
 *
 * ## Account modulo-11 checksum (`isValidCzAccountNumber`)
 *
 * Weights `[10, 5, 8, 4, 2, 1]` (prefix, zero-padded to 6 digits) and
 * `[6, 3, 7, 9, 10, 5, 8, 4, 2, 1]` (account number, zero-padded to 10 digits) are paired
 * left-to-right with the zero-padded digit string (the padding is on the left, so the last
 * weight in each array always lands on the units digit) — each weighted sum must be
 * `≡ 0 (mod 11)`, checked independently for the prefix and the account number.
 */

const DIGITS_PATTERN = /^[0-9]+$/;

const isDigits = (s: string): boolean => DIGITS_PATTERN.test(s);

export interface CzAccountIdentity {
  /** Up to 6 digits. Absent or empty means "no prefix" (padded to `000000`). */
  readonly prefix?: string | undefined;
  /** 1-10 digits. */
  readonly accountNumber: string;
  /** Exactly 4 digits. */
  readonly bankCode: string;
}

/**
 * Builds a Czech IBAN from a bank-code/prefix/account-number identity.
 *
 * Returns `Option.none()` when any part fails its shape check (non-numeric, account number
 * longer than 10 digits, prefix longer than 6 digits, or bank code not exactly 4 digits) —
 * this function does NOT run the modulo-11 checksum; see `isValidCzAccountNumber` for that.
 */
export const buildCzIban = (input: CzAccountIdentity): Option.Option<string> => {
  const prefix = input.prefix ?? '';
  const { accountNumber, bankCode } = input;

  if (prefix !== '' && (!isDigits(prefix) || prefix.length > 6)) return Option.none();
  if (!isDigits(accountNumber) || accountNumber.length === 0 || accountNumber.length > 10) {
    return Option.none();
  }
  if (!isDigits(bankCode) || bankCode.length !== 4) return Option.none();

  const bban = `${bankCode.padStart(4, '0')}${prefix.padStart(6, '0')}${accountNumber.padStart(10, '0')}`;
  const rearranged = BigInt(`${bban}123500`);
  const check = 98n - (rearranged % 97n);
  const checkDigits = check.toString().padStart(2, '0');

  return Option.some(`CZ${checkDigits}${bban}`);
};

const PREFIX_WEIGHTS: ReadonlyArray<number> = [10, 5, 8, 4, 2, 1];
const ACCOUNT_WEIGHTS: ReadonlyArray<number> = [6, 3, 7, 9, 10, 5, 8, 4, 2, 1];

const weightedSum = (paddedDigits: string, weights: ReadonlyArray<number>): number =>
  weights.reduce((sum, weight, i) => sum + weight * Number(paddedDigits[i] ?? '0'), 0);

/**
 * The Czech bank-account modulo-11 checksum — a DIFFERENT algorithm from the IČO checksum
 * (`CzIco.isValidIco`), which uses different weights and modulus handling.
 *
 * `prefix` may be `''` for "no prefix" (treated as `000000`, which trivially passes — a sum of
 * zero is `≡ 0 (mod 11)`).
 */
export const isValidCzAccountNumber = (prefix: string, accountNumber: string): boolean => {
  if (prefix !== '' && (!isDigits(prefix) || prefix.length > 6)) return false;
  if (!isDigits(accountNumber) || accountNumber.length === 0 || accountNumber.length > 10) {
    return false;
  }

  const paddedPrefix = prefix.padStart(6, '0');
  const paddedAccount = accountNumber.padStart(10, '0');

  return (
    weightedSum(paddedPrefix, PREFIX_WEIGHTS) % 11 === 0 &&
    weightedSum(paddedAccount, ACCOUNT_WEIGHTS) % 11 === 0
  );
};
