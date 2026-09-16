// TDD mode — tests written BEFORE `fioColumns.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §3.2 ("Fio response schema (`fioColumns.ts`) —
// every trap") / §7.1 tests 19-33. This is the module where silent corruption lives: Fio's JSON
// omits keys, nulls values, pads strings with whitespace, encodes dates as
// "YYYY-MM-DD+ZZZZ" (no colon in the offset — `new Date()` chokes on it), and ships amounts as
// bare floats.
//
// Contract this file pins down for `applications/server/src/services/fioColumns.ts`:
//
//   export class FioDecodeError extends Data.TaggedError('FioDecodeError')<{ message: string }> {}
//
//   export interface FioMovement {
//     fioMovementId: string;               // BIGINT-safe — decoded as a string, never a bare number
//     bookedOn: string;                    // 'YYYY-MM-DD', sliced from "YYYY-MM-DD+ZZZZ"
//     amountMinor: number;                 // signed integer minor units
//     currency: string;
//     variableSymbol: Option.Option<string>;      // column5
//     constantSymbol: Option.Option<string>;      // column4
//     specificSymbol: Option.Option<string>;      // column6
//     counterpartyAccount: Option.Option<string>; // column2
//     counterpartyBankCode: Option.Option<string>;// column3
//     counterpartyName: Option.Option<string>;    // column10
//     counterpartyBankName: Option.Option<string>;// column12
//     counterpartyBic: Option.Option<string>;     // column26
//     payerReference: Option.Option<string>;      // column27
//     messageForRecipient: Option.Option<string>; // column16
//     userIdentification: Option.Option<string>;  // column7
//     txType: Option.Option<string>;              // column8
//     enteredBy: Option.Option<string>;            // column9
//     specification: Option.Option<string>;        // column18
//     comment: Option.Option<string>;               // column25
//     orderId: Option.Option<string>;               // column17 — NOT unique, never reconciled on
//     raw: unknown;                                  // the untouched transaction object
//   }
//
//   export interface FioStatementInfo {
//     accountId: Option.Option<string>;
//     bankId: Option.Option<string>;
//     currency: string;
//     iban: Option.Option<string>;
//     bic: Option.Option<string>;
//     openingBalanceMinor: number;
//     closingBalanceMinor: number;
//     dateStart: string;   // 'YYYY-MM-DD'
//     dateEnd: string;
//     idFrom: Option.Option<string>;
//     idTo: Option.Option<string>;
//     idLastDownload: Option.Option<string>;
//   }
//
//   export interface FioDecodedStatement {
//     info: FioStatementInfo;
//     movements: ReadonlyArray<FioMovement>;
//   }
//
//   export const decodeFioStatement:
//     (raw: unknown) => Effect.Effect<FioDecodedStatement, FioDecodeError>
//
// `sanitize(v) = typeof v === 'string' ? (v.trim() || null) : v` runs on every column's `.value`
// before it reaches an `Option` — a whitespace-only string decodes to `Option.none()`, and a
// padded string like `" 12345 "` decodes to the TRIMMED value `'12345'`, never the padded one
// (otherwise VS matching fails on a padded VS that is otherwise a byte-for-byte match).

import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import { decodeFioStatement, type FioDecodeError } from '~/services/fioColumns.js';

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

interface FioColumnRaw {
  readonly value: unknown;
  readonly name: string;
  readonly id: number;
}

const col = (id: number, name: string, value: unknown): FioColumnRaw => ({ value, name, id });

