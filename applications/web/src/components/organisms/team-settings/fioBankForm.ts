import type { BankSyncApi } from '@sideline/domain';
import { CzIban, CzIco, Fee } from '@sideline/domain';
import { Option, Schema } from 'effect';

/**
 * The primitive fields the Fio connection card's Save button owns.
 *
 * Three things deliberately live OUTSIDE this type, for the same reason
 * `emailForwardingForm.ts` keeps `imapSecret` out: a shallow `!==` compare
 * cannot express them.
 *
 * - `fioTokenSet` / `replacingToken` / `fioToken` — the write-only, three-state
 *   secret (`fioTokenPayload` below).
 * - `tokenCreatedAt` — only meaningful together with whether a token is being
 *   sent at all; the card manages it as separate local state and folds it into
 *   the request at the call site.
 *
 * `bankCode` stays in the form (rather than being hard-coded '2010' here) so
 * the invariant test can assert it flows through like every other field; the
 * card itself renders it as a read-only input fixed to the constant.
 */
export type FioBankFormValues = {
  enabled: boolean;
  autoMatchEnabled: boolean;
  autoCreditEnabled: boolean;
  autoCreateExpenses: boolean;
  accountPrefix: string;
  accountNumber: string;
  bankCode: string;
  currency: string;
  recipientName: string;
  registeredId: string;
  registeredAddress: string;
  bankName: string;
};

type Config = BankSyncApi.BankSyncConfigView | null;

/** Only Fio is supported (D-series plan) — the constant the card locks "Kód banky" to. */
export const FIO_BANK_CODE = '2010';
export const FIO_BANK_NAME = 'Fio banka, a.s.';

export const fioBankFormFrom = (config: Config): FioBankFormValues => ({
  enabled: config?.enabled ?? false,
  autoMatchEnabled: config?.autoMatchEnabled ?? true,
  // Opt-in: false for a team that has never configured it, and false in the default view the
  // server returns for a team with no config row at all.
  autoCreditEnabled: config?.autoCreditEnabled ?? false,
  autoCreateExpenses: config?.autoCreateExpenses ?? false,
  accountPrefix: Option.getOrElse(config?.accountPrefix ?? Option.none<string>(), () => ''),
  accountNumber: Option.getOrElse(config?.accountNumber ?? Option.none<string>(), () => ''),
  // Defaults to FIO_BANK_CODE, not '', for the same reason `bankName` defaults below: the card
  // renders the bank code as static text (it is always Fio's 2010) and `handleSave` overrides it
  // with the constant anyway. An empty default failed `validateFioBankForm`'s 4-digit check on
  // EVERY first-time setup, and since there is no bank-code input there was nowhere to render
  // `errors.bankCode` — so Save silently did nothing at all.
  bankCode: Option.getOrElse(config?.bankCode ?? Option.none<string>(), () => FIO_BANK_CODE),
  currency: config?.currency ?? 'CZK',
  recipientName: Option.getOrElse(config?.recipientName ?? Option.none<string>(), () => ''),
  registeredId: Option.getOrElse(config?.registeredId ?? Option.none<string>(), () => ''),
  registeredAddress: Option.getOrElse(config?.registeredAddress ?? Option.none<string>(), () => ''),
  bankName: Option.getOrElse(config?.bankName ?? Option.none<string>(), () => FIO_BANK_NAME),
});

/** Per-field translation keys, so the card renders errors next to their inputs. */
export interface FioBankErrors {
  accountPrefix?: string;
  accountNumber?: string;
  bankCode?: string;
  fioToken?: string;
}

const DIGITS = /^[0-9]*$/;
const ACCOUNT_SHAPE = /^[0-9]{2,10}$/;
const BANK_CODE_SHAPE = /^[0-9]{4}$/;
const ICO_SHAPE = /^[0-9]{8}$/;

/**
 * Pure validation over the identity fields — the modulo-11 account checksum and the IBAN
 * construction are IMPORTED from `@sideline/domain` (`CzIban.isValidCzAccountNumber`), never
 * re-implemented here, so the browser and the server cannot disagree about a valid account
 * number (design §2.6).
 *
 * `options.fioToken` is accepted for shape parity with `emailForwardingForm`'s
 * `validateEmailForwarding`, but the token's length sanity ("looks unusually short") is
 * deliberately a non-blocking hint rendered by the card, not a blocking error here — see
 * design §2.6: "warn, do not block".
 */
