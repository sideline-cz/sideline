import { createHash, randomBytes } from 'node:crypto';
import { Effect } from 'effect';

const TOKEN_BYTES = 32; // 256-bit

export const generateOnboardingToken = (): Effect.Effect<{ token: string; hash: string }> =>
  Effect.sync(() => {
    const token = randomBytes(TOKEN_BYTES).toString('base64url');
    return { token, hash: hashToken(token) };
  });

export const hashToken = (token: string): string =>
  createHash('sha256').update(token).digest('hex');
