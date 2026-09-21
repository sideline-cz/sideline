// TDD mode — tests written BEFORE `fioBankForm.ts` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` §3.4 / §7.1 tests 92-95. Same standard as
// `emailForwardingForm.test.ts` / `settingsForm.test.ts`: every field the form tracks must reach
// the payload, enforced by iterating the type rather than by discipline (`AGENTS.md`'s mandated
// invariant test, cited explicitly by test 95).
//
// Contract this file pins down for
// `applications/web/src/components/organisms/team-settings/fioBankForm.ts`:
//
//   export type FioBankFormValues = {
//     enabled: boolean;
//     autoMatchEnabled: boolean;
//     accountPrefix: string;
//     accountNumber: string;
//     bankCode: string;
//     currency: string;
//     recipientName: string;
//     registeredId: string;
//     registeredAddress: string;
//     bankName: string;
//   };
//
//   export const fioBankFormFrom: (config: BankSyncApi.BankSyncConfigView | null) => FioBankFormValues
//
//   export interface FioBankErrors {
//     accountPrefix?: string;
//     accountNumber?: string;
//     bankCode?: string;
//     fioToken?: string;
//   }
//   export const validateFioBankForm:
//     (values: FioBankFormValues, options: { readonly fioTokenSet: boolean; readonly replacingToken: boolean; readonly fioToken: string })
//       => FioBankErrors
//   export const hasFioBankErrors: (errors: FioBankErrors) => boolean
//
//   // Write-only token, three-state — mirrors emailForwardingForm's imapSecretPayload exactly.
//   export const fioTokenPayload:
//     (options: { readonly fioTokenSet: boolean; readonly replacingToken: boolean; readonly fioToken: string })
//       => Option.Option<string>
//
//   export const fioBankRequestFrom:
//     (values: FioBankFormValues, extras: { readonly fioToken: Option.Option<string> })
//       => BankSyncApi.UpsertBankSyncConfigRequest

import type { BankSyncApi } from '@sideline/domain';
import { BankSyncApi as BankSyncApiNs, CzIban } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  FIO_BANK_CODE,
  type FioBankFormValues,
  fioAccountChanged,
  fioBankFormFrom,
  fioBankRequestFrom,
  fioTokenPayload,
  hasFioBankErrors,
  validateFioBankForm,
} from './fioBankForm';
import { isFormDirty } from './useCardForm';

const BASE: FioBankFormValues = {
  enabled: false,
  autoMatchEnabled: true,
  accountPrefix: '',
  accountNumber: '',
  bankCode: '',
  currency: 'CZK',
  recipientName: '',
  registeredId: '',
  registeredAddress: '',
  bankName: '',
};

/** Typed as the form, so a new field with no test value is a compile error. */
const EDITED: FioBankFormValues = {
  enabled: true,
  autoMatchEnabled: false,
  accountPrefix: '19',
  accountNumber: '2000145399',
  bankCode: '0800',
  currency: 'EUR',
  recipientName: 'Ultimate Frisbee Horní Počernice, z.s.',
  registeredId: '61858374',
  registeredAddress: 'U Prefy 5, 193 00 Praha 9',
  bankName: 'Fio banka, a.s.',
};

const FIELDS = Object.keys(BASE) as ReadonlyArray<keyof FioBankFormValues>;
const edit = (key: keyof FioBankFormValues): FioBankFormValues => ({
  ...BASE,
  [key]: EDITED[key],
});

const NO_TOKEN = { fioToken: Option.none<string>() };

// ---------------------------------------------------------------------------
// 95 — the invariant test: every field enables Save AND is actually sent
// ---------------------------------------------------------------------------

describe('FioBankFormValues (95)', () => {
  it('gives every field a distinct edited value', () => {
    for (const key of FIELDS) {
      expect(EDITED[key], `EDITED.${key} must differ from BASE.${key}`).not.toBe(BASE[key]);
    }
  });

  describe('every field enables the Save button', () => {
    it.each(FIELDS)('%s', (key) => {
      expect(isFormDirty(BASE, edit(key))).toBe(true);
    });
  });

  describe('every field the form tracks is actually sent', () => {
    const baseRequest = JSON.stringify(fioBankRequestFrom(BASE, NO_TOKEN));
    it.each(FIELDS)('%s', (key) => {
      expect(JSON.stringify(fioBankRequestFrom(edit(key), NO_TOKEN))).not.toBe(baseRequest);
    });
  });
});

