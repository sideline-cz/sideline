import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Data, Effect, Layer, Option, Redacted, ServiceMap } from 'effect';
import { env } from '~/env.js';

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
): Effect.Effect<Buffer, EmailSecretKeyMissing> => {
  if (Option.isNone(keyOption)) {
    return Effect.fail(
      new EmailSecretKeyMissing({ message: 'EMAIL_IMAP_ENCRYPTION_KEY is not configured' }),
    );
  }
  const keyBuf = Buffer.from(keyOption.value, 'base64');
  if (keyBuf.byteLength !== 32) {
    return Effect.fail(
      new EmailSecretKeyMissing({
        message: `EMAIL_IMAP_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${String(keyBuf.byteLength)})`,
      }),
    );
  }
  return Effect.succeed(keyBuf);
};

// ---------------------------------------------------------------------------
// Core AES-256-GCM encrypt / decrypt
// ---------------------------------------------------------------------------

const encryptWithKey = (plaintext: string, key: Buffer): Effect.Effect<string, never> =>
  Effect.sync(() => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
  });

const decryptWithKey = (
  blob: string,
  key: Buffer,
): Effect.Effect<string, EmailSecretDecryptError> => {
  return Effect.try({
    try: () => {
      if (!blob.startsWith('v1.')) {
        throw new Error('Invalid format: expected v1. prefix');
      }
      const parts = blob.split('.');
      // format: v1.<iv>.<tag>.<ct> → 4 parts after split
      if (parts.length !== 4) {
        throw new Error('Invalid format: expected 4 parts');
      }
      const iv = Buffer.from(parts[1]!, 'base64url');
      const tag = Buffer.from(parts[2]!, 'base64url');
      const ct = Buffer.from(parts[3]!, 'base64url');
      const decipher = createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]);
      return plain.toString('utf8');
    },
    catch: () => new EmailSecretDecryptError({ message: 'Decryption failed' }),
  });
};

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
        Effect.flatMap(({ key }) => decryptWithKey(blob, key)),
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
