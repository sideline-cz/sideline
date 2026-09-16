import { describe, expect, it } from '@effect/vitest';
import { isValidIco } from '~/models/CzIco.js';

describe('isValidIco', () => {
  it('accepts verified vectors', () => {
    expect(isValidIco('61858374')).toBe(true); // sum 183, r 7, c 4
    expect(isValidIco('45244782')).toBe(true); // sum 152, r 9, c 2
    expect(isValidIco('45274649')).toBe(true); // sum 156, r 2, c 9
  });

  // A checksum test with a single negative case passes against a `return true` stub — mutate
  // every one of the eight positions independently.
  it('rejects a mutated digit at each of the eight positions', () => {
    const valid = '61858374';
    for (let position = 0; position < valid.length; position++) {
      const digit = Number(valid[position]);
      const mutatedDigit = (digit + 1) % 10;
      const mutated = valid.slice(0, position) + String(mutatedDigit) + valid.slice(position + 1);
      expect(isValidIco(mutated)).toBe(false);
    }
  });

  // The two edge cases a hand-written branch ladder gets wrong: r=0 (check digit 1) and r=10
  // (check digit 1) — this is exactly why the implementation must be the single expression
  // `(11 - r) mod 10`.
  it('accepts an IČO whose r = 0 (check digit 1)', () => {
    // digits 1..7 = 0000000 -> sum = 0 -> r = 0 -> check = (11-0) mod 10 = 1
    expect(isValidIco('00000001')).toBe(true);
  });

  it('accepts an IČO whose r = 10 (check digit 1)', () => {
    // digits 1..7 = 0,0,0,0,0,0,5 -> sum = 2*5 (d7's weight is 2) = 10 -> r = 10
    // -> check = (11-10) mod 10 = 1.
    expect(isValidIco('00000051')).toBe(true);
  });

  it('rejects shapes that are not exactly 8 digits', () => {
    expect(isValidIco('6185837')).toBe(false); // 7 digits
    expect(isValidIco('618583740')).toBe(false); // 9 digits
    expect(isValidIco('6185837a')).toBe(false); // non-numeric
    expect(isValidIco('')).toBe(false); // empty
  });
});
