// TDD mode — written BEFORE the implementation exists.
// Tests will fail to import until ~/interactions/profile-complete.ts is created.
// Static top-of-file imports only (per AGENTS.md "Test File Imports — Static Only").
//
// Note on "Either": the test spec describes these helpers using generic FP "Either"
// terminology, but this repo's Effect v4 beta does not export an `Either` module —
// the equivalent is `Result<A, E>` (success type first, error type second; see
// node_modules/effect/src/Result.ts, and packages/domain/test/Achievement.test.ts's
// use of `Schema.decodeUnknownEffect(...).pipe(Effect.flip, ...)` for the closest
// existing convention). We therefore expect:
//   parseBirthDate: (raw: Option<string>) => Result<string, 'invalid'>
//   parseJerseyNumber: (raw: Option<string>) => Result<Option<number>, 'invalid'>
//   decodeGenderFromCustomId: (customId: string) => string
//
// vi.mock is hoisted before imports by Vitest. The factory mocks ~/env.js so
// that @t3-oss/env-core does not throw during module load, in case
// profile-complete.ts pulls it in transitively (matches poll.test.ts convention —
// the interaction handlers colocated with these pure helpers will need SyncRpc,
// which itself does not import env.js today, but this guards against future
// coupling the same way poll.test.ts already does).

import { Auth } from '@sideline/domain';
import { Option, Result } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import {
  decodeGenderFromCustomId,
  parseBirthDate,
  parseJerseyNumber,
} from '~/interactions/profile-complete.js';

vi.mock('~/env.js', () => ({
  env: new Proxy({} as Record<string, unknown>, {
    get: (_target: Record<string, unknown>, prop: string) => {
      if (prop === 'NODE_ENV') return 'test';
      if (prop === 'SERVER_URL') return 'http://localhost:3000';
      if (prop === 'APP_ENV') return 'test';
      if (prop === 'APP_ORIGIN') return 'localhost';
      if (prop === 'OTEL_EXPORTER_OTLP_ENDPOINT') return 'http://localhost:4318';
      if (prop === 'OTEL_SERVICE_NAME') return 'sideline-bot';
      if (prop === 'WEB_URL') return Option.none();
      return undefined;
    },
  }),
}));

// ---------------------------------------------------------------------------
// Date-boundary helpers
//
// Computed relative to the real current date (UTC — matches how a plain
// 'YYYY-MM-DD' string is parsed by `new Date(s)`) rather than hardcoded years,
// so these keep testing the right boundary no matter when the suite runs.
// Same methodology as packages/domain/test/CompleteMemberProfile.test.ts, which
// exercises the same Auth.MIN_AGE guard via Auth.BirthDateString directly —
// keeping both aligned means a regression shows up consistently in either file.
// ---------------------------------------------------------------------------

const pad2 = (n: number) => String(n).padStart(2, '0');
const nowUtc = new Date();
// Avoid constructing a Feb-29 date in a non-leap target year.
const todayMonth = pad2(nowUtc.getUTCMonth() + 1);
const todayDay =
  nowUtc.getUTCMonth() === 1 && nowUtc.getUTCDate() === 29 ? '28' : pad2(nowUtc.getUTCDate());
// Comfortably under MIN_AGE (not just off-by-one), so the "clearly too young"
// case can't be confused with the exact-boundary case below.
const UNDER_AGE_MARGIN_YEARS = 2;

// ---------------------------------------------------------------------------
// parseBirthDate
// ---------------------------------------------------------------------------