/** A fully-populated transaction row, matching Fio's real column layout. */
const fullTransaction = (overrides: Record<string, FioColumnRaw | undefined> = {}) => {
  const base: Record<string, FioColumnRaw> = {
    column0: col(0, 'Datum', '2024-03-01+0100'),
    column1: col(1, 'Objem', -130.0),
    column2: col(2, 'Protiúčet', '2000145399'),
    column3: col(3, 'Kód banky', '0800'),
    column4: col(4, 'KS', '0308'),
    column5: col(5, 'VS', '12345'),
    column6: col(6, 'SS', '0'),
    column7: col(7, 'Uživatelská identifikace', 'Nákup'),
    column8: col(8, 'Typ', 'Platba kartou'),
    column9: col(9, 'Provedl', 'Jan Novák'),
    column10: col(10, 'Název protiúčtu', 'Jan Novák'),
    column12: col(12, 'Název banky', 'Česká spořitelna'),
    column14: col(14, 'Měna', 'CZK'),
    column16: col(16, 'Zpráva pro příjemce', 'Členský příspěvek'),
    column17: col(17, 'ID pokynu', 987654321),
    column18: col(18, 'Upřesnění', ''),
    column22: col(22, 'ID pohybu', 12345678901),
    column25: col(25, 'Komentář', ''),
    column26: col(26, 'BIC', 'GIBACZPX'),
    column27: col(27, 'Reference plátce', ''),
  };
  const merged: Record<string, FioColumnRaw | undefined> = { ...base, ...overrides };
  const out: Record<string, FioColumnRaw> = {};
  for (const [k, v] of Object.entries(merged)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
};

const statementWith = (
  transactions: ReadonlyArray<Record<string, FioColumnRaw>> | null,
  infoOverrides: Record<string, unknown> = {},
) => ({
  accountStatement: {
    info: {
      accountId: '2000145399',
      bankId: '0800',
      currency: 'CZK',
      iban: 'CZ6508000000192000145399',
      bic: 'GIBACZPX',
      openingBalance: 1000.5,
      closingBalance: 2000.75,
      dateStart: '2024-03-01+0100',
      dateEnd: '2024-03-31+0100',
      yearList: null,
      idList: null,
      idFrom: 12345678900,
      idTo: 12345678999,
      idLastDownload: null,
      ...infoOverrides,
    },
    transactionList: transactions === null ? null : { transaction: transactions },
  },
});

const decode = (raw: unknown) => Effect.result(decodeFioStatement(raw));

const expectFailure = async (raw: unknown) => {
  const result = await Effect.runPromise(decode(raw));
  expect(result._tag).toBe('Failure');
  if (result._tag === 'Failure') {
    expect((result.failure as FioDecodeError)._tag).toBe('FioDecodeError');
  }
};

// ---------------------------------------------------------------------------
// 19 — happy path decodes every mapped column
// ---------------------------------------------------------------------------

describe('decodeFioStatement — happy path', () => {
  it.effect('decodes every mapped column of a fully-populated transaction', () =>
    Effect.gen(function* () {
      const result = yield* decodeFioStatement(statementWith([fullTransaction()]));
      expect(result.movements).toHaveLength(1);
      const m = result.movements[0];
      if (m === undefined) throw new Error('expected a movement');

      expect(m.fioMovementId).toBe('12345678901');
      expect(m.bookedOn).toBe('2024-03-01');
      expect(m.amountMinor).toBe(-13000);
      expect(m.currency).toBe('CZK');
      expect(m.variableSymbol).toEqual(Option.some('12345'));
      expect(m.constantSymbol).toEqual(Option.some('0308'));
      expect(m.specificSymbol).toEqual(Option.some('0'));
      expect(m.counterpartyAccount).toEqual(Option.some('2000145399'));
      expect(m.counterpartyBankCode).toEqual(Option.some('0800'));
      expect(m.counterpartyName).toEqual(Option.some('Jan Novák'));
      expect(m.counterpartyBankName).toEqual(Option.some('Česká spořitelna'));
      expect(m.counterpartyBic).toEqual(Option.some('GIBACZPX'));
      expect(m.messageForRecipient).toEqual(Option.some('Členský příspěvek'));
      expect(m.userIdentification).toEqual(Option.some('Nákup'));
      expect(m.txType).toEqual(Option.some('Platba kartou'));
      expect(m.enteredBy).toEqual(Option.some('Jan Novák'));
      expect(m.orderId).toEqual(Option.some('987654321'));
    }),
  );
});

// ---------------------------------------------------------------------------
// 20 / 21 — transactionList and transactionList.transaction independently nullable
// ---------------------------------------------------------------------------

describe('decodeFioStatement — nullable transaction list', () => {
  it.effect('transactionList: null -> zero movements (not an error)', () =>
    Effect.gen(function* () {
      const result = yield* decodeFioStatement(statementWith(null));
      expect(result.movements).toEqual([]);
    }),
  );

  it.effect('transactionList.transaction: null -> zero movements', () =>
    Effect.gen(function* () {
      const raw = statementWith([]);
      (raw.accountStatement.transactionList as { transaction: unknown }).transaction = null;
      const result = yield* decodeFioStatement(raw);
      expect(result.movements).toEqual([]);
    }),
  );
});

// ---------------------------------------------------------------------------
// 22 / 23 / 24 / 25 — every column optional AND nullable, whitespace sanitised
// ---------------------------------------------------------------------------

describe('decodeFioStatement — optional/nullable columns', () => {
  it.effect('an absent column key -> Option.none()', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column5: undefined });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.variableSymbol).toEqual(Option.none());
    }),
  );

  it.effect('a present column with value: null -> Option.none()', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column5: col(5, 'VS', null) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.variableSymbol).toEqual(Option.none());
    }),
  );

  it.effect('a whitespace-only value " " -> Option.none()', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column5: col(5, 'VS', '   ') });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.variableSymbol).toEqual(Option.none());
    }),
  );

  it.effect('a padded value " 12345 " -> the TRIMMED value "12345"', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column5: col(5, 'VS', ' 12345 ') });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.variableSymbol).toEqual(Option.some('12345'));
    }),
  );

  it.effect('idFrom/idTo/idLastDownload null decode cleanly (31)', () =>
    Effect.gen(function* () {
      const result = yield* decodeFioStatement(
        statementWith([], { idFrom: null, idTo: null, idLastDownload: null }),
      );
      expect(result.info.idFrom).toEqual(Option.none());
      expect(result.info.idTo).toEqual(Option.none());
      expect(result.info.idLastDownload).toEqual(Option.none());
    }),
  );

  it.effect('info.iban decodes (32)', () =>
    Effect.gen(function* () {
      const result = yield* decodeFioStatement(statementWith([]));
      expect(result.info.iban).toEqual(Option.some('CZ6508000000192000145399'));
    }),
  );
});

