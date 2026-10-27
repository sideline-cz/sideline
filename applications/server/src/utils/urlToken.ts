/**
 * The one place a URL-borne secret is minted and hashed.
 *
 * 32 bytes from `node:crypto`'s `randomBytes` — a CSPRNG — so 256 bits of entropy,
 * base64url-encoded to survive a query string or path segment untouched. Only
 * `sha256(token)` is ever persisted; the plaintext exists in the link and nowhere else.
 *
 * Callers compare by looking the HASH up, never by comparing the secret, so no
 * constant-time comparison is needed: a timing oracle on a hash lookup is worth nothing
 * without a preimage.
 */
import { createHash, randomBytes } from 'node:crypto';
import { Effect } from 'effect';

const TOKEN_BYTES = 32; // 256-bit

export const generateUrlToken = (): Effect.Effect<{ token: string; hash: string }> =>
  Effect.sync(() => {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: hashToken(token) };
  });

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
