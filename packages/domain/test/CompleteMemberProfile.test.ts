// TDD mode — tests written BEFORE the bot/server implementation lands.
// The domain schemas exercised here (Auth.BirthDateString, TeamMember.JerseyNumber,
// GuildRpcGroup's Guild/CompleteMemberProfile payload) already exist in this package
// (see packages/domain/AGENTS.md — "Always rebuild packages/domain after changing
// domain source files"), so most of these assertions should already pass; they
// document and guard the contract the bot + server implementation task will rely on.
//
// Note on "Either": this repo's Effect v4 beta does not export an `Either` module —
// the equivalent is `Result<A, E>` (success type first, error type second; see
// node_modules/effect/src/Result.ts). We use `Schema.decodeUnknownEffect` +
// `Effect.result` to get a `Result` where relevant, matching the pattern already
// used in packages/domain/test/Achievement.test.ts's `AchievementSlug` regression
// test (`Schema.decodeUnknownEffect(...).pipe(Effect.flip, ...)`).

import { describe, expect, it } from '@effect/vitest';
import { Effect, Option, Schema } from 'effect';
import * as Auth from '~/api/Auth.js';
import { JerseyNumber } from '~/models/TeamMember.js';
import * as GuildRpcGroup from '~/rpc/guild/GuildRpcGroup.js';

const decodeSync = Schema.decodeUnknownSync;

// ---------------------------------------------------------------------------
// Date-boundary helpers
//
// Computed relative to the real current date (UTC — matches how a plain
// 'YYYY-MM-DD' string is parsed by `new Date(s)`) rather than hardcoded years,
// so these keep testing the right boundary no matter when the suite runs.
// Using the same UTC-based month/day for both the "just under" and "exactly at"
// cases keeps the two test files (this one and the bot's
// applications/bot/src/interactions/profile-complete.test.ts) aligned on one
// methodology.
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

describe('Auth.BirthDateString', () => {
  it('accepts a valid adult birth date (1990-05-01)', () => {
    expect(decodeSync(Auth.BirthDateString)('1990-05-01')).toBe('1990-05-01');
  });

  it('accepts exactly 1900-01-01 (lower boundary — must not be off-by-one)', () => {
    expect(decodeSync(Auth.BirthDateString)('1900-01-01')).toBe('1900-01-01');
  });

  it('rejects a future date', () => {
    expect(() => decodeSync(Auth.BirthDateString)('2099-01-01')).toThrow();
  });

  it('rejects a date before 1900-01-01', () => {
    expect(() => decodeSync(Auth.BirthDateString)('1899-12-31')).toThrow();
  });

  it(`accepts a birth date exactly MIN_AGE (${Auth.MIN_AGE}) years ago today (upper boundary — must not be off-by-one)`, () => {
    const year = nowUtc.getUTCFullYear() - Auth.MIN_AGE;
    const dateString = `${year}-${todayMonth}-${todayDay}`;
    expect(decodeSync(Auth.BirthDateString)(dateString)).toBe(dateString);
  });

  it(`rejects a date less than ${Auth.MIN_AGE} years ago (under MIN_AGE)`, () => {
    const year = nowUtc.getUTCFullYear() - (Auth.MIN_AGE - UNDER_AGE_MARGIN_YEARS);
    expect(() => decodeSync(Auth.BirthDateString)(`${year}-${todayMonth}-${todayDay}`)).toThrow();
  });

  it('rejects a non-date garbage string', () => {
    expect(() => decodeSync(Auth.BirthDateString)('not-a-date')).toThrow();
  });

  it('rejects a date that would roll over to a different day (2005-02-30)', () => {
    expect(() => decodeSync(Auth.BirthDateString)('2005-02-30')).toThrow();
  });

  it('rejects a non-ISO US-style date (08/24/2005)', () => {
    expect(() => decodeSync(Auth.BirthDateString)('08/24/2005')).toThrow();
  });

  it('rejects a non-ISO slash date (2005/08/24)', () => {
    expect(() => decodeSync(Auth.BirthDateString)('2005/08/24')).toThrow();
  });

  it('rejects an unpadded ISO-like date (2005-8-4)', () => {
    expect(() => decodeSync(Auth.BirthDateString)('2005-8-4')).toThrow();
  });
});

