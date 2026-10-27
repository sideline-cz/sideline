/**
 * Rate limit for the bot's `/login` command, keyed by `Auth.UserId`.
 *
 * Reuses `ChatRateLimiter`'s window machinery verbatim — only the numbers differ — so
 * there is one fixed-window implementation in this codebase, not two.
 *
 * **The counter is not the real bound, and saying otherwise would overstate it.** Like
 * `ChatRateLimiter` this is per-replica, so a fleet of N allows `N × SHORT_WINDOW.limit`.
 * What actually caps the damage is structural: `DiscordLoginTokensRepository.issue`
 * revokes every outstanding link before writing a new one, so however fast the command is
 * spammed, **exactly one live token exists at a time**. The limiter only keeps log and
 * row churn bounded.
 */

import { Layer, ServiceMap } from 'effect';
import { type ChatRateLimiterShape, make } from '~/services/ChatRateLimiter.js';

/** A human needs one link. Five absorbs "I clicked the wrong thing" and "it expired while
 * I was away" without turning the command into a credential-generation endpoint. */
export const SHORT_WINDOW = { windowMs: 60 * 60 * 1000, limit: 5 };
export const DAY_WINDOW = { windowMs: 24 * 60 * 60 * 1000, limit: 20 };

export class LoginLinkRateLimiter extends ServiceMap.Service<
  LoginLinkRateLimiter,
  ChatRateLimiterShape
>()('api/LoginLinkRateLimiter') {
  static readonly Default = Layer.sync(LoginLinkRateLimiter, () => make(SHORT_WINDOW, DAY_WINDOW));
}
