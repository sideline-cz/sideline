// TDD mode — tests written BEFORE `bankSyncStatus.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D11 / §7.1 tests 60-69. Pure, no DB, no Effect —
// a total function over already-fetched `bank_sync_config` facts and `now`.
//
// Contract this file pins down for `applications/server/src/services/bankSyncStatus.ts`:
//
//   export interface BankSyncStatusInput {
//     readonly hasToken: boolean;
//     readonly lastErrorCode: Option.Option<string>;       // e.g. 'fio_error' | 'coverage_gap' | ...
//     readonly lastErrorIsKeyMissing: boolean;              // the last failure was FioSecretKeyMissing
//     readonly consecutiveFailureCount: number;
//     readonly lastErrorAt: Option.Option<number>;          // epoch ms
//     readonly lastSuccessAt: Option.Option<number>;        // epoch ms
//     readonly tokenCreatedAt: Option.Option<number>;       // epoch ms
//     readonly now: number;                                  // epoch ms
//   }
//
//   export interface BankSyncStatusResult {
//     readonly status: BankSyncConfig.BankSyncStatusCode;   // the seven-rank ladder
//     readonly expiringSoon: boolean;                        // additive, never suppressed by status
//     readonly tokenExpiresAt: Option.Option<number>;        // tokenCreatedAt + 180d
//   }
//
//   export const computeBankSyncStatus: (input: BankSyncStatusInput) => BankSyncStatusResult
//
// Ladder (seven ranks, first match wins) — plan `.work-plans/iban-cross-check.md` §3 inserts rule
// 2.5 (`account_mismatch`) between `misconfigured` and the `invalid`/`activating`/`sync_failing`
// group, because the token demonstrably works and telling the treasurer to replace it is wrong:
//   1. !hasToken                                                          -> not_connected
//   2. lastErrorIsKeyMissing                                              -> misconfigured
//   2.5. lastErrorCode='account_mismatch'                                                          -> account_mismatch
//   3. lastErrorCode='fio_error' AND failures>=3 AND (errorAt - (successAt ?? tokenCreatedAt)) > 6h -> invalid
//   4. lastErrorCode='fio_error' AND now - 5min < tokenCreatedAt <= now                              -> activating
//   5. lastErrorCode is set but rules 2.5-4 did not fire                                            -> sync_failing
//   6. otherwise                                                                                    -> ok
// `expiringSoon` = tokenCreatedAt present AND tokenExpiresAt - now <= 14 days. Computed
// independently of the seven ranks above — NEVER suppressed by them.

import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { type BankSyncStatusInput, computeBankSyncStatus } from '~/services/bankSyncStatus.js';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const MIN = 60 * 1000;

const NOW = new Date('2026-06-15T12:00:00.000Z').getTime();

const baseInput = (overrides: Partial<BankSyncStatusInput> = {}): BankSyncStatusInput => ({
  hasToken: true,
  lastErrorCode: Option.none(),
  lastErrorIsKeyMissing: false,
  consecutiveFailureCount: 0,
  lastErrorAt: Option.none(),
  lastSuccessAt: Option.none(),
  tokenCreatedAt: Option.some(NOW - 30 * DAY),
  now: NOW,
  ...overrides,
});

// ---------------------------------------------------------------------------
// 60 — the full seven-rank ladder
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — the seven-rank ladder (60)', () => {
  it('not_connected when there is no token, regardless of every other field (65)', () => {
    const result = computeBankSyncStatus(
      baseInput({
        hasToken: false,
        lastErrorIsKeyMissing: true,
        consecutiveFailureCount: 10,
        lastErrorCode: Option.some('fio_error'),
      }),
    );
    expect(result.status).toBe('not_connected');
  });

  it('misconfigured when the last error was FioSecretKeyMissing, never invalid (64)', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorIsKeyMissing: true,
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 10,
        lastErrorAt: Option.some(NOW - 1 * DAY),
        lastSuccessAt: Option.some(NOW - 2 * DAY),
      }),
    );
    expect(result.status).toBe('misconfigured');
  });

  it('invalid after 3+ failures and > 6h since last success', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 3,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('activating within 5 minutes of token creation', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        tokenCreatedAt: Option.some(NOW - 2 * MIN),
      }),
    );
    expect(result.status).toBe('activating');
  });

  it('sync_failing for a lastErrorCode that does not satisfy invalid or activating', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 1 * HOUR),
        tokenCreatedAt: Option.some(NOW - 30 * DAY),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  it('ok when nothing is wrong', () => {
    const result = computeBankSyncStatus(baseInput());
    expect(result.status).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// rule 2.5 — account_mismatch: outranks invalid, loses to misconfigured (plan §3 / §9.B)
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — rule 2.5 account_mismatch', () => {
  it("lastErrorCode: Some('account_mismatch') -> 'account_mismatch'", () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('account_mismatch'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
      }),
    );
    expect(result.status).toBe('account_mismatch');
  });

  it('account_mismatch beats the invalid gate: 5 failures and 7h of silence still report account_mismatch, not invalid', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('account_mismatch'),
        consecutiveFailureCount: 5,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('account_mismatch');
  });

  it('rule 2 (lastErrorIsKeyMissing) still wins over account_mismatch — misconfigured, not account_mismatch', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorIsKeyMissing: true,
        lastErrorCode: Option.some('account_mismatch'),
        consecutiveFailureCount: 5,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('misconfigured');
  });
});

