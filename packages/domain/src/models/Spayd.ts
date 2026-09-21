import { Option } from 'effect';

/**
 * SPAYD (Short Payment Descriptor, v1.0) string builder for Czech payment QR codes.
 *
 * Pure algorithm module — see `packages/domain/AGENTS.md` ("Pure Algorithm Modules").
 *
 * Format: `SPD*1.0*KEY:value*KEY:value*` — only `ACC` is mandatory; keys are uppercase; there is
 * no whitespace around values. Key emission order (this module's own convention, mirroring the
 * SPAYD 1.0 spec's documented key list): `ACC, AM, CC, RN, DT, MSG, X-VS, X-SS, X-KS`.
 *
 * Guaranteed-supported keys: `ACC`, `AM`, `CC`, `DT`, `MSG`, `X-VS`, `X-SS`, `X-KS`. `RN` is NOT
 * guaranteed by every reader — it is emitted for readability only; reconciliation is always done
 * on `X-VS`.
 *
 * | Key | Limit |
 * |---|---|
 * | `ACC` | 46 (`IBAN` or `IBAN+BIC`) |
 * | `AM` | 10 chars, max 2 dp, `.` separator, max `9999999.99`; both decimals always present |
 * | `CC` | exactly 3 |
 * | `DT` | exactly 8, `YYYYMMDD` |
 * | `MSG` | 60 |
 * | `X-VS` / `X-SS` / `X-KS` | 10 integer chars |
 *
 * Over-length values are silently truncated FROM THE LEFT by some readers, so limits are
 * enforced here rather than trusted to the reader. `MSG` is budgeted and truncated by
 * `toSpaydMessage` BEFORE `buildSpayd` is called — a fee name that does not fit must never turn
 * into "no QR at all" (see `toSpaydMessage`'s doc comment). `buildSpayd` itself still rejects an
 * over-length `MSG` — that path exists only to catch a future caller that skips the budget step.
 * `X-VS` is always a hard reject over 10 chars: a truncated variable symbol is a mis-credited
 * payment, which is strictly worse than no QR.
 *
 * Escaping is targeted percent-encoding: `%` → `%25` (must run first, it is the escape
 * character itself) and `*` → `%2A` (the field separator). `:` is explicitly left unescaped.
 * `CRC32` is deliberately never emitted — rarely produced, widely ignored by readers, and a
 * mis-canonicalised one is worse than none.
 *
 * Amount formatting never round-trips through a float — see `formatAmountMajor`.
 */

export const SPAYD_ACC_MAX_LENGTH = 46;
export const SPAYD_AM_MAX_LENGTH = 10;
export const SPAYD_AM_MAX_MINOR = 999_999_999n; // 9 999 999.99 in major units
export const SPAYD_CC_LENGTH = 3;
export const SPAYD_DT_LENGTH = 8;
export const SPAYD_MSG_MAX_LENGTH = 60;
export const SPAYD_SYMBOL_MAX_LENGTH = 10; // X-VS / X-SS / X-KS

const DT_PATTERN = /^[0-9]{8}$/;
const SYMBOL_PATTERN = /^[0-9]+$/;

/**
 * Formats a signed minor-unit `bigint` amount as SPAYD's `AM` value — always both decimals
 * (`500.00`, never `500` or `500.0`) — WITHOUT ever round-tripping through a `Number` division,
 * which would render e.g. `0.30000000000000004` instead of `0.30`.
 *
 * Returns `Option.none()` for negative amounts or amounts that would exceed `AM`'s 10-character
 * limit (`9999999.99`).
 */
export const formatAmountMajor = (minor: bigint): Option.Option<string> => {
  if (minor < 0n || minor > SPAYD_AM_MAX_MINOR) return Option.none();

  const major = minor / 100n;
  const cents = (minor % 100n).toString().padStart(2, '0');
  return Option.some(`${major}.${cents}`);
};

const QUOTE_AND_DASH_MAP: ReadonlyArray<readonly [RegExp, string]> = [
  [/[–—]/g, '-'],
  [/[„“”]/g, '"'],
  [/[‘’]/g, "'"],
  [/…/g, '...'],
];

const DIACRITIC_PATTERN = /\p{Diacritic}/gu;
const DISALLOWED_CHARS_PATTERN = /[^0-9A-Z $%*+\-./:]/g;
const MULTIPLE_SPACES_PATTERN = / {2,}/g;

/**
 * Transliterates arbitrary text to the uppercase-ASCII alphabet SPAYD readers expect.
 *
 * Any lowercase letter or diacritic drops the QR out of alphanumeric encoding mode into byte
 * mode, and byte-mode payloads are dramatically larger for the same visible text (a 117-char
 * payload is QR version 5 alphanumeric but version 7 byte-mode) — accented text belongs in the
 * PDF/email body, where the font is controlled, not in the SPAYD payload.
 *
 * Pipeline: NFD-decompose → strip combining diacritical marks → uppercase → explicitly map
 * non-decomposable punctuation (en/em dash → `-`, curly/low quotes → straight quotes,
 * ellipsis → `...`) → strip anything outside `[0-9A-Z $%*+\-./:]` → collapse runs of spaces →
 * trim.
 */
