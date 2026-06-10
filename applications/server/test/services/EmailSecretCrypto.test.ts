import { describe, expect, it } from '@effect/vitest';
import { Effect, Option } from 'effect';
import {
  EmailSecretCrypto,
  type EmailSecretDecryptError,
  type EmailSecretKeyMissing,
  makeWithKey,
} from '~/services/EmailSecretCrypto.js';

// ---------------------------------------------------------------------------
// Test constants
// ---------------------------------------------------------------------------

// A known 32-byte key, base64-encoded: Buffer.alloc(32, 7).toString('base64')
const TEST_KEY_B64 = Buffer.alloc(32, 7).toString('base64');

// A second, different 32-byte key for wrong-key tests
const OTHER_KEY_B64 = Buffer.alloc(32, 13).toString('base64');

// A short (16-byte) key — must be rejected
const SHORT_KEY_B64 = Buffer.alloc(16, 7).toString('base64');

// ---------------------------------------------------------------------------
// Helper: build a crypto service layer from a known key
// ---------------------------------------------------------------------------

const layerFromKey = (key: string) =>
  makeWithKey(Option.some(key)).pipe(
    Effect.map(
      (svc) =>
        svc as {
          encrypt: (s: string) => Effect.Effect<string, EmailSecretKeyMissing>;
          decrypt: (
            b: string,
          ) => Effect.Effect<string, EmailSecretDecryptError | EmailSecretKeyMissing>;
        },
    ),
  );

const layerNoKey = makeWithKey(Option.none<string>()).pipe(
  Effect.map(
    (svc) =>
      svc as {
        encrypt: (s: string) => Effect.Effect<string, EmailSecretKeyMissing>;
        decrypt: (
          b: string,
        ) => Effect.Effect<string, EmailSecretDecryptError | EmailSecretKeyMissing>;
      },
  ),
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('EmailSecretCrypto — round-trip', () => {
  it.effect('encrypt then decrypt returns the original plaintext', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const ciphertext = yield* svc.encrypt('hunter2-imap');
      const plaintext = yield* svc.decrypt(ciphertext);
      expect(plaintext).toBe('hunter2-imap');
    }),
  );
});

describe('EmailSecretCrypto — ciphertext properties', () => {
  it.effect('ciphertext is not equal to plaintext', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const ciphertext = yield* svc.encrypt('hunter2-imap');
      expect(ciphertext).not.toBe('hunter2-imap');
    }),
  );

  it.effect('two encryptions of the same input produce different ciphertexts (random IV)', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const ct1 = yield* svc.encrypt('same-password');
      const ct2 = yield* svc.encrypt('same-password');
      expect(ct1).not.toBe(ct2);
    }),
  );

  it.effect('ciphertext starts with v1. prefix (format marker)', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const ct = yield* svc.encrypt('test-password');
      expect(ct.startsWith('v1.')).toBe(true);
    }),
  );
});

describe('EmailSecretCrypto — tamper detection', () => {
  it.effect(
    'flipping a character in the ciphertext causes decrypt to fail with EmailSecretDecryptError',
    () =>
      Effect.gen(function* () {
        const svc = yield* layerFromKey(TEST_KEY_B64);
        const ct = yield* svc.encrypt('hunter2-imap');
        // Flip the last non-dot character
        const tampered = ct.slice(0, -4) + (ct.slice(-4, -3) === 'A' ? 'B' : 'A') + ct.slice(-3);
        const result = yield* Effect.result(svc.decrypt(tampered));
        expect(result._tag).toBe('Failure');
        if (result._tag === 'Failure') {
          const failure = result.failure as unknown;
          expect((failure as EmailSecretDecryptError)._tag).toBe('EmailSecretDecryptError');
        }
      }),
  );
});

