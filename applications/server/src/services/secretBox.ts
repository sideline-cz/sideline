/**
 * D2 — the key-agnostic AES-256-GCM primitives shared by `EmailSecretCrypto` and
 * `FioSecretCrypto`. Extracted verbatim from `EmailSecretCrypto.ts` (byte-for-byte behaviour
 * preserved) so the two services can each hold their own key and their own typed errors while
 * sharing exactly one GCM implementation.
 *
 * Pure with respect to the *algorithm* — every function here takes its key and its error
 * constructors as parameters and never reads `env` itself. `EmailSecretCrypto` and
 * `FioSecretCrypto` are thin wrappers that resolve their own env var and typed error tags and
 * delegate here.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Effect, Option } from 'effect';

/**
 * Resolves a base64-encoded 32-byte key from an `Option<string>`, failing with `onMissing()` if
 * the option is `None` or the decoded key is not exactly 32 bytes. `onMissing` receives the
 * decoded byte length when the key IS present but the wrong length, so callers can report it
 * (e.g. `FioSecretKeyMissing`'s message contains the byte count — see its test).
 */
export const resolveKeyWithKey = <E>(
  keyOption: Option.Option<string>,
  onMissing: (wrongByteLength: number | undefined) => E,
): Effect.Effect<Buffer, E> => {
  if (Option.isNone(keyOption)) {
    return Effect.fail(onMissing(undefined));
  }
  const keyBuf = Buffer.from(keyOption.value, 'base64');
  if (keyBuf.byteLength !== 32) {
    return Effect.fail(onMissing(keyBuf.byteLength));
  }
  return Effect.succeed(keyBuf);
};

/** `v1.<iv>.<tag>.<ct>`, each part base64url — random 12-byte IV per call. */
export const encryptWithKey = (plaintext: string, key: Buffer): Effect.Effect<string, never> =>
  Effect.sync(() => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${ct.toString('base64url')}`;
  });

/** Decrypts a `v1.<iv>.<tag>.<ct>` blob, failing with `onDecryptError()` on any malformed input,
 * auth-tag mismatch, or wrong key — never throws. */
export const decryptWithKey = <E>(
  blob: string,
  key: Buffer,
  onDecryptError: () => E,
): Effect.Effect<string, E> =>
  Effect.try({
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
    catch: () => onDecryptError(),
  });
