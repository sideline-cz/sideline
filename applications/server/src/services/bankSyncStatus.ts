/**
 * D11 (B11) — status inference: a transient failure is not an expired token. Pure, no DB, no
 * Effect — a total function over already-fetched `bank_sync_config` facts and `now`.
 *
 * Six-rank ladder, first match wins. `expiringSoon` is additive and computed independently of
 * the ladder — NEVER suppressed by any rank, because a token that is both expiring AND failing
 * must report both facts.
 */
import type { BankSyncConfig } from '@sideline/domain';
import { Option } from 'effect';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const MIN_MS = 60 * 1000;

const INVALID_FAILURE_THRESHOLD = 3;
const INVALID_SILENCE_MS = 6 * HOUR_MS;
const ACTIVATING_WINDOW_MS = 5 * MIN_MS;
const TOKEN_LIFETIME_MS = 180 * DAY_MS;
const EXPIRING_SOON_WINDOW_MS = 14 * DAY_MS;

export interface BankSyncStatusInput {
  readonly hasToken: boolean;
  /** e.g. 'fio_error' | 'coverage_gap' | 'rate_limited' | 'too_many_movements' | 'history_locked' */
  readonly lastErrorCode: Option.Option<string>;
  /** the last failure was FioSecretKeyMissing. */
  readonly lastErrorIsKeyMissing: boolean;
  readonly consecutiveFailureCount: number;
  readonly lastErrorAt: Option.Option<number>;
  readonly lastSuccessAt: Option.Option<number>;
  readonly tokenCreatedAt: Option.Option<number>;
  readonly now: number;
}

export interface BankSyncStatusResult {
  readonly status: BankSyncConfig.BankSyncStatusCode;
  readonly expiringSoon: boolean;
  readonly tokenExpiresAt: Option.Option<number>;
}

const isFioError = (input: BankSyncStatusInput): boolean =>
  Option.match(input.lastErrorCode, {
    onNone: () => false,
    onSome: (code) => code === 'fio_error',
  });

export const computeBankSyncStatus = (input: BankSyncStatusInput): BankSyncStatusResult => {
  const tokenExpiresAt = Option.map(
    input.tokenCreatedAt,
    (createdAt) => createdAt + TOKEN_LIFETIME_MS,
  );
  const expiringSoon = Option.match(tokenExpiresAt, {
    onNone: () => false,
    onSome: (expiresAt) => expiresAt - input.now <= EXPIRING_SOON_WINDOW_MS,
  });

  const status = computeStatus(input);

  return { status, expiringSoon, tokenExpiresAt };
};

const computeStatus = (input: BankSyncStatusInput): BankSyncConfig.BankSyncStatusCode => {
  // 1 — not_connected.
  if (!input.hasToken) return 'not_connected';

  // 2 — misconfigured.
  if (input.lastErrorIsKeyMissing) return 'misconfigured';

  if (Option.isNone(input.lastErrorCode)) return 'ok';

  // 3 — invalid.
  if (isFioError(input) && input.consecutiveFailureCount >= INVALID_FAILURE_THRESHOLD) {
    const silenceBaseline = Option.orElse(input.lastSuccessAt, () => input.tokenCreatedAt);
    const silenceMs = Option.match(input.lastErrorAt, {
      onNone: () => 0,
      onSome: (errorAt) =>
        Option.match(silenceBaseline, {
          onNone: () => 0,
          onSome: (baseline) => errorAt - baseline,
        }),
    });
    if (silenceMs > INVALID_SILENCE_MS) return 'invalid';
  }

  // 4 — activating.
  if (isFioError(input)) {
    const activating = Option.match(input.tokenCreatedAt, {
      onNone: () => false,
      onSome: (createdAt) => createdAt > input.now - ACTIVATING_WINDOW_MS,
    });
    if (activating) return 'activating';
  }

  // 5 — sync_failing: lastErrorCode is set but rules 3-4 did not fire.
  return 'sync_failing';
};
