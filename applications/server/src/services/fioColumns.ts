/**
 * Plan `.work-plans/fio-transaction-matching.md` §3.2 ("Fio response schema (`fioColumns.ts`) —
 * every trap"). Pure decoder for a Fio `accountStatement` JSON payload. This is the module where
 * silent corruption lives: Fio's JSON omits keys, nulls values, pads strings with whitespace,
 * encodes dates as "YYYY-MM-DD+ZZZZ" (no colon in the offset — `new Date()` chokes on it), and
 * ships amounts as bare floats.
 *
 * Every column is modelled optional AND nullable; `sanitize` trims and blanks-to-null every
 * string value before it reaches an `Option`.
 */
import { Data, Effect, Option } from 'effect';

export class FioDecodeError extends Data.TaggedError('FioDecodeError')<{
  readonly message: string;
}> {}

export interface FioMovement {
  readonly fioMovementId: string; // BIGINT-safe — decoded as a string, never a bare number
  readonly bookedOn: string; // 'YYYY-MM-DD', sliced from "YYYY-MM-DD+ZZZZ"
  readonly amountMinor: number; // signed integer minor units
  readonly currency: string;
  readonly variableSymbol: Option.Option<string>; // column5
  readonly constantSymbol: Option.Option<string>; // column4
  readonly specificSymbol: Option.Option<string>; // column6
  readonly counterpartyAccount: Option.Option<string>; // column2
  readonly counterpartyBankCode: Option.Option<string>; // column3
  readonly counterpartyName: Option.Option<string>; // column10
  readonly counterpartyBankName: Option.Option<string>; // column12
  readonly counterpartyBic: Option.Option<string>; // column26
  readonly payerReference: Option.Option<string>; // column27
  readonly messageForRecipient: Option.Option<string>; // column16
  readonly userIdentification: Option.Option<string>; // column7
  readonly txType: Option.Option<string>; // column8
  readonly enteredBy: Option.Option<string>; // column9
  readonly specification: Option.Option<string>; // column18
  readonly comment: Option.Option<string>; // column25
  readonly orderId: Option.Option<string>; // column17 — NOT unique, never reconciled on
  readonly raw: unknown; // the untouched transaction object
}

export interface FioStatementInfo {
  readonly accountId: Option.Option<string>;
  readonly bankId: Option.Option<string>;
  readonly currency: string;
  readonly iban: Option.Option<string>;
  readonly bic: Option.Option<string>;
  readonly openingBalanceMinor: number;
  readonly closingBalanceMinor: number;
  readonly dateStart: string; // 'YYYY-MM-DD'
  readonly dateEnd: string;
  readonly idFrom: Option.Option<string>;
  readonly idTo: Option.Option<string>;
  readonly idLastDownload: Option.Option<string>;
}

export interface FioDecodedStatement {
  readonly info: FioStatementInfo;
  readonly movements: ReadonlyArray<FioMovement>;
}

// ---------------------------------------------------------------------------
// Sanitisers
// ---------------------------------------------------------------------------

/** `sanitize(v) = typeof v === 'string' ? (v.trim() || null) : v` — runs on every column's
 * `.value` before it reaches an `Option`. A whitespace-only string decodes to `Option.none()`; a
 * padded string decodes to the TRIMMED value. */
const sanitize = (v: unknown): unknown => (typeof v === 'string' ? v.trim() || null : v);

/** Some string-shaped columns (e.g. `column17`/order id) arrive as a bare JSON number — coerce to
 * string for the purposes of a string column, distinct from the amount/id columns that are
 * decoded numerically on purpose. */
const sanitizeToString = (v: unknown): unknown => {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return sanitize(v);
};

const fail = (message: string): Effect.Effect<never, FioDecodeError> =>
  Effect.fail(new FioDecodeError({ message }));

// ---------------------------------------------------------------------------
// Column value access
// ---------------------------------------------------------------------------

interface ColumnRaw {
  readonly value: unknown;
}

const isColumnRaw = (v: unknown): v is ColumnRaw =>
  typeof v === 'object' && v !== null && 'value' in v;

/** An absent column key OR a `null` `.value` OR a whitespace-only string all decode to `None`. */
const optionalStringColumn = (tx: Record<string, unknown>, key: string): Option.Option<string> => {
  const col = tx[key];
  if (!isColumnRaw(col)) return Option.none();
  const sanitized = sanitizeToString(col.value);
  return typeof sanitized === 'string' ? Option.some(sanitized) : Option.none();
};