export const transliterateToSpaydAscii = (s: string): string => {
  let result = s.normalize('NFD').replace(DIACRITIC_PATTERN, '').toUpperCase();
  for (const [pattern, replacement] of QUOTE_AND_DASH_MAP) {
    result = result.replaceAll(pattern, replacement);
  }
  return result.replace(DISALLOWED_CHARS_PATTERN, '').replace(MULTIPLE_SPACES_PATTERN, ' ').trim();
};

/**
 * Transliterates `text` and budgets it to `maxLen` characters (default `SPAYD_MSG_MAX_LENGTH`)
 * for SPAYD's `MSG` key — truncating on a word boundary with a one-character budget reserved for
 * a trailing `.` marker, NEVER rejecting. A 62-character fee name must still produce a scannable
 * QR; rejecting it would recreate the exact "paid without a VS" failure this feature exists to
 * prevent.
 */
export const toSpaydMessage = (text: string, maxLen: number = SPAYD_MSG_MAX_LENGTH): string => {
  const transliterated = transliterateToSpaydAscii(text);
  if (transliterated.length <= maxLen) return transliterated;

  const budget = Math.max(0, maxLen - 1);
  const cut = transliterated.slice(0, budget);
  const lastSpace = cut.lastIndexOf(' ');
  const truncated = lastSpace > 0 ? cut.slice(0, lastSpace) : cut;

  return `${truncated.trimEnd()}.`;
};

const encodeSpaydValue = (value: string): string =>
  value.replaceAll('%', '%25').replaceAll('*', '%2A');

export interface SpaydInput {
  /** The IBAN, or `IBAN+BIC`. Mandatory. */
  readonly acc: string;
  /** Signed-positive minor-unit amount; formatted through `formatAmountMajor`. */
  readonly amountMinor?: bigint | undefined;
  /** Exactly 3 characters (e.g. `CZK`). */
  readonly currency?: string | undefined;
  /** `YYYYMMDD`. */
  readonly date?: string | undefined;
  /** Already budgeted via `toSpaydMessage` — this function still enforces the 60-char cap. */
  readonly message?: string | undefined;
  /** Up to 10 integer characters. Reconciliation key. */
  readonly variableSymbol?: string | undefined;
  readonly specificSymbol?: string | undefined;
  readonly constantSymbol?: string | undefined;
  /** NOT a guaranteed-supported key — emitted for readability only. */
  readonly recipientName?: string | undefined;
}

/**
 * Builds a `SPD*1.0*...*` SPAYD string. Returns `Option.none()` when any provided field fails
 * its own limit or shape check (see the module doc comment's limit table) — `ACC` is the only
 * mandatory field.
 */
export const buildSpayd = (input: SpaydInput): Option.Option<string> => {
  if (input.acc.length === 0 || input.acc.length > SPAYD_ACC_MAX_LENGTH) return Option.none();

  const pairs: Array<string> = [`ACC:${encodeSpaydValue(input.acc)}`];

  if (input.amountMinor !== undefined) {
    const amount = formatAmountMajor(input.amountMinor);
    if (Option.isNone(amount)) return Option.none();
    pairs.push(`AM:${amount.value}`);
  }

  if (input.currency !== undefined) {
    if (input.currency.length !== SPAYD_CC_LENGTH) return Option.none();
    pairs.push(`CC:${encodeSpaydValue(input.currency)}`);
  }

  if (input.recipientName !== undefined && input.recipientName.length > 0) {
    pairs.push(`RN:${encodeSpaydValue(input.recipientName)}`);
  }

  if (input.date !== undefined) {
    if (!DT_PATTERN.test(input.date)) return Option.none();
    pairs.push(`DT:${input.date}`);
  }

  if (input.message !== undefined && input.message.length > 0) {
    if (input.message.length > SPAYD_MSG_MAX_LENGTH) return Option.none();
    pairs.push(`MSG:${encodeSpaydValue(input.message)}`);
  }

  const symbolFields: ReadonlyArray<readonly [string, string | undefined]> = [
    ['X-VS', input.variableSymbol],
    ['X-SS', input.specificSymbol],
    ['X-KS', input.constantSymbol],
  ];
  for (const [key, value] of symbolFields) {
    if (value === undefined || value.length === 0) continue;
    if (value.length > SPAYD_SYMBOL_MAX_LENGTH || !SYMBOL_PATTERN.test(value)) return Option.none();
    pairs.push(`${key}:${value}`);
  }

  return Option.some(`SPD*1.0*${pairs.join('*')}*`);
};
