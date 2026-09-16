// TDD mode — tests written BEFORE `FioSecretCrypto` exists.
//
// Plan `.work-plans/fio-transaction-matching.md` D2 / D10 / T3: `secretBox.ts` is extracted from
// `EmailSecretCrypto` as a key-agnostic pure AES-256-GCM module, and `FioSecretCrypto` is a THIN
// service built over it, parameterised by `FIO_TOKEN_ENCRYPTION_KEY` instead of
// `EMAIL_IMAP_ENCRYPTION_KEY`. Its surface mirrors `EmailSecretCrypto` byte-for-byte
// (`makeWithKey(Option<string>)`, `v1.<iv>.<tag>.<ct>` base64url, `FioSecretKeyMissing` /
// `FioSecretDecryptError` typed errors) with ONE deliberate difference required by D10: `decrypt`
// returns `Redacted.Redacted<string>`, not a bare `string` — the Fio token must never be
// `String()`-coerced or logged by accident anywhere along its path to the URL.
//
// This file will not compile until `applications/server/src/services/FioSecretCrypto.ts` exists
// exporting `FioSecretCrypto`, `makeWithKey`, `FioSecretKeyMissing`, `FioSecretDecryptError`. That
// is expected — do not stub the implementation to make this pass.

import { describe, expect, it } from '@effect/vitest';
import { Effect, Option, Redacted } from 'effect';
import {
  FioSecretCrypto,
  type FioSecretDecryptError,
  type FioSecretKeyMissing,
  makeWithKey,
} from '~/services/FioSecretCrypto.js';

// ---------------------------------------------------------------------------
// Test constants — distinct byte patterns from EmailSecretCrypto.test.ts's keys, on purpose:
// cross-module confusion (accidentally importing the email key) must fail loudly, not coincide.
// ---------------------------------------------------------------------------

const FIO_KEY_B64 = Buffer.alloc(32, 42).toString('base64');
const OTHER_FIO_KEY_B64 = Buffer.alloc(32, 99).toString('base64');
const EMAIL_KEY_B64 = Buffer.alloc(32, 7).toString('base64'); // same key EmailSecretCrypto.test.ts uses
const SHORT_KEY_B64 = Buffer.alloc(16, 42).toString('base64');

const TEST_TOKEN = 'a'.repeat(64); // Fio tokens are 64 hex characters

type FioSecretCryptoShape = {
  encrypt: (s: string) => Effect.Effect<string, FioSecretKeyMissing>;
  decrypt: (
    b: string,
  ) => Effect.Effect<Redacted.Redacted<string>, FioSecretDecryptError | FioSecretKeyMissing>;
};

const layerFromKey = (key: string) =>
  makeWithKey(Option.some(key)).pipe(Effect.map((svc) => svc as FioSecretCryptoShape));

const layerNoKey = makeWithKey(Option.none<string>()).pipe(
  Effect.map((svc) => svc as FioSecretCryptoShape),
);

// ---------------------------------------------------------------------------
// Round-trip (85)
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — round-trip', () => {
  it.effect('encrypt then decrypt returns the original token, unwrapped via Redacted.value', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ciphertext = yield* svc.encrypt(TEST_TOKEN);
      const decrypted = yield* svc.decrypt(ciphertext);
      expect(Redacted.value(decrypted)).toBe(TEST_TOKEN);
    }),
  );
});

// ---------------------------------------------------------------------------
// Format (86) / random IV (87)
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — ciphertext format', () => {
  it.effect('ciphertext is v1.<iv>.<tag>.<ct> — 4 dot-separated parts, first is "v1"', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ct = yield* svc.encrypt(TEST_TOKEN);
      const parts = ct.split('.');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('v1');
      expect(parts[1]?.length).toBeGreaterThan(0);
      expect(parts[2]?.length).toBeGreaterThan(0);
      expect(parts[3]?.length).toBeGreaterThan(0);
    }),
  );

  it.effect('two encryptions of the same token produce different ciphertexts (random IV)', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ct1 = yield* svc.encrypt(TEST_TOKEN);
      const ct2 = yield* svc.encrypt(TEST_TOKEN);
      expect(ct1).not.toBe(ct2);
    }),
  );
});

// ---------------------------------------------------------------------------
// Missing / wrong-length key (88)
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — missing key', () => {
  it.effect('makeWithKey(Option.none()) builds a service without failing at construction', () =>
    Effect.gen(function* () {
      const svc = yield* layerNoKey;
      expect(typeof svc.encrypt).toBe('function');
      expect(typeof svc.decrypt).toBe('function');
    }),
  );

  it.effect(
    'encrypt with missing key -> FioSecretKeyMissing (fails at use time, not at boot)',
    () =>
      Effect.gen(function* () {
        const svc = yield* layerNoKey;
        const result = yield* Effect.result(svc.encrypt(TEST_TOKEN));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as FioSecretKeyMissing)._tag).toBe('FioSecretKeyMissing');
        }
      }),
  );

  it.effect('decrypt with missing key -> FioSecretKeyMissing', () =>
    Effect.gen(function* () {
      const svc = yield* layerNoKey;
      const result = yield* Effect.result(svc.decrypt('v1.aaa.bbb.ccc'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as FioSecretKeyMissing)._tag).toBe('FioSecretKeyMissing');
      }
    }),
  );
});

