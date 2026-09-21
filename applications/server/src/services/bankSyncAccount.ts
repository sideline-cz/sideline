/**
 * The one definition of "this token reads someone else's account", shared by the read-only probe
 * (`api/bank-sync.ts`) and the hourly poller (`services/BankSyncPoller.ts`). Pure, no Effect —
 * same shape as `services/bankSyncStatus.ts`.
 */
import type { BankSyncConfig } from '@sideline/domain';
import { CzIban } from '@sideline/domain';
import { Option } from 'effect';

/** The IBAN the club typed, as `toConfigView` already computes it (`api/bank-sync.ts:192`). */
export const configuredIbanOf = (config: BankSyncConfig.BankSyncConfig): Option.Option<string> =>
  Option.flatMap(config.account_number, (accountNumber) =>
    Option.flatMap(config.bank_code, (bankCode) =>
      CzIban.buildCzIban({
        prefix: Option.getOrUndefined(config.account_prefix),
        accountNumber,
        bankCode,
      }),
    ),
  );

// Fio's `info.iban` is free text off the wire (`fioColumns.ts:294`) and may arrive spaced or
// lower-cased; ours never is.
const normalise = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase();

/**
 * `true` ONLY when both IBANs are present and differ. Either side absent (account not configured,
 * `buildCzIban` declined, Fio sent no iban) means no comparison is possible — and an unanswerable
 * question must never become an accusation, because this verdict halts ingestion.
 */
export const isAccountMismatch = (
  config: BankSyncConfig.BankSyncConfig,
  fioIban: Option.Option<string>,
): boolean =>
  Option.getOrElse(
    Option.zipWith(configuredIbanOf(config), fioIban, (a, b) => normalise(a) !== normalise(b)),
    () => false,
  );
