import { describe, expect, it } from 'vitest';
import { formatMinorToMajor, parseAmount } from './parseAmount.js';

describe('parseAmount', () => {
  it('parses "15.50" with CZK → 1550', () => {
    expect(parseAmount('15.50', 'CZK')).toBe(1550);
  });

  it('parses "1" with EUR → 100', () => {
    expect(parseAmount('1', 'EUR')).toBe(100);
  });

  it('parses "100" with no currency → 10000 (defaults to 2 decimals)', () => {
    expect(parseAmount('100')).toBe(10000);
  });

  it('rounds "15.505" to 1551 (standard JS rounding)', () => {
    expect(parseAmount('15.505', 'CZK')).toBe(1551);
  });

  it('throws for empty string', () => {
    expect(() => parseAmount('')).toThrow('Amount is required');
  });

  it('throws for whitespace-only string', () => {
    expect(() => parseAmount('   ')).toThrow('Amount is required');
  });

  it('throws for zero', () => {
    expect(() => parseAmount('0')).toThrow('Amount must be greater than 0');
  });

  it('throws for negative number', () => {
    expect(() => parseAmount('-5')).toThrow('Amount must be greater than 0');
  });

  it('throws for non-numeric string', () => {
    expect(() => parseAmount('abc')).toThrow('Amount must be a number');
  });

  it('parses large amount correctly', () => {
    expect(parseAmount('2400', 'CZK')).toBe(240000);
  });

  it('uses 2 decimal places for unknown currency (default)', () => {
    expect(parseAmount('10', 'XYZ')).toBe(1000);
  });

  // A free membership plan is priced 0, so the plans form opts in. Negative and
  // non-numeric must still throw — allowZero widens exactly one value.
  it('accepts zero when allowZero is set', () => {
    expect(parseAmount('0', 'CZK', { allowZero: true })).toBe(0);
  });

  it('still throws for negative when allowZero is set', () => {
    expect(() => parseAmount('-5', 'CZK', { allowZero: true })).toThrow(
      'Amount must be greater than 0',
    );
  });

  it('still throws for non-numeric when allowZero is set', () => {
    expect(() => parseAmount('abc', 'CZK', { allowZero: true })).toThrow('Amount must be a number');
  });
});

describe('formatMinorToMajor', () => {
  it('round-trips through parseAmount for CZK', () => {
    const major = formatMinorToMajor(1550, 'CZK');
    expect(major).toBe('15.50');
    expect(parseAmount(major, 'CZK')).toBe(1550);
  });

  it('uses 2 decimal places for an unknown currency (default)', () => {
    expect(formatMinorToMajor(1000, 'XYZ')).toBe('10.00');
  });
});