// ---------------------------------------------------------------------------
// 92 / 93 — write-only token, three-state
// ---------------------------------------------------------------------------

describe('fioTokenPayload — three-state write-only token (92, 93)', () => {
  it('unset (never configured) + a typed value -> sends it', () => {
    const payload = fioTokenPayload({
      fioTokenSet: false,
      replacingToken: false,
      fioToken: 'my-new-token',
    });
    expect(payload).toEqual(Option.some('my-new-token'));
  });

  it('set + not replacing -> Option.none() (keep the stored token)', () => {
    const payload = fioTokenPayload({ fioTokenSet: true, replacingToken: false, fioToken: '' });
    expect(payload).toEqual(Option.none());
  });

  it('set + replacing + a typed value -> sends the new value', () => {
    const payload = fioTokenPayload({
      fioTokenSet: true,
      replacingToken: true,
      fioToken: 'replacement-token',
    });
    expect(payload).toEqual(Option.some('replacement-token'));
  });

  it('fioTokenSet: true + empty input -> the request OMITS fio_token entirely (key absent, not null) (93)', () => {
    const request = fioBankRequestFrom(BASE, {
      fioToken: fioTokenPayload({ fioTokenSet: true, replacingToken: false, fioToken: '' }),
    });
    expect('fio_token' in request).toBe(false);
  });

  it('a typed token IS present as the key', () => {
    const request = fioBankRequestFrom(BASE, {
      fioToken: fioTokenPayload({ fioTokenSet: false, replacingToken: false, fioToken: 'abc' }),
    });
    expect('fio_token' in request).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 94 — validation: prefix, account number + modulo-11, bank code
// ---------------------------------------------------------------------------

describe('validateFioBankForm — shape and checksum validation (94)', () => {
  const valid = (): FioBankFormValues => ({
    ...BASE,
    enabled: true,
    accountPrefix: '',
    accountNumber: '2703474850', // verified modulo-11-valid vector (CzIban.test.ts)
    bankCode: '2010',
    recipientName: 'Klub',
  });

  it('a fully valid identity has no errors', () => {
    const errors = validateFioBankForm(valid(), {
      fioTokenSet: true,
      replacingToken: false,
      fioToken: '',
    });
    expect(hasFioBankErrors(errors)).toBe(false);
  });

  it('account prefix longer than 6 digits is rejected', () => {
    const errors = validateFioBankForm(
      { ...valid(), accountPrefix: '1234567' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountPrefix).toBeDefined();
  });

  it('account prefix of exactly 6 digits is accepted', () => {
    const errors = validateFioBankForm(
      { ...valid(), accountPrefix: '123456' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountPrefix).toBeUndefined();
  });

  it('account number shorter than 2 digits is rejected', () => {
    const errors = validateFioBankForm(
      { ...valid(), accountNumber: '5' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountNumber).toBeDefined();
  });

  it('account number longer than 10 digits is rejected', () => {
    const errors = validateFioBankForm(
      { ...valid(), accountNumber: '123456789012' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountNumber).toBeDefined();
  });

  it('a modulo-11-INVALID account number is rejected even though the shape is fine', () => {
    // Sanity: this vector genuinely fails the checksum, so the test is not vacuous.
    expect(CzIban.isValidCzAccountNumber('', '2703474851')).toBe(false);
    const errors = validateFioBankForm(
      { ...valid(), accountNumber: '2703474851' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountNumber).toBeDefined();
  });

  it('a modulo-11-VALID account number is accepted', () => {
    expect(CzIban.isValidCzAccountNumber('', '2703474850')).toBe(true);
    const errors = validateFioBankForm(
      { ...valid(), accountNumber: '2703474850' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.accountNumber).toBeUndefined();
  });

  it('bank code must be exactly 4 digits — 3 digits rejected', () => {
    const errors = validateFioBankForm(
      { ...valid(), bankCode: '201' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.bankCode).toBeDefined();
  });

  it('bank code must be exactly 4 digits — 5 digits rejected', () => {
    const errors = validateFioBankForm(
      { ...valid(), bankCode: '20100' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.bankCode).toBeDefined();
  });

  it('bank code of exactly 4 digits is accepted', () => {
    const errors = validateFioBankForm(
      { ...valid(), bankCode: '2010' },
      { fioTokenSet: true, replacingToken: false, fioToken: '' },
    );
    expect(errors.bankCode).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// fioBankFormFrom — round-trips a config view into form values
// ---------------------------------------------------------------------------

describe('fioBankFormFrom', () => {
  it('a null config (never configured) produces sane defaults', () => {
    const values = fioBankFormFrom(null);
    expect(values.enabled).toBe(false);
    expect(values.accountPrefix).toBe('');
    expect(values.accountNumber).toBe('');
    // NOT '' — an empty bank code fails validateFioBankForm's 4-digit check, which silently
    // aborted every first-time save in production. The card shows the bank code as static text
    // (always Fio's 2010) and handleSave overrides it with the constant regardless.
    expect(values.bankCode).toBe(FIO_BANK_CODE);
  });

  // Regression: the two halves above were each tested in isolation and never composed —
  // `validateFioBankForm`'s fixtures hardcoded bankCode: '2010', so nothing exercised the values
  // a real first-time user actually starts from. That gap is what let the bug ship.
  it('the defaults a first-time user starts from can actually be saved', () => {
    const values: FioBankFormValues = {
      ...fioBankFormFrom(null),
      enabled: true,
      accountNumber: '2703474850',
      recipientName: 'Klub',
    };
    const errors = validateFioBankForm(values, {
      fioTokenSet: false,
      replacingToken: false,
      fioToken: 'a-token',
    });
    expect(hasFioBankErrors(errors)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Regression: the request must actually encode over the wire
// ---------------------------------------------------------------------------

/**
 * `fio_token` was once `Schema.RedactedFromValue(...)`. `Redacted` is decode-only by design —
 * Effect's serializer refuses to encode one — so every save failed client-side with
 * "Cannot encode Redacted" and no request ever reached the server.
 *
 * Asserting the SHAPE `fioBankRequestFrom` returns is not enough to catch that; only encoding
 * it through the real contract is. This is the browser's half of the round trip.
 */
describe('fioBankRequestFrom — encodes through the real API contract', () => {
  const encode = (req: BankSyncApi.UpsertBankSyncConfigRequest) =>
    Effect.runPromise(
      Schema.encodeUnknownEffect(BankSyncApiNs.UpsertBankSyncConfigRequest)(req).pipe(
        Effect.map(() => 'ok' as const),
        Effect.catchCause((cause) => Effect.succeed(String(cause))),
      ),
    );

  const build = (fioToken: Option.Option<string>): BankSyncApi.UpsertBankSyncConfigRequest => ({
    fio_token: Option.none(),
    ...fioBankRequestFrom(
      {
        ...fioBankFormFrom(null),
        enabled: true,
        accountNumber: '2703474850',
        recipientName: 'Klub',
      },
      { fioToken },
    ),
  });

  it('encodes when a new token is being sent', async () => {
    expect(await encode(build(Option.some('a'.repeat(64))))).toBe('ok');
  });

  it('encodes when the stored token is left alone', async () => {
    expect(await encode(build(Option.none()))).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// fioAccountChanged — plan `.work-plans/iban-cross-check.md` §7 / §9.F
//
// The Test button probes the SAVED config, so an edited-but-unsaved account makes the
// `account_mismatch` verdict a lie (fixing the field, pressing Test, and seeing the SAME
// mismatch because the save never happened). `fioAccountChanged` is the dirty-account gate that
// disables Test the same way `tokenChanged` already does.
// ---------------------------------------------------------------------------

describe('fioAccountChanged', () => {
  it('is false for identical values', () => {
    expect(fioAccountChanged(BASE, { ...BASE })).toBe(false);
  });

  it('is true when accountNumber differs', () => {
    const values = { ...BASE, accountNumber: '2703474850' };
    expect(fioAccountChanged(BASE, values)).toBe(true);
  });

  it('is true when accountPrefix differs, including the empty-prefix false-mismatch case ("" -> "19")', () => {
    // This is the realistic false-mismatch surface the whole feature hinges on (plan §8): Fio
    // never sends the prefix back, so a club that typed the account number with an empty prefix
    // field gets a permanent mismatch until they fill it in and re-save.
    const saved: FioBankFormValues = { ...BASE, accountPrefix: '' };
    const values: FioBankFormValues = { ...BASE, accountPrefix: '19' };
    expect(fioAccountChanged(saved, values)).toBe(true);
  });

  it('is false when only an unrelated field (recipientName) differs', () => {
    const values = { ...BASE, recipientName: 'Different Club, z.s.' };
    expect(fioAccountChanged(BASE, values)).toBe(false);
  });
});