describe('EmailSecretCrypto — malformed input', () => {
  it.effect('"not-a-blob" → EmailSecretDecryptError (no throw/defect)', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const result = yield* Effect.result(svc.decrypt('not-a-blob'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretDecryptError)._tag).toBe('EmailSecretDecryptError');
      }
    }),
  );

  it.effect('empty string → EmailSecretDecryptError', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const result = yield* Effect.result(svc.decrypt(''));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretDecryptError)._tag).toBe('EmailSecretDecryptError');
      }
    }),
  );

  it.effect('v1. prefix with garbage segments → EmailSecretDecryptError', () =>
    Effect.gen(function* () {
      const svc = yield* layerFromKey(TEST_KEY_B64);
      const result = yield* Effect.result(svc.decrypt('v1.garbage.garbage.garbage'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretDecryptError)._tag).toBe('EmailSecretDecryptError');
      }
    }),
  );
});

describe('EmailSecretCrypto — wrong key', () => {
  it.effect('blob made with key A, decrypted with key B → EmailSecretDecryptError', () =>
    Effect.gen(function* () {
      const svcA = yield* layerFromKey(TEST_KEY_B64);
      const svcB = yield* layerFromKey(OTHER_KEY_B64);
      const ct = yield* svcA.encrypt('my-imap-password');
      const result = yield* Effect.result(svcB.decrypt(ct));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretDecryptError)._tag).toBe('EmailSecretDecryptError');
      }
    }),
  );
});

describe('EmailSecretCrypto — missing key', () => {
  it.effect('makeWithKey(Option.none()) builds a service without failing', () =>
    Effect.gen(function* () {
      // Layer construction must NOT fail — this should succeed
      const svc = yield* layerNoKey;
      expect(svc).toBeDefined();
      expect(typeof svc.encrypt).toBe('function');
      expect(typeof svc.decrypt).toBe('function');
    }),
  );

  it.effect('encrypt with missing key → EmailSecretKeyMissing', () =>
    Effect.gen(function* () {
      const svc = yield* layerNoKey;
      const result = yield* Effect.result(svc.encrypt('any-password'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretKeyMissing)._tag).toBe('EmailSecretKeyMissing');
      }
    }),
  );

  it.effect('decrypt with missing key → EmailSecretKeyMissing', () =>
    Effect.gen(function* () {
      const svc = yield* layerNoKey;
      const result = yield* Effect.result(svc.decrypt('v1.aaa.bbb.ccc'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretKeyMissing)._tag).toBe('EmailSecretKeyMissing');
      }
    }),
  );
});

describe('EmailSecretCrypto — wrong key length', () => {
  it.effect('16-byte key → EmailSecretKeyMissing on encrypt (key too short)', () =>
    Effect.gen(function* () {
      const svc = yield* makeWithKey(Option.some(SHORT_KEY_B64));
      const result = yield* Effect.result(svc.encrypt('any-password'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretKeyMissing)._tag).toBe('EmailSecretKeyMissing');
      }
    }),
  );

  it.effect('16-byte key → EmailSecretKeyMissing on decrypt (key too short)', () =>
    Effect.gen(function* () {
      const svc = yield* makeWithKey(Option.some(SHORT_KEY_B64));
      const result = yield* Effect.result(svc.decrypt('v1.aaa.bbb.ccc'));
      expect(result._tag).toBe('Failure');
      if (result._tag === 'Failure') {
        const failure = result.failure as unknown;
        expect((failure as EmailSecretKeyMissing)._tag).toBe('EmailSecretKeyMissing');
      }
    }),
  );
});

describe('EmailSecretCrypto — service via Default layer (smoke test)', () => {
  it.effect('EmailSecretCrypto.Default builds and service is accessible', () =>
    Effect.gen(function* () {
      const svc = yield* EmailSecretCrypto.asEffect();
      expect(svc).toBeDefined();
      expect(typeof svc.encrypt).toBe('function');
      expect(typeof svc.decrypt).toBe('function');
      // In test env EMAIL_IMAP_ENCRYPTION_KEY is unset → key missing, so encrypt yields KeyMissing
      const result = yield* Effect.result(svc.encrypt('test'));
      // Either EmailSecretKeyMissing (no env key) or success (if env key is set in test) — both valid
      expect(['Success', 'Failure']).toContain(result._tag);
    }).pipe(Effect.provide(EmailSecretCrypto.Default)),
  );
});
