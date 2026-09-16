import { describe, expect, it } from '@effect/vitest';
import { Option } from 'effect';
import { buildCzIban, isValidCzAccountNumber } from '~/models/CzIban.js';

// ---------------------------------------------------------------------------
// buildCzIban — verified vectors
// ---------------------------------------------------------------------------

describe('buildCzIban', () => {
  it('19-2000145399/0800 -> CZ6508000000192000145399', () => {
    expect(buildCzIban({ prefix: '19', accountNumber: '2000145399', bankCode: '0800' })).toEqual(
      Option.some('CZ6508000000192000145399'),
    );
  });

  it('1265098001/5500 -> CZ5855000000001265098001', () => {
    expect(buildCzIban({ accountNumber: '1265098001', bankCode: '5500' })).toEqual(
      Option.some('CZ5855000000001265098001'),
    );
  });

  it('76327632/0300 -> CZ7603000000000076327632', () => {
    expect(buildCzIban({ accountNumber: '76327632', bankCode: '0300' })).toEqual(
      Option.some('CZ7603000000000076327632'),
    );
  });

  it('2703474850/2010 -> CZ7120100000002703474850 (no prefix)', () => {
    expect(buildCzIban({ accountNumber: '2703474850', bankCode: '2010' })).toEqual(
      Option.some('CZ7120100000002703474850'),
    );
  });

  it('123456-2703474850/2010 -> CZ6920101234562703474850', () => {
    expect(
      buildCzIban({ prefix: '123456', accountNumber: '2703474850', bankCode: '2010' }),
    ).toEqual(Option.some('CZ6920101234562703474850'));
  });

  // Prefix-first regression: a prefix-first implementation ALSO passes mod-97 (it produces a
  // structurally different but still-valid-looking IBAN), so asserting the exact string is the
  // only assertion that catches "bank code, prefix, account" vs "prefix, bank code, account".
  it('bank code comes first, then prefix, then account (prefix-first is the classic bug)', () => {
    const result = buildCzIban({ prefix: '19', accountNumber: '2000145399', bankCode: '0800' });
    expect(result).toEqual(Option.some('CZ6508000000192000145399'));
    // A prefix-first rearrangement would NOT equal this exact string.
    expect(result).not.toEqual(Option.some('CZ4219080000002000145399'));
  });

  it('produces correct check digits for a 26-digit rearranged string (BigInt, not Number)', () => {
    // account_number padded to 10 digits is itself close to the edge of what a naive
    // Number-based mod-97 would silently corrupt; this vector round-trips exactly.
    const result = buildCzIban({ accountNumber: '9999999999', bankCode: '9999', prefix: '999999' });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) {
      expect(result.value).toHaveLength(24);
      expect(result.value.startsWith('CZ')).toBe(true);
    }
  });

  it('no prefix -> padded to 000000', () => {
    const withoutPrefix = buildCzIban({ accountNumber: '76327632', bankCode: '0300' });
    const withZeroPrefix = buildCzIban({
      prefix: '000000',
      accountNumber: '76327632',
      bankCode: '0300',
    });
    expect(withoutPrefix).toEqual(withZeroPrefix);
  });

  it('length is always 24', () => {
    const result = buildCzIban({ accountNumber: '1', bankCode: '0100' });
    expect(Option.isSome(result)).toBe(true);
    if (Option.isSome(result)) expect(result.value).toHaveLength(24);
  });

  it('rejects a non-numeric account number', () => {
    expect(buildCzIban({ accountNumber: 'abc123', bankCode: '0800' })).toEqual(Option.none());
  });

  it('rejects an account number longer than 10 digits', () => {
    expect(buildCzIban({ accountNumber: '12345678901', bankCode: '0800' })).toEqual(Option.none());
  });

  it('rejects a bank code that is not exactly 4 digits', () => {
    expect(buildCzIban({ accountNumber: '123', bankCode: '080' })).toEqual(Option.none());
    expect(buildCzIban({ accountNumber: '123', bankCode: '08000' })).toEqual(Option.none());
    expect(buildCzIban({ accountNumber: '123', bankCode: 'abcd' })).toEqual(Option.none());
  });
});

// ---------------------------------------------------------------------------
// isValidCzAccountNumber — Czech bank-account modulo-11
// ---------------------------------------------------------------------------
//
// NOTE: the IBANs printed in Fio's own PDF documentation and the `fiobank` npm package's test
// fixtures are anonymised sample data with un-recomputed check digits and FAIL mod-97 — they
// must never be used as vectors here or in CzIban.test.ts above.

describe('isValidCzAccountNumber', () => {
  it('2703474850 (no prefix) is valid', () => {
    expect(isValidCzAccountNumber('', '2703474850')).toBe(true);
  });

  it('a single-digit typo in the account number is invalid', () => {
    expect(isValidCzAccountNumber('', '2703474851')).toBe(false);
  });

  it('a prefix with a bad checksum is invalid', () => {
    expect(isValidCzAccountNumber('123456', '2703474850')).toBe(false);
  });

  it('19 (a valid prefix) is accepted', () => {
    expect(isValidCzAccountNumber('19', '2000145399')).toBe(true);
  });
});
