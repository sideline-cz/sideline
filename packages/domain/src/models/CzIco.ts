/**
 * The Czech IČO (organisation identifier) checksum — a DIFFERENT algorithm from the bank-account
 * modulo-11 checksum in `CzIban.ts` (different weights, different modulus handling).
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * ```
 * digits d1..d8
 * sum   = 8*d1 + 7*d2 + 6*d3 + 5*d4 + 4*d5 + 3*d6 + 2*d7
 * r     = sum mod 11
 * check = (11 - r) mod 10      -- must equal d8
 * ```
 *
 * The check digit is written as that single expression, NOT a branch ladder
 * (`if r = 0 then 1 elsif r = 1 then 0 ...`) — it is already correct for every edge case
 * (`r=0 → 1`, `r=1 → 0`, `r=10 → 1`) precisely because it is expressed this way, and a
 * hand-written ladder is exactly where those edge cases get typed wrong.
 *
 * Verified vectors: `61858374` (sum 183, r 7, c 4), `45244782` (sum 152, r 9, c 2),
 * `45274649` (sum 156, r 2, c 9).
 */

const ICO_WEIGHTS: ReadonlyArray<number> = [8, 7, 6, 5, 4, 3, 2];

export const isValidIco = (s: string): boolean => {
  if (!/^[0-9]{8}$/.test(s)) return false;

  const digits = s.split('').map(Number);
  const sum = ICO_WEIGHTS.reduce((acc, weight, i) => acc + weight * digits[i], 0);
  const r = sum % 11;
  const check = (11 - r) % 10;

  return check === digits[7];
};