// ---------------------------------------------------------------------------
// 61 / 62 / 63 — a transient failure is not an expired token (the point of D11 — B11)
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — transient failure is NOT an expired token (61, 62, 63)', () => {
  it('one 500 (consecutive_failure_count = 1) -> sync_failing, never invalid', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 8 * HOUR),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  it('3 failures but only 2h since last success -> sync_failing, not invalid', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 3,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 2 * HOUR),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  it('3 failures and 7h since last success -> invalid', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 3,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('invalid');
  });

  it('3 failures, no lastSuccessAt ever, > 6h since token creation -> invalid (falls back to tokenCreatedAt)', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 3,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.none(),
        tokenCreatedAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('invalid');
  });
});

// ---------------------------------------------------------------------------
// 66 / 66b — expiry is additive, never a rank of the union, never suppressed
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — expiringSoon is additive (66, 66b)', () => {
  it('expiringSoon is true at exactly 14 days remaining', () => {
    const result = computeBankSyncStatus(
      baseInput({ tokenCreatedAt: Option.some(NOW - (180 - 14) * DAY) }),
    );
    expect(result.expiringSoon).toBe(true);
  });

  it('expiringSoon is false at 14 days + 1 minute remaining', () => {
    const result = computeBankSyncStatus(
      baseInput({ tokenCreatedAt: Option.some(NOW - (180 - 14) * DAY + MIN) }),
    );
    expect(result.expiringSoon).toBe(false);
  });

  it("'BankSyncStatusCode' never takes the value 'expiring_soon'", async () => {
    const { BankSyncConfig } = await import('@sideline/domain');
    expect(BankSyncConfig.BankSyncStatusCode.literals).not.toContain('expiring_soon');
  });

  it('a token both expiring (13d) AND failing (3 failures, 7h) reports invalid AND expiringSoon=true', () => {
    const result = computeBankSyncStatus(
      baseInput({
        tokenCreatedAt: Option.some(NOW - (180 - 13) * DAY),
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 3,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 7 * HOUR),
      }),
    );
    expect(result.status).toBe('invalid');
    expect(result.expiringSoon).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 67 — activating boundary
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — activating boundary (67)', () => {
  it('4 min 59 s after token creation -> activating', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        tokenCreatedAt: Option.some(NOW - (4 * MIN + 59 * 1000)),
      }),
    );
    expect(result.status).toBe('activating');
  });

  it('5 min 1 s after token creation + 1 failure -> sync_failing, not activating', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 1 * HOUR),
        tokenCreatedAt: Option.some(NOW - (5 * MIN + 1000)),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  // The window is two-sided. `fio_token_created_at` is a user-declared calendar date snapped to
  // 12:00 UTC, so without an upper bound every moment before the anchor matched too.
  it('a token created 1 s in the future -> sync_failing, not activating', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 1 * HOUR),
        tokenCreatedAt: Option.some(NOW + 1000),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  it("today's noon-anchored token read in the morning -> sync_failing, not activating", () => {
    const morning = new Date('2026-06-15T08:00:00.000Z').getTime();
    const result = computeBankSyncStatus(
      baseInput({
        now: morning,
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(morning),
        lastSuccessAt: Option.some(morning - 1 * HOUR),
        // 2026-06-15 as written by `dateOnlyToUtcNoon` — four hours from now, not five minutes ago.
        tokenCreatedAt: Option.some(NOW),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });

  it('a token dated far in the future never reports activating', () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('fio_error'),
        consecutiveFailureCount: 1,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 1 * HOUR),
        tokenCreatedAt: Option.some(NOW + 30 * DAY),
      }),
    );
    expect(result.status).toBe('sync_failing');
  });
});

// ---------------------------------------------------------------------------
// 68 / 69 — internal-only codes never surface as `status`
// ---------------------------------------------------------------------------

describe('computeBankSyncStatus — internal codes never surface (68, 69)', () => {
  it('rate_limited and too_many_movements never appear as `status`', () => {
    for (const code of ['rate_limited', 'too_many_movements']) {
      const result = computeBankSyncStatus(
        baseInput({
          lastErrorCode: Option.some(code),
          consecutiveFailureCount: 5,
          lastErrorAt: Option.some(NOW),
          lastSuccessAt: Option.some(NOW - 10 * HOUR),
        }),
      );
      expect([
        'not_connected',
        'misconfigured',
        'invalid',
        'activating',
        'sync_failing',
        'ok',
      ]).toContain(result.status);
      expect(result.status).not.toBe(code);
    }
  });

  it("'history_locked' is never reported as `status` — it belongs on backfillStatus only", () => {
    const result = computeBankSyncStatus(
      baseInput({
        lastErrorCode: Option.some('history_locked'),
        consecutiveFailureCount: 5,
        lastErrorAt: Option.some(NOW),
        lastSuccessAt: Option.some(NOW - 10 * HOUR),
      }),
    );
    expect(result.status).not.toBe('history_locked');
  });
});