/** Numeric columns come through as a bare JS number in the raw JSON `.value` — never a string. */
const requiredNumberColumn = (
  tx: Record<string, unknown>,
  key: string,
  label: string,
): Effect.Effect<number, FioDecodeError> => {
  const col = tx[key];
  if (!isColumnRaw(col)) return fail(`${label} (${key}) is missing`);
  const value = col.value;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`${label} (${key}) is not a finite number`);
  }
  return Effect.succeed(value);
};

// ---------------------------------------------------------------------------
// column0 — "YYYY-MM-DD+ZZZZ" (no colon in the offset) -> slice(0, 10)
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}/;

const decodeBookingDate = (
  tx: Record<string, unknown>,
  key: string,
): Effect.Effect<string, FioDecodeError> => {
  const col = tx[key];
  if (!isColumnRaw(col)) return fail(`${key} is missing`);
  const value = sanitize(col.value);
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    // Rejects the stale 2012 epoch-millis PDF example shape (a bare number) outright — never
    // coerced.
    return fail(`${key} is not a "YYYY-MM-DD+ZZZZ" date string`);
  }
  return Effect.succeed(value.slice(0, 10));
};

// ---------------------------------------------------------------------------
// column1 — amount (a JSON float with variable decimals). Math.round(v * 100) is itself a float
// round-trip, so assert it lands within 0.001 of an integer minor-unit value rather than
// silently rounding a 3-decimal FX artefact.
// ---------------------------------------------------------------------------

const decodeAmountMinor = (
  tx: Record<string, unknown>,
  key: string,
): Effect.Effect<number, FioDecodeError> =>
  requiredNumberColumn(tx, key, 'amount').pipe(
    Effect.flatMap((v) => {
      const rounded = Math.round(v * 100);
      if (Math.abs(v * 100 - rounded) > 0.001) {
        return fail(`${key} has more than 2 decimal places — refusing to silently round`);
      }
      return Effect.succeed(rounded);
    }),
  );

// ---------------------------------------------------------------------------
// column22 — fio_movement_id, up to 11 digits. Always decoded as a string (BIGINT-safe).
// ---------------------------------------------------------------------------

const decodeMovementId = (
  tx: Record<string, unknown>,
  key: string,
): Effect.Effect<string, FioDecodeError> => {
  const col = tx[key];
  if (!isColumnRaw(col)) return fail(`${key} is missing`);
  const value = col.value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Effect.succeed(String(Math.trunc(value)));
  }
  if (typeof value === 'string' && value.trim() !== '') {
    return Effect.succeed(value.trim());
  }
  return fail(`${key} is not a valid movement id`);
};

// ---------------------------------------------------------------------------
// One transaction
// ---------------------------------------------------------------------------

// column14 (currency) is occasionally absent on an individual movement row even though it is
// always present on the statement's `info` block — an individual movement is always in the
// account's own currency, so `info.currency` is a safe, meaningful fallback rather than a
// decode failure.
const decodeMovement = (
  tx: unknown,
  statementCurrency: string,
): Effect.Effect<FioMovement, FioDecodeError> => {
  if (typeof tx !== 'object' || tx === null) {
    return fail('a transaction entry is not an object');
  }
  const row = tx as Record<string, unknown>;
  return Effect.Do.pipe(
    Effect.bind('fioMovementId', () => decodeMovementId(row, 'column22')),
    Effect.bind('bookedOn', () => decodeBookingDate(row, 'column0')),
    Effect.bind('amountMinor', () => decodeAmountMinor(row, 'column1')),
    Effect.let('currency', () =>
      Option.getOrElse(optionalStringColumn(row, 'column14'), () => statementCurrency),
    ),
    Effect.map(({ fioMovementId, bookedOn, amountMinor, currency }) => ({
      fioMovementId,
      bookedOn,
      amountMinor,
      currency,
      variableSymbol: optionalStringColumn(row, 'column5'),
      constantSymbol: optionalStringColumn(row, 'column4'),
      specificSymbol: optionalStringColumn(row, 'column6'),
      counterpartyAccount: optionalStringColumn(row, 'column2'),
      counterpartyBankCode: optionalStringColumn(row, 'column3'),
      counterpartyName: optionalStringColumn(row, 'column10'),
      counterpartyBankName: optionalStringColumn(row, 'column12'),
      counterpartyBic: optionalStringColumn(row, 'column26'),
      payerReference: optionalStringColumn(row, 'column27'),
      messageForRecipient: optionalStringColumn(row, 'column16'),
      userIdentification: optionalStringColumn(row, 'column7'),
      txType: optionalStringColumn(row, 'column8'),
      enteredBy: optionalStringColumn(row, 'column9'),
      specification: optionalStringColumn(row, 'column18'),
      comment: optionalStringColumn(row, 'column25'),
      orderId: optionalStringColumn(row, 'column17'),
      raw: tx,
    })),
  );
};