describe('FioSecretCrypto — wrong key length', () => {
  it.effect('a 16-byte key -> FioSecretKeyMissing, and the message reports the byte count', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(SHORT_KEY_B64);
      const result = yield* Effect.result(svc.encrypt(TEST_TOKEN));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as FioSecretKeyMissing;
        expect(failure._tag).toBe('FioSecretKeyMissing');
        expect(failure.message).toContain('16');
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Tamper detection (89)
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — tamper detection', () => {
  it.effect('flipping a character in the ciphertext -> FioSecretDecryptError, never a throw', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ct = yield* svc.encrypt(TEST_TOKEN);
      const tampered = ct.slice(0, -4) + (ct.slice(-4, -3) === 'A' ? 'B' : 'A') + ct.slice(-3);
      const result = yield* Effect.result(svc.decrypt(tampered));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as FioSecretDecryptError)._tag).toBe('FioSecretDecryptError');
      }
    }),
  );

  it.effect('flipping a byte in the auth tag -> FioSecretDecryptError', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ct = yield* svc.encrypt(TEST_TOKEN);
      const parts = ct.split('.');
      const tag = parts[2] ?? '';
      const tamperedTag =
        tag.slice(0, -2) + (tag.slice(-2, -1) === 'A' ? 'B' : 'A') + tag.slice(-1);
      const tampered = [parts[0], parts[1], tamperedTag, parts[3]].join('.');
      const result = yield* Effect.result(svc.decrypt(tampered));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as FioSecretDecryptError)._tag).toBe('FioSecretDecryptError');
      }
    }),
  );

  it.effect('malformed blob (no v1. prefix) -> FioSecretDecryptError, no throw', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const result = yield* Effect.result(svc.decrypt('not-a-blob'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as FioSecretDecryptError)._tag).toBe('FioSecretDecryptError');
      }
    }),
  );
});

// ---------------------------------------------------------------------------
// Cross-key isolation (90) — the point of D2: FioSecretCrypto and EmailSecretCrypto do NOT share
// a key, so a blob made with one never decrypts with the other.
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — cross-key isolation', () => {
  it.effect('blob made with a different Fio key does not decrypt', () =>
    Effect.gen(function* () {
      const svcA = yield* layerFromKey(FIO_KEY_B64);
      const svcB = yield* layerFromKey(OTHER_FIO_KEY_B64);
      const ct = yield* svcA.encrypt(TEST_TOKEN);
      const result = yield* Effect.result(svcB.decrypt(ct));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        expect((result.failure as FioSecretDecryptError)._tag).toBe('FioSecretDecryptError');
      }
    }),
  );

  it.effect(
    "a blob made with EmailSecretCrypto's key does not decrypt with FioSecretCrypto's key " +
      '— the two services must NOT share a key (D2)',
    () =>
      Effect.gen(function* () {
        // Encrypt with what would be EmailSecretCrypto's key material, decrypt with Fio's.
        const emailKeyedSvc = yield* layerFromKey(EMAIL_KEY_B64);
        const fioSvc = yield* layerFromKey(FIO_KEY_B64);
        const ct = yield* emailKeyedSvc.encrypt(TEST_TOKEN);
        const result = yield* Effect.result(fioSvc.decrypt(ct));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          expect((result.failure as FioSecretDecryptError)._tag).toBe('FioSecretDecryptError');
        }
      }),
  );
});

// ---------------------------------------------------------------------------
// Redacted end-to-end (91) — D10's containment requirement.
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — decrypt returns Redacted (D10)', () => {
  it.effect('String(result) does not contain the plaintext token', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(FIO_KEY_B64);
      const ct = yield* svc.encrypt(TEST_TOKEN);
      const decrypted = yield* svc.decrypt(ct);
      expect(String(decrypted)).not.toContain(TEST_TOKEN);
      expect(JSON.stringify(decrypted)).not.toContain(TEST_TOKEN);
      // The actual value is reachable only through the one sanctioned unwrap point.
      expect(Redacted.value(decrypted)).toBe(TEST_TOKEN);
    }),
  );
});

// ---------------------------------------------------------------------------
// Service via Default layer (smoke test, mirrors EmailSecretCrypto's)
// ---------------------------------------------------------------------------

describe('FioSecretCrypto — service via Default layer (smoke test)', () => {
  it.effect('FioSecretCrypto.Default builds and the service is accessible', () =>
    Effect.gen(function* () {
      const svc = yield* FioSecretCrypto.asEffect();
      expect(typeof svc.encrypt).toBe('function');
      expect(typeof svc.decrypt).toBe('function');
      // In test env FIO_TOKEN_ENCRYPTION_KEY is unset -> key missing, so encrypt yields KeyMissing.
      const result = yield* Effect.result(svc.encrypt(TEST_TOKEN));
      expect(['Success', 'Failure']).toContain(result._tag);
    }).pipe(Effect.provide(FioSecretCrypto.Default)),
  );
});