export const validateFioBankForm = (
  values: FioBankFormValues,
  _options: {
    readonly fioTokenSet: boolean;
    readonly replacingToken: boolean;
    readonly fioToken: string;
  },
): FioBankErrors => {
  if (!values.enabled) return {};

  const errors: FioBankErrors = {};
  const prefix = values.accountPrefix.trim();
  const accountNumber = values.accountNumber.trim();
  const bankCode = values.bankCode.trim();

  if (prefix.length > 6 || !DIGITS.test(prefix)) {
    errors.accountPrefix = 'fio_account_errorPrefix';
  }

  if (!ACCOUNT_SHAPE.test(accountNumber) || !CzIban.isValidCzAccountNumber(prefix, accountNumber)) {
    errors.accountNumber = 'fio_account_errorChecksum';
  }

  if (!BANK_CODE_SHAPE.test(bankCode)) {
    errors.bankCode = 'fio_account_errorBankCode';
  }

  return errors;
};

export const hasFioBankErrors = (errors: FioBankErrors): boolean =>
  Object.values(errors).some((v) => v !== undefined);

/** The Test button probes the SAVED config, so an edited-but-unsaved account makes the verdict a
 * lie. Same reason `tokenChanged` already disables it. */
export const fioAccountChanged = (saved: FioBankFormValues, values: FioBankFormValues): boolean =>
  saved.accountPrefix !== values.accountPrefix || saved.accountNumber !== values.accountNumber;

/** The IČO checksum (a different algorithm from the account number's) — non-blocking shape. */
export const isValidRegisteredId = (value: string): boolean => {
  const trimmed = value.trim();
  if (trimmed === '') return true;
  return ICO_SHAPE.test(trimmed) && CzIco.isValidIco(trimmed);
};

/**
 * `Option.none()` means "do not touch the stored token" — mirrors
 * `emailForwardingForm.ts`'s `imapSecretPayload` exactly, and for the same reason: the stored
 * token is never sent back to the browser, so "did it change" is not an `!==` question.
 */
export const fioTokenPayload = (options: {
  readonly fioTokenSet: boolean;
  readonly replacingToken: boolean;
  readonly fioToken: string;
}): Option.Option<string> => {
  if (options.fioTokenSet && !options.replacingToken) return Option.none();
  return options.fioToken.trim() ? Option.some(options.fioToken.trim()) : Option.none();
};

/**
 * The domain's `fio_token` field is REQUIRED on `UpsertBankSyncConfigRequest`'s decoded
 * ("Type") shape — `Schema.OptionFromOptional` only makes the wire KEY optional, not the JS
 * property (verified: TS rejects an object literal that omits it). `fioBankRequestFrom` can
 * therefore not be typed to literally return that domain type while ALSO genuinely omitting
 * the key at runtime (test 93) without a forbidden cast. This looser type — everything else
 * required, `fio_token` optional — lets the function build a real "key absent" object; the
 * call site (`FioBankCard.tsx`) reconciles it back to the full domain type by spreading a
 * `fio_token: Option.none()` default BEFORE this result, which the domain type requires
 * anyway and which is functionally identical on the wire (both encode to an omitted key).
 */
export type FioBankUpsertRequest = Omit<BankSyncApi.UpsertBankSyncConfigRequest, 'fio_token'> &
  Partial<Pick<BankSyncApi.UpsertBankSyncConfigRequest, 'fio_token'>>;

export const fioBankRequestFrom = (
  values: FioBankFormValues,
  extras: { readonly fioToken: Option.Option<string> },
): FioBankUpsertRequest => {
  const optionOrNone = (value: string): Option.Option<string> => {
    const trimmed = value.trim();
    return trimmed ? Option.some(trimmed) : Option.none();
  };

  const base: Omit<BankSyncApi.UpsertBankSyncConfigRequest, 'fio_token'> = {
    enabled: values.enabled,
    auto_match_enabled: values.autoMatchEnabled,
    // Always Some from the web: the form knows the flag. The Option exists for OLD bundles,
    // which omit the key entirely and mean "keep whatever is stored".
    auto_credit_enabled: Option.some(values.autoCreditEnabled),
    auto_create_expenses: values.autoCreateExpenses,
    account_prefix: optionOrNone(values.accountPrefix),
    account_number: values.accountNumber.trim(),
    bank_code: values.bankCode.trim(),
    currency: Schema.decodeSync(Fee.CurrencyCode)(values.currency),
    recipient_name: optionOrNone(values.recipientName),
    registered_id: optionOrNone(values.registeredId),
    registered_address: optionOrNone(values.registeredAddress),
    bank_name: optionOrNone(values.bankName),
    fio_token_created_at: Option.none(),
  };

  return Option.match(extras.fioToken, {
    onNone: () => base,
    onSome: (token): FioBankUpsertRequest => ({
      ...base,
      fio_token: Option.some(token),
    }),
  });
};
