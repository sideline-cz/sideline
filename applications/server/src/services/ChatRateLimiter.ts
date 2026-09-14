/**
 * `ChatRateLimiter` — in-process fixed-window rate limiter for the AI chat endpoint, plan
 * `.work-plans/ai-app-interaction.md` §10: 20 chat turns / 10 minutes and 120 / day, keyed by
 * `Auth.UserId`.
 *
 * Shape pinned by `test/api/ai-chat.test.ts`'s header comment (note 1), since the plan only
 * prose-specifies the behaviour, not a code shape: `check(userId)` returns `Option.none()` when
 * the call is allowed — and, in the same call, spends one unit of BOTH windows' budget — or
 * `Option.some(retryAfterSeconds)` when either window is already exhausted, where
 * `retryAfterSeconds` is the whole seconds remaining in the violated window. A rejected call
 * (`Option.some`) does not consume any budget.
 *
 * **Honest caveat: this is per-replica** (plan §10, documented for operators under
 * `AI_CHAT_ENABLED` in `docs/deployment.md`) — the effective limit across a fleet is
 * `replicas × limit`. Accepted for this slice because the real cost bound is per-request
 * (`MAX_TOOL_ITERATIONS = 5` model calls, `max_tokens = 450` in `ChatAgent.ts`). Follows the
 * injectable-config precedent (`GlobalAdminAllowlist`): callers needing different limits build
 * their own layer with `make`, and `ai-chat.test.ts` overrides the whole service with
 * `Layer.succeed` rather than touching these constants.
 */
import type { Auth } from '@sideline/domain';
import { Effect, Layer, Option, ServiceMap } from 'effect';

export interface ChatRateLimiterShape {
  readonly check: (userId: Auth.UserId) => Effect.Effect<Option.Option<number>>;
}

interface WindowConfig {
  readonly windowMs: number;
  readonly limit: number;
}

interface WindowState {
  windowStart: number;
  count: number;
}

interface UserWindows {
  readonly short: WindowState;
  readonly day: WindowState;
}

export const SHORT_WINDOW: WindowConfig = { windowMs: 10 * 60 * 1000, limit: 20 };
export const DAY_WINDOW: WindowConfig = { windowMs: 24 * 60 * 60 * 1000, limit: 120 };

/**
 * Rolls `state` forward to a fresh window (resetting its count to 0) if `now` has moved past the
 * window that started at `state.windowStart`, then reports whether the window is at or over its
 * limit and the whole seconds remaining before it next resets. Mutates `state` in place — callers
 * own exclusivity per user via the single-threaded `Map` in `make` below.
 */
const rollWindow = (
  state: WindowState,
  config: WindowConfig,
  now: number,
): { readonly exceeded: boolean; readonly retryAfterSeconds: number } => {
  if (now - state.windowStart >= config.windowMs) {
    state.windowStart = now;
    state.count = 0;
  }
  return {
    exceeded: state.count >= config.limit,
    retryAfterSeconds: Math.ceil((state.windowStart + config.windowMs - now) / 1000),
  };
};

// Sweep the `windows` map every this many `check` calls (CONCERN 4): unlike `short`/`day`'s
// per-user state, `windows` itself has no eviction at all — every distinct `Auth.UserId` that
// ever calls `check` gets a permanent entry for the process's lifetime. Sampling on every call
// would mean walking the whole map on every request; sweeping every N calls amortises that cost
// down to effectively free while still bounding the map's peak size to roughly
// "active users in the last day, plus SWEEP_INTERVAL stragglers".
export const SWEEP_INTERVAL = 500;

/**
 * Builds a `check` function backed by the given `windows` map (no `Ref` needed — Node's
 * single-threaded event loop means one `Effect.sync` callback runs to completion before the next
 * request's does). Factored out from `make`/`makeForTest` so the latter can hand the test a
 * reference to the SAME map `check` mutates, without exposing it from the public `make`.
 */
const buildLimiter = (
  short: WindowConfig,
  day: WindowConfig,
  windows: Map<Auth.UserId, UserWindows>,
): ChatRateLimiterShape => {
  let callsSinceSweep = 0;

  /** Evicts every entry whose `day` window is older than the day window's own length — i.e. a
   * user who has made no request in at least a full day window, so their entry carries no budget
   * information a fresh entry wouldn't reconstruct identically on their next request. */
  const sweep = (now: number): void => {
    for (const [userId, entry] of windows) {
      if (now - entry.day.windowStart >= day.windowMs) {
        windows.delete(userId);
      }
    }
  };

  return {
    check: (userId) =>
      Effect.sync(() => {
        const now = Date.now();
        const entry = windows.get(userId) ?? {
          short: { windowStart: now, count: 0 },
          day: { windowStart: now, count: 0 },
        };
        windows.set(userId, entry);

        const shortResult = rollWindow(entry.short, short, now);
        const dayResult = rollWindow(entry.day, day, now);

        callsSinceSweep += 1;
        if (callsSinceSweep >= SWEEP_INTERVAL) {
          callsSinceSweep = 0;
          sweep(now);
        }

        if (shortResult.exceeded || dayResult.exceeded) {
          return Option.some(
            Math.max(
              shortResult.exceeded ? shortResult.retryAfterSeconds : 0,
              dayResult.exceeded ? dayResult.retryAfterSeconds : 0,
            ),
          );
        }

        entry.short.count += 1;
        entry.day.count += 1;
        return Option.none();
      }),
  };
};

export const make = (short: WindowConfig, day: WindowConfig): ChatRateLimiterShape =>
  buildLimiter(short, day, new Map());

/**
 * Test-only: identical to `make`, but also returns `windowsSizeForTest`, a live view of the
 * backing map's size. `check`'s return value alone cannot distinguish "the stale entry was
 * evicted and a fresh one created" from "the stale entry's windows simply rolled forward in
 * place" — both look identical from the outside — so `ChatRateLimiter.test.ts` uses this to
 * assert the periodic sweep (CONCERN 4) actually shrinks the map.
 */
export const makeForTest = (
  short: WindowConfig,
  day: WindowConfig,
): ChatRateLimiterShape & { readonly windowsSizeForTest: () => number } => {
  const windows = new Map<Auth.UserId, UserWindows>();
  return { ...buildLimiter(short, day, windows), windowsSizeForTest: () => windows.size };
};

export class ChatRateLimiter extends ServiceMap.Service<ChatRateLimiter, ChatRateLimiterShape>()(
  'api/ChatRateLimiter',
) {
  static readonly Default = Layer.sync(ChatRateLimiter, () => make(SHORT_WINDOW, DAY_WINDOW));
}
