// TDD mode — tests written BEFORE `bankSyncAccount.ts` exists.
//
// Plan `.work-plans/iban-cross-check.md` §2 / §9.A. Pure, no DB, no Effect — sibling of
// `bankSyncStatus.test.ts` and `fioColumns.test.ts`.
//
// Contract this file pins down for `applications/server/src/services/bankSyncAccount.ts`:
//
//   export const configuredIbanOf: (config: BankSyncConfig.BankSyncConfig) => Option.Option<string>
//   export const isAccountMismatch: (
//     config: BankSyncConfig.BankSyncConfig,
//     fioIban: Option.Option<string>,
//   ) => boolean
//
// `isAccountMismatch` is `true` ONLY when both IBANs are present and differ (whitespace/case
// insensitively) — either side absent means no comparison is possible and must never become an
// accusation, because this verdict halts ingestion (plan §2).

import type { BankSyncConfig } from '@sideline/domain';
import { Option } from 'effect';
import { describe, expect, it } from 'vitest';
import { configuredIbanOf, isAccountMismatch } from '~/services/bankSyncAccount.js';

// Only the fields `configuredIbanOf`/`isAccountMismatch` read are populated with real values;
// every other `BankSyncConfig` column is present but unused by this module, so a minimal `as
// never` cast keeps this fixture from having to track the whole schema.
const baseConfig = (
  overrides: Partial<{
    readonly account_prefix: Option.Option<string>;
    readonly account_number: Option.Option<string>;
    readonly bank_code: Option.Option<string>;
  }> = {},
): BankSyncConfig.BankSyncConfig =>
  ({
    account_prefix: Option.none(),
    account_number: Option.some('2703474850'),
    bank_code: Option.some('2010'),
    ...overrides,
  }) as never;

describe('configuredIbanOf / isAccountMismatch', () => {
  // 1 — match -> false (2703474850/2010 vs CZ7120100000002703474850).
  it('matching accounts -> isAccountMismatch is false', () => {
    const config = baseConfig();
    expect(configuredIbanOf(config)).toEqual(Option.some('CZ7120100000002703474850'));
    expect(isAccountMismatch(config, Option.some('CZ7120100000002703474850'))).toBe(false);
  });

  // 2 — mismatch -> true (1265098001/5500 vs CZ7120100000002703474850).
  it('a different account -> isAccountMismatch is true', () => {
    const config = baseConfig({
      account_number: Option.some('1265098001'),
      bank_code: Option.some('5500'),
    });
    expect(isAccountMismatch(config, Option.some('CZ7120100000002703474850'))).toBe(true);
  });

  // 3 — whitespace + lower case -> false.
  it('a matching IBAN that Fio sent spaced and lower-cased -> isAccountMismatch is false', () => {
    const config = baseConfig();
    expect(isAccountMismatch(config, Option.some('cz71 2010 0000 0027 0347 4850'))).toBe(false);
  });

  // 4 — Fio iban None -> false.
  it('Fio sent no iban -> isAccountMismatch is false (no verdict, not an accusation)', () => {
    const config = baseConfig();
    expect(isAccountMismatch(config, Option.none())).toBe(false);
  });

  // 5 — account_number/bank_code None -> false.
  it('no configured account -> isAccountMismatch is false, regardless of what Fio sent', () => {
    const config = baseConfig({ account_number: Option.none(), bank_code: Option.none() });
    expect(configuredIbanOf(config)).toEqual(Option.none());
    expect(isAccountMismatch(config, Option.some('CZ7120100000002703474850'))).toBe(false);
  });

  // 6 — prefix-sensitivity, the false-positive case the copy is written for: configured
  // 2000145399/0800 with NO prefix vs Fio's CZ6508000000192000145399 -> true. A missing prefix is
  // a REAL mismatch, not a bug — Fio never returns the prefix in `accountId`, so the club's own
  // computed IBAN (built with an empty prefix) legitimately differs from the account Fio reads.
  it('a missing account prefix produces a real mismatch, not a false positive', () => {
    const config = baseConfig({
      account_prefix: Option.none(),
      account_number: Option.some('2000145399'),
      bank_code: Option.some('0800'),
    });
    expect(isAccountMismatch(config, Option.some('CZ6508000000192000145399'))).toBe(true);
  });

  // 7 — configuredIbanOf agrees with toConfigView's computedIban for a prefixed account: 19 +
  // 2000145399 + 0800 -> CZ6508000000192000145399.
  it('configuredIbanOf builds the same IBAN toConfigView sends as computedIban', () => {
    const config = baseConfig({
      account_prefix: Option.some('19'),
      account_number: Option.some('2000145399'),
      bank_code: Option.some('0800'),
    });
    expect(configuredIbanOf(config)).toEqual(Option.some('CZ6508000000192000145399'));
  });
});