describe('parseBirthDate', () => {
  it('Some(valid date string) → Success with the same string', () => {
    const result = parseBirthDate(Option.some('1990-05-01'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe('1990-05-01');
  });

  it('None → Failure("invalid") — birth date is required, blank is not allowed', () => {
    const result = parseBirthDate(Option.none());
    expect(Result.isFailure(result)).toBe(true);
    expect(Option.getOrNull(Result.getFailure(result))).toBe('invalid');
  });

  it('Some("31/12/2005") — wrong format (not ISO) → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('31/12/2005'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("abc") — garbage string → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('abc'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("2000-13-40") — invalid month/day → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('2000-13-40'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("2005-02-30") — rolls over to 2005-03-02 → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('2005-02-30'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some(future date) → Failure("invalid")', () => {
    // Fixed, clearly-out-of-range constant (matches the convention already used
    // for "far future" dates elsewhere in this repo's test suite, e.g.
    // applications/server/test/EventRpc.test.ts's '2099-06-01T18:00:00Z').
    const result = parseBirthDate(Option.some('2099-01-01'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("1900-01-01") → Success (lower boundary — must not be off-by-one)', () => {
    const result = parseBirthDate(Option.some('1900-01-01'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe('1900-01-01');
  });

  it('Some("1899-12-31") — one day before the 1900-01-01 cutoff → Failure("invalid")', () => {
    const result = parseBirthDate(Option.some('1899-12-31'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it(`Some(date exactly MIN_AGE=${Auth.MIN_AGE} years ago today) → Success (upper boundary — must not be off-by-one)`, () => {
    const year = nowUtc.getUTCFullYear() - Auth.MIN_AGE;
    const dateString = `${year}-${todayMonth}-${todayDay}`;
    const result = parseBirthDate(Option.some(dateString));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Result.getOrThrow(result)).toBe(dateString);
  });

  it(`Some(date under MIN_AGE=${Auth.MIN_AGE} years ago) → Failure("invalid")`, () => {
    const year = nowUtc.getUTCFullYear() - (Auth.MIN_AGE - UNDER_AGE_MARGIN_YEARS);
    const result = parseBirthDate(Option.some(`${year}-${todayMonth}-${todayDay}`));
    expect(Result.isFailure(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// parseJerseyNumber
// ---------------------------------------------------------------------------

describe('parseJerseyNumber', () => {
  it('Some("10") → Success(Some(10))', () => {
    const result = parseJerseyNumber(Option.some('10'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(10);
  });

  it('Some("0") → Success(Some(0)) (lower boundary)', () => {
    const result = parseJerseyNumber(Option.some('0'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(0);
  });

  it('Some("99") → Success(Some(99)) (upper boundary)', () => {
    const result = parseJerseyNumber(Option.some('99'));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.getOrNull(Result.getOrThrow(result))).toBe(99);
  });

  it('None → Success(None) — no input means "leave unchanged"', () => {
    const result = parseJerseyNumber(Option.none());
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.isNone(Result.getOrThrow(result))).toBe(true);
  });

  it('Some("") → Success(None) — blank string also means "leave unchanged"', () => {
    const result = parseJerseyNumber(Option.some(''));
    expect(Result.isSuccess(result)).toBe(true);
    expect(Option.isNone(Result.getOrThrow(result))).toBe(true);
  });

  it('Some("100") — above upper boundary → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('100'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("-1") — below lower boundary → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('-1'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("1.5") — not an integer → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('1.5'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("abc") — not a number at all → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('abc'));
    expect(Result.isFailure(result)).toBe(true);
  });

  it('Some("007") — leading zeros not accepted as canonical input → Failure("invalid")', () => {
    const result = parseJerseyNumber(Option.some('007'));
    expect(Result.isFailure(result)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// decodeGenderFromCustomId — profile-complete:{gender}
// ---------------------------------------------------------------------------

describe('decodeGenderFromCustomId', () => {
  it.each([
    ['male', 'male'],
    ['female', 'female'],
    ['other', 'other'],
  ] as const)('decodeGenderFromCustomId("profile-complete:%s") → "%s"', (input, expected) => {
    expect(decodeGenderFromCustomId(`profile-complete:${input}`)).toBe(expected);
  });

  it('decodeGenderFromCustomId on a malformed custom_id (no ":" segment) → undefined, does not throw', () => {
    expect(decodeGenderFromCustomId('profile-complete')).toBeUndefined();
  });
});