// ---------------------------------------------------------------------------
// info block
// ---------------------------------------------------------------------------

const optionalInfoString = (info: Record<string, unknown>, key: string): Option.Option<string> => {
  const sanitized = sanitizeToString(info[key]);
  return typeof sanitized === 'string' ? Option.some(sanitized) : Option.none();
};

const requiredInfoString = (
  info: Record<string, unknown>,
  key: string,
): Effect.Effect<string, FioDecodeError> =>
  Option.match(optionalInfoString(info, key), {
    onNone: () => fail(`info.${key} is missing or blank`),
    onSome: (v) => Effect.succeed(v),
  });

const requiredInfoNumber = (
  info: Record<string, unknown>,
  key: string,
): Effect.Effect<number, FioDecodeError> => {
  const value = info[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fail(`info.${key} is not a finite number`);
  }
  return Effect.succeed(value);
};

const requiredInfoDate = (
  info: Record<string, unknown>,
  key: string,
): Effect.Effect<string, FioDecodeError> => {
  const value = sanitize(info[key]);
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return fail(`info.${key} is not a "YYYY-MM-DD+ZZZZ" date string`);
  }
  return Effect.succeed(value.slice(0, 10));
};

const roundToMinor = (v: number, key: string): Effect.Effect<number, FioDecodeError> => {
  const rounded = Math.round(v * 100);
  if (Math.abs(v * 100 - rounded) > 0.001) {
    return fail(`info.${key} has more than 2 decimal places — refusing to silently round`);
  }
  return Effect.succeed(rounded);
};

const decodeInfo = (info: unknown): Effect.Effect<FioStatementInfo, FioDecodeError> => {
  if (typeof info !== 'object' || info === null) {
    return fail('accountStatement.info is not an object');
  }
  const row = info as Record<string, unknown>;
  return Effect.Do.pipe(
    Effect.bind('currency', () => requiredInfoString(row, 'currency')),
    Effect.bind('openingBalance', () => requiredInfoNumber(row, 'openingBalance')),
    Effect.bind('closingBalance', () => requiredInfoNumber(row, 'closingBalance')),
    Effect.bind('openingBalanceMinor', ({ openingBalance }) =>
      roundToMinor(openingBalance, 'openingBalance'),
    ),
    Effect.bind('closingBalanceMinor', ({ closingBalance }) =>
      roundToMinor(closingBalance, 'closingBalance'),
    ),
    Effect.bind('dateStart', () => requiredInfoDate(row, 'dateStart')),
    Effect.bind('dateEnd', () => requiredInfoDate(row, 'dateEnd')),
    Effect.map(({ currency, openingBalanceMinor, closingBalanceMinor, dateStart, dateEnd }) => ({
      accountId: optionalInfoString(row, 'accountId'),
      bankId: optionalInfoString(row, 'bankId'),
      currency,
      iban: optionalInfoString(row, 'iban'),
      bic: optionalInfoString(row, 'bic'),
      openingBalanceMinor,
      closingBalanceMinor,
      dateStart,
      dateEnd,
      idFrom: optionalInfoString(row, 'idFrom'),
      idTo: optionalInfoString(row, 'idTo'),
      idLastDownload: optionalInfoString(row, 'idLastDownload'),
    })),
  );
};

// ---------------------------------------------------------------------------
// Top-level decoder
// ---------------------------------------------------------------------------

export const decodeFioStatement = (
  raw: unknown,
): Effect.Effect<FioDecodedStatement, FioDecodeError> => {
  if (typeof raw !== 'object' || raw === null || !('accountStatement' in raw)) {
    return fail('response is not a Fio accountStatement payload');
  }
  const accountStatement = (raw as { readonly accountStatement: unknown }).accountStatement;
  if (typeof accountStatement !== 'object' || accountStatement === null) {
    return fail('accountStatement is not an object');
  }
  const { info, transactionList } = accountStatement as {
    readonly info: unknown;
    readonly transactionList: unknown;
  };

  // transactionList AND transactionList.transaction are INDEPENDENTLY nullable.
  const transactions: ReadonlyArray<unknown> =
    transactionList === null || transactionList === undefined
      ? []
      : (() => {
          const list = (transactionList as { readonly transaction: unknown }).transaction;
          return list === null || list === undefined ? [] : (list as ReadonlyArray<unknown>);
        })();

  return Effect.Do.pipe(
    Effect.bind('infoDecoded', () => decodeInfo(info)),
    Effect.bind('movements', ({ infoDecoded }) =>
      Effect.forEach(transactions, (tx) => decodeMovement(tx, infoDecoded.currency)),
    ),
    Effect.map(({ infoDecoded, movements }) => ({ info: infoDecoded, movements })),
  );
};
