import { Data, Effect, Layer, Option, Redacted, ServiceMap } from 'effect';
import { env } from '~/env.js';
import { decryptWithKey, encryptWithKey, resolveKeyWithKey } from '~/services/secretBox.js';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class EmailSecretKeyMissing extends Data.TaggedError('EmailSecretKeyMissing')<{
  readonly message: string;
}> {}

export class EmailSecretDecryptError extends Data.TaggedError('EmailSecretDecryptError')<{
  readonly message: string;
}> {}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

interface EmailSecretCryptoService {
  readonly encrypt: (plaintext: string) => Effect.Effect<string, EmailSecretKeyMissing>;
  readonly decrypt: (
    blob: string,
  ) => Effect.Effect<string, EmailSecretDecryptError | EmailSecretKeyMissing>;
}

// ---------------------------------------------------------------------------
// Key resolution helper (called at use time, not at layer build time)
// ---------------------------------------------------------------------------

const resolveKey = (
  keyOption: Option.Option<string>,
): Effect.Effect<Buffer, EmailSecretKeyMissing> =>
  resolveKeyWithKey(keyOption, (wrongByteLength) =>
    wrongByteLength === undefined
      ? new EmailSecretKeyMissing({ message: 'EMAIL_IMAP_ENCRYPTION_KEY is not configured' })
      : new EmailSecretKeyMissing({
          message: `EMAIL_IMAP_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${String(wrongByteLength)})`,
        }),
  );

// ---------------------------------------------------------------------------
// makeWithKey — test seam: builds the service shape from an Option<string>
// ---------------------------------------------------------------------------

export const makeWithKey = (
  keyOption: Option.Option<string>,
): Effect.Effect<EmailSecretCryptoService> =>
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
            () => new EmailSecretDecryptError({ message: 'Decryption failed' }),
          ),
        ),
      ),
  });

// ---------------------------------------------------------------------------
// make — reads key from env at call time
// ---------------------------------------------------------------------------

const make: Effect.Effect<EmailSecretCryptoService> = Effect.Do.pipe(
  Effect.let('keyOption', () =>
    Option.map(env.EMAIL_IMAP_ENCRYPTION_KEY, (redacted) => Redacted.value(redacted)),
  ),
  Effect.flatMap(({ keyOption }) => makeWithKey(keyOption)),
);

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class EmailSecretCrypto extends ServiceMap.Service<
  EmailSecretCrypto,
  EmailSecretCryptoService
>()('api/EmailSecretCrypto') {
  static readonly Default = Layer.effect(EmailSecretCrypto, make);
}