// ---------------------------------------------------------------------------
// TeamMember.JerseyNumber
// ---------------------------------------------------------------------------

describe('TeamMember.JerseyNumber', () => {
  it('accepts 0 (lower boundary)', () => {
    expect(decodeSync(JerseyNumber)(0)).toBe(0);
  });

  it('accepts 99 (upper boundary)', () => {
    expect(decodeSync(JerseyNumber)(99)).toBe(99);
  });

  it('rejects 100 (above upper boundary)', () => {
    expect(() => decodeSync(JerseyNumber)(100)).toThrow();
  });

  it('rejects -1 (below lower boundary)', () => {
    expect(() => decodeSync(JerseyNumber)(-1)).toThrow();
  });

  it('rejects 1.5 (not an integer)', () => {
    expect(() => decodeSync(JerseyNumber)(1.5)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Guild/CompleteMemberProfile RPC payload — permissive at the wire boundary
// ---------------------------------------------------------------------------

// Looked up (and narrowed) inside each test rather than at the `describe` body
// level — throwing while vitest is still collecting tests would abort
// collection for the whole file. `rpc._tag === 'Guild/CompleteMemberProfile'`
// also discriminates the `Rpc.Any` union down to the concrete member, so
// `rpc.payloadSchema` — and therefore every `decoded` value below — is
// concretely typed with no cast needed.
const getCompleteMemberProfileRpc = () => {
  const rpc = GuildRpcGroup.GuildRpcGroup.requests.get('Guild/CompleteMemberProfile');
  if (rpc === undefined || rpc._tag !== 'Guild/CompleteMemberProfile') {
    throw new Error('Guild/CompleteMemberProfile RPC is not registered on GuildRpcGroup');
  }
  return rpc;
};

describe('Guild/CompleteMemberProfile RPC payload — permissive boundary', () => {
  it('the RPC is registered under the Guild/ prefix', () => {
    expect(GuildRpcGroup.GuildRpcGroup.requests.get('Guild/CompleteMemberProfile')).toBeDefined();
  });

  it.effect(
    'decodes successfully even with a garbage birth_date string (no client-side throw)',
    () =>
      Schema.decodeUnknownEffect(getCompleteMemberProfileRpc().payloadSchema)({
        guild_id: '999999999999999999',
        discord_user_id: '111111111111111111',
        name: 'Jane Doe',
        birth_date: 'this-is-not-a-date',
        gender: 'male',
        jersey_number: null,
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(result._tag).toBe('Success');
          }),
        ),
        Effect.asVoid,
      ),
  );

  it.effect('jersey_number: null decodes to Option.none()', () =>
    Schema.decodeUnknownEffect(getCompleteMemberProfileRpc().payloadSchema)({
      guild_id: '999999999999999999',
      discord_user_id: '111111111111111111',
      name: 'Jane Doe',
      birth_date: '1990-05-01',
      gender: 'female',
      jersey_number: null,
    }).pipe(
      Effect.tap((decoded) =>
        Effect.sync(() => {
          expect(Option.isNone(decoded.jersey_number)).toBe(true);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('jersey_number: 10 decodes to Option.some(10)', () =>
    Schema.decodeUnknownEffect(getCompleteMemberProfileRpc().payloadSchema)({
      guild_id: '999999999999999999',
      discord_user_id: '111111111111111111',
      name: 'Jane Doe',
      birth_date: '1990-05-01',
      gender: 'other',
      jersey_number: 10,
    }).pipe(
      Effect.tap((decoded) =>
        Effect.sync(() => {
          expect(Option.getOrNull(decoded.jersey_number)).toBe(10);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it('rejects an invalid gender literal (schema-level, not the permissive birth_date field)', () => {
    expect(() =>
      decodeSync(getCompleteMemberProfileRpc().payloadSchema)({
        guild_id: '999999999999999999',
        discord_user_id: '111111111111111111',
        name: 'Jane Doe',
        birth_date: 'this-is-not-a-date',
        gender: 'not-a-real-gender',
        jersey_number: null,
      }),
    ).toThrow();
  });
});
