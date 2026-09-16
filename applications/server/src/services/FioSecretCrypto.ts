/**
 * D2 / D10 / T3 — a thin service over `secretBox.ts`, parameterised by
 * `FIO_TOKEN_ENCRYPTION_KEY` instead of `EMAIL_IMAP_ENCRYPTION_KEY`. A Fio token is a materially
 * higher-value secret than an IMAP app password, so it gets its own key (never shared with
 * `EmailSecretCrypto`), its own typed errors, and its own blast radius.
 *
 * The one deliberate difference from `EmailSecretCrypto`'s surface: `decrypt` returns
 * `Redacted.Redacted<string>`, not a bare `string` — the Fio token must never be `String()`-
 * coerced or logged by accident anywhere along its path to the URL (D10).
 */
import { Data, Effect, Layer, Option, Redacted, ServiceMap } from 'effect';
import { env } from '~/env.js';
import { decryptWithKey, encryptWithKey, resolveKeyWithKey } from '~/services/secretBox.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class FioSecretKeyMissing extends Data.TaggedError('FioSecretKeyMissing')<{
  readonly message: string;
}> {}

export class FioSecretDecryptError extends Data.TaggedError('FioSecretDecryptError')<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface FioSecretCryptoService {
  readonly encrypt: (plaintext: string) => Effect.Effect<string, FioSecretKeyMissing>;
  readonly decrypt: (
    blob: string,
  ) => Effect.Effect<Redacted.Redacted<string>, FioSecretDecryptError | FioSecretKeyMissing>;
}

// ---------------------------------------------------------------------------
// Key resolution helper (called at use time, not at layer build time)
// ---------------------------------------------------------------------------

const resolveKey = (keyOption: Option.Option<string>): Effect.Effect<Buffer, FioSecretKeyMissing> =>
  resolveKeyWithKey(keyOption, (wrongByteLength) =>
    wrongByteLength === undefined
      ? new FioSecretKeyMissing({ message: 'FIO_TOKEN_ENCRYPTION_KEY is not configured' })
      : new FioSecretKeyMissing({
          message: `FIO_TOKEN_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${String(wrongByteLength)})`,
        }),
  );

// ---------------------------------------------------------------------------
// makeWithKey — test seam: builds the service shape from an Option<string>
// ---------------------------------------------------------------------------

export const makeWithKey = (
  keyOption: Option.Option<string>,
): Effect.Effect<FioSecretCryptoService> =>
  Effect.succeed({
    encrypt: (plaintext: string) =>
      Effect.Do.pipe(
        Effect.bind('key', () => resolveKey(keyOption)),
        Effect.flatMap(({ key }) => encryptWithKey(plaintext, key)),
      ),
    decrypt: (blob: string) =>
      Effect.Do.pipe(
        Effect.bind('key', () => resolveKey(keyOption)),
        Effect.flatMap(({ key }) =>
          decryptWithKey(
            blob,
            key,
            () => new FioSecretDecryptError({ message: 'Decryption failed' }),
          ),
        ),
        Effect.map((plaintext) => Redacted.make(plaintext)),
      ),
  });

// ---------------------------------------------------------------------------
// make — reads key from env at call time
// ---------------------------------------------------------------------------

const make: Effect.Effect<FioSecretCryptoService> = Effect.Do.pipe(
  Effect.let('keyOption', () =>
    Option.map(env.FIO_TOKEN_ENCRYPTION_KEY, (redacted) => Redacted.value(redacted)),
  ),
  Effect.flatMap(({ keyOption }) => makeWithKey(keyOption)),
);

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class FioSecretCrypto extends ServiceMap.Service<FioSecretCrypto, FioSecretCryptoService>()(
  'api/FioSecretCrypto',
) {
  static readonly Default = Layer.effect(FioSecretCrypto, make);
}