// ---------------------------------------------------------------------------
// 26 — the "YYYY-MM-DD+ZZZZ" date form
// ---------------------------------------------------------------------------

describe('decodeFioStatement — booking date', () => {
  it.effect('column0 = "2024-03-01+0100" -> bookedOn "2024-03-01"', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column0: col(0, 'Datum', '2024-03-01+0100') });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.bookedOn).toBe('2024-03-01');
    }),
  );

  it('new Date("2024-03-01+0100") is Invalid Date — the reason a slice, not a Date parse, is used', () => {
    expect(Number.isNaN(new Date('2024-03-01+0100').getTime())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 27 / 28 — the float-to-minor conversion, with its precision assertion
// ---------------------------------------------------------------------------

describe('decodeFioStatement — amount decoding', () => {
  it.effect('-130.0 -> -13000', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column1: col(1, 'Objem', -130.0) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.amountMinor).toBe(-13000);
    }),
  );

  it.effect('13.5 -> 1350', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column1: col(1, 'Objem', 13.5) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.amountMinor).toBe(1350);
    }),
  );

  it.effect('0.07 -> 7', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column1: col(1, 'Objem', 0.07) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.amountMinor).toBe(7);
    }),
  );

  it('1.005 (a 3-decimal-place FX artefact) -> decode error, never a silent round', async () => {
    const tx = fullTransaction({ column1: col(1, 'Objem', 1.005) });
    await expectFailure(statementWith([tx]));
  });
});

// ---------------------------------------------------------------------------
// 29 — column22 survives exactly at 11 digits
// ---------------------------------------------------------------------------

describe('decodeFioStatement — fio_movement_id precision', () => {
  it.effect('column22 = 12345678901 (11 digits) survives exactly, as a string', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column22: col(22, 'ID pohybu', 12345678901) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.fioMovementId).toBe('12345678901');
    }),
  );
});

// ---------------------------------------------------------------------------
// 30 — reject the stale 2012 epoch-millis form
// ---------------------------------------------------------------------------

describe('decodeFioStatement — stale epoch-millis rejection', () => {
  it('an epoch-millis column0 (the stale 2012 PDF example shape) -> decode error, never coerced', async () => {
    // Fio's own (stale) PDF examples show column0 as an epoch-millis integer rather than the
    // "YYYY-MM-DD+ZZZZ" string every live response actually uses. The decoder must reject this
    // shape outright rather than silently accept a number where a date string is expected.
    const tx = fullTransaction({ column0: col(0, 'Datum', 1330556400000) });
    await expectFailure(statementWith([tx]));
  });
});

// ---------------------------------------------------------------------------
// 33 — openingBalance / closingBalance / dateStart / dateEnd decode and are exposed (D13)
// ---------------------------------------------------------------------------

describe('decodeFioStatement — statement period info (D13)', () => {
  it.effect('openingBalance/closingBalance/dateStart/dateEnd decode and are exposed', () =>
    Effect.gen(function* () {
      const result = yield* decodeFioStatement(
        statementWith([], {
          openingBalance: 1000.5,
          closingBalance: 2000.75,
          dateStart: '2024-03-01+0100',
          dateEnd: '2024-03-31+0100',
        }),
      );
      expect(result.info.openingBalanceMinor).toBe(100050);
      expect(result.info.closingBalanceMinor).toBe(200075);
      expect(result.info.dateStart).toBe('2024-03-01');
      expect(result.info.dateEnd).toBe('2024-03-31');
    }),
  );
});

// ---------------------------------------------------------------------------
// Negative amounts mean outgoing — sign survives untouched (D4's generated `direction`
// consumes this downstream; here we only assert the sign is preserved through decode).
// ---------------------------------------------------------------------------

describe('decodeFioStatement — signed amount survives', () => {
  it.effect('a positive amount stays positive', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column1: col(1, 'Objem', 500.0) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.amountMinor).toBe(50000);
    }),
  );

  it.effect('a negative amount stays negative', () =>
    Effect.gen(function* () {
      const tx = fullTransaction({ column1: col(1, 'Objem', -500.0) });
      const result = yield* decodeFioStatement(statementWith([tx]));
      expect(result.movements[0]?.amountMinor).toBe(-50000);
    }),
  );
});
