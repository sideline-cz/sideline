import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import {
  buildSpayd,
  formatAmountMajor,
  SPAYD_MSG_MAX_LENGTH,
  toSpaydMessage,
  transliterateToSpaydAscii,
} from '~/models/Spayd.js';

const IBAN = 'CZ7120100000002703474850';

// ---------------------------------------------------------------------------
// buildSpayd
// ---------------------------------------------------------------------------

describe('buildSpayd', () => {
  it('minimal ACC-only payload', () => {
    expect(buildSpayd({ acc: IBAN })).toEqual(Option.some(`SPD*1.0*ACC:${IBAN}*`));
  });

  it('full key order, ending with a trailing *', () => {
    const result = buildSpayd({
      acc: IBAN,
      amountMinor: 50000n,
      currency: 'CZK',
      recipientName: 'SK ULTIMATE',
      date: '20260301',
      message: 'PRISPEVEK',
      variableSymbol: '12345',
      specificSymbol: '999',
      constantSymbol: '0308',
    });
    expect(result).toEqual(
      Option.some(
        `SPD*1.0*ACC:${IBAN}*AM:500.00*CC:CZK*RN:SK ULTIMATE*DT:20260301*MSG:PRISPEVEK*X-VS:12345*X-SS:999*X-KS:0308*`,
      ),
    );
  });

  it('RN is emitted when provided, omitted when absent', () => {
    const withRn = buildSpayd({ acc: IBAN, recipientName: 'CLUB' });
    const withoutRn = buildSpayd({ acc: IBAN });
    expect(Option.isSome(withRn) && withRn.value.includes('RN:')).toBe(true);
    expect(Option.isSome(withoutRn) && withoutRn.value.includes('RN:')).toBe(false);
  });

  it('escapes * as %2A, leaves : unescaped, and escapes % as %25', () => {
    const result = buildSpayd({ acc: IBAN, message: 'A*B:C%D' });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toContain('MSG:A%2AB:C%25D');
    }
  });

  it('never emits a CRC32 key', () => {
    const result = buildSpayd({ acc: IBAN, amountMinor: 100n, currency: 'CZK' });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) expect(result.value).not.toContain('CRC32');
  });

  it('DT must be exactly 8 characters', () => {
    expect(buildSpayd({ acc: IBAN, date: '2026030' })).toEqual(Option.none());
    expect(buildSpayd({ acc: IBAN, date: '202603011' })).toEqual(Option.none());
  });

  it('CC must be exactly 3 characters', () => {
    expect(buildSpayd({ acc: IBAN, currency: 'CZ' })).toEqual(Option.none());
    expect(buildSpayd({ acc: IBAN, currency: 'CZKK' })).toEqual(Option.none());
  });

  it('a budgeted MSG (<=60 after toSpaydMessage) is accepted by buildSpayd', () => {
    const longName = 'Příspěvek na podzimní soustředění a turnaj v Poděbradech pro celý tým 2026';
    const budgeted = toSpaydMessage(longName, SPAYD_MSG_MAX_LENGTH);
    expect(budgeted.length).toBeLessThanOrEqual(60);
    expect(buildSpayd({ acc: IBAN, message: budgeted })).not.toEqual(Option.none());
  });

  it('a direct 61-character MSG is still rejected (the guard for a caller who skips the budget step)', () => {
    const tooLong = 'A'.repeat(61);
    expect(buildSpayd({ acc: IBAN, message: tooLong })).toEqual(Option.none());
  });

  it('X-VS over 10 characters is a hard reject, never truncated', () => {
    expect(buildSpayd({ acc: IBAN, variableSymbol: '12345678901' })).toEqual(Option.none());
  });
});

// ---------------------------------------------------------------------------
// formatAmountMajor
// ---------------------------------------------------------------------------

describe('formatAmountMajor', () => {
  it('50000n -> 500.00', () => {
    expect(formatAmountMajor(50000n)).toEqual(Option.some('500.00'));
  });

  it('1n -> 0.01', () => {
    expect(formatAmountMajor(1n)).toEqual(Option.some('0.01'));
  });

  it('999999999n -> 9999999.99', () => {
    expect(formatAmountMajor(999_999_999n)).toEqual(Option.some('9999999.99'));
  });

  it('1000000000n is rejected (exceeds the 10-char AM limit)', () => {
    expect(formatAmountMajor(1_000_000_000n)).toEqual(Option.none());
  });

  it('renders a value a float /100 would corrupt exactly', () => {
    // 30n / 100 as a float is 0.30000000000000004 in JS; the bigint path must render "0.30".
    expect(formatAmountMajor(30n)).toEqual(Option.some('0.30'));
  });
});

// ---------------------------------------------------------------------------
// toSpaydMessage
// ---------------------------------------------------------------------------

describe('toSpaydMessage', () => {
  it('truncates a 62-character Czech fee name on a word boundary, never rejects', () => {
    const longName = 'Příspěvek na podzimní soustředění a turnaj v Poděbradech pro tým X';
    expect(longName.length).toBeGreaterThan(60);
    const result = toSpaydMessage(longName);
    expect(result.length).toBeLessThanOrEqual(60);
    expect(result.endsWith('.')).toBe(true);
    // The cut point must land on a space, not mid-word.
    expect(result.slice(0, -1).endsWith(' ')).toBe(false);
  });

  it('leaves short text untouched (transliterated only)', () => {
    expect(toSpaydMessage('Clenske prispevky')).toBe('CLENSKE PRISPEVKY');
  });
});

// ---------------------------------------------------------------------------
// transliterateToSpaydAscii
// ---------------------------------------------------------------------------

describe('transliterateToSpaydAscii', () => {
  it('Příspěvek za podzim — Novák -> PRISPEVEK ZA PODZIM - NOVAK', () => {
    expect(transliterateToSpaydAscii('Příspěvek za podzim — Novák')).toBe(
      'PRISPEVEK ZA PODZIM - NOVAK',
    );
  });

  it('strips every Czech diacritic and uppercases', () => {
    // Commas are outside the allowed charset [0-9A-Z $%*+\-./:] and are stripped, along with
    // every other disallowed character, after diacritics are removed.
    const result = transliterateToSpaydAscii('Žluťoučký kůň, Ďáblice, Ťuhýk');
    expect(result).toMatch(/^[0-9A-Z $%*+\-./:]*$/);
    expect(result).toBe('ZLUTOUCKY KUN DABLICE TUHYK');
  });

  it('maps ellipsis to ... ; quotes are normalised then stripped (not in the allowed charset)', () => {
    const result = transliterateToSpaydAscii('„citace“ …');
    expect(result).toMatch(/^[0-9A-Z $%*+\-./:]*$/);
    expect(result).toBe('CITACE ...');
  });

  it('strips emoji and Cyrillic entirely', () => {
    const result = transliterateToSpaydAscii('Плата 💰 fee');
    expect(result).toMatch(/^[0-9A-Z $%*+\-./:]*$/);
    expect(result).toBe('FEE');
  });
});
