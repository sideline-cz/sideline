// Unit tests for the WeeklyChallenge domain schema.

import { describe, expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import {
  WeeklyChallengeDescription,
  WeeklyChallengeKind,
  WeeklyChallengeTitle,
} from '~/models/WeeklyChallenge.js';

const decodeSync = Schema.decodeUnknownSync;

describe('WeeklyChallengeKind', () => {
  it('accepts "throwing"', () => {
    expect(decodeSync(WeeklyChallengeKind)('throwing')).toBe('throwing');
  });

  it('accepts "sport"', () => {
    expect(decodeSync(WeeklyChallengeKind)('sport')).toBe('sport');
  });

  it('rejects an unknown kind', () => {
    expect(() => decodeSync(WeeklyChallengeKind)('throw')).toThrow();
    expect(() => decodeSync(WeeklyChallengeKind)('hazení')).toThrow();
    expect(() => decodeSync(WeeklyChallengeKind)('')).toThrow();
  });
});

describe('WeeklyChallengeTitle', () => {
  it('accepts a normal title', () => {
    expect(decodeSync(WeeklyChallengeTitle)('200 forehandů a 200 backhandů')).toBe(
      '200 forehandů a 200 backhandů',
    );
  });

  it('rejects an empty string', () => {
    expect(() => decodeSync(WeeklyChallengeTitle)('')).toThrow();
  });

  it('rejects a title over 120 characters', () => {
    const tooLong = 'x'.repeat(121);
    expect(() => decodeSync(WeeklyChallengeTitle)(tooLong)).toThrow();
  });

  it('accepts a title at the 120-character boundary', () => {
    const atLimit = 'x'.repeat(120);
    expect(decodeSync(WeeklyChallengeTitle)(atLimit)).toBe(atLimit);
  });
});

describe('WeeklyChallengeDescription', () => {
  it('accepts a normal description', () => {
    expect(decodeSync(WeeklyChallengeDescription)('30 opakování ve dvojici.')).toBe(
      '30 opakování ve dvojici.',
    );
  });

  it('rejects a description over 2000 characters', () => {
    const tooLong = 'x'.repeat(2001);
    expect(() => decodeSync(WeeklyChallengeDescription)(tooLong)).toThrow();
  });

  it('accepts a description at the 2000-character boundary', () => {
    const atLimit = 'x'.repeat(2000);
    expect(decodeSync(WeeklyChallengeDescription)(atLimit)).toBe(atLimit);
  });
});
