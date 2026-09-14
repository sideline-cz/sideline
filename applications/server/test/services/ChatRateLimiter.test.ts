// Unit tests for `ChatRateLimiter`'s pure `make` — plan `.work-plans/ai-app-interaction.md` §10.
//
// `check` is an `Effect.Effect<Option.Option<number>>` built from `Effect.sync`, so it is run
// synchronously via `Effect.runSync` rather than through `it.effect`/`TestClock` — time is
// controlled with `vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime`, the same
// pattern `EventRsvp.test.ts` uses for `Date`-based (not `Clock`-based) time-sensitive code.

import type { Auth } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DAY_WINDOW,
  make,
  makeForTest,
  SHORT_WINDOW,
  SWEEP_INTERVAL,
} from '~/services/ChatRateLimiter.js';

const userId = (n: number): Auth.UserId =>
  `00000000-0000-0000-0000-${String(n).padStart(12, '0')}` as Auth.UserId;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatRateLimiter.make — basic window behaviour', () => {
  it('allows calls under both limits, spending one unit of each window per call', () => {
    const limiter = make(SHORT_WINDOW, DAY_WINDOW);
    const id = userId(1);
    for (let i = 0; i < SHORT_WINDOW.limit; i += 1) {
      expect(Option.isNone(Effect.runSync(limiter.check(id)))).toBe(true);
    }
    // The (limit + 1)th call within the same short window is rejected.
    const rejected = Effect.runSync(limiter.check(id));
    expect(Option.isSome(rejected)).toBe(true);
  });

  it('a rejected call does not spend any budget — the next window rolls it back to allowed', () => {
    const limiter = make({ windowMs: 1000, limit: 1 }, DAY_WINDOW);
    const id = userId(2);
    expect(Option.isNone(Effect.runSync(limiter.check(id)))).toBe(true);
    expect(Option.isSome(Effect.runSync(limiter.check(id)))).toBe(true);
    vi.setSystemTime(new Date(Date.now() + 1001));
    expect(Option.isNone(Effect.runSync(limiter.check(id)))).toBe(true);
  });
});

describe('ChatRateLimiter.make — window map eviction (CONCERN 4)', () => {
  it('the periodic sweep evicts a stale entry, keeping the map smaller than "every user ever seen"', () => {
    const shortConfig = { windowMs: 1000, limit: 1000 };
    const dayConfig = { windowMs: 10_000, limit: 1000 };
    const limiter = makeForTest(shortConfig, dayConfig);

    // One user makes a single call, then goes quiet for longer than the day window.
    const staleUser = userId(3);
    Effect.runSync(limiter.check(staleUser));
    expect(limiter.windowsSizeForTest()).toBe(1);

    vi.setSystemTime(new Date(Date.now() + dayConfig.windowMs + 1));

    // Drive exactly SWEEP_INTERVAL calls from SWEEP_INTERVAL distinct new users. WITHOUT
    // eviction the map would end up holding 1 (stale) + SWEEP_INTERVAL (fresh) entries — the
    // periodic sweep these calls trigger removes `staleUser`'s entry partway through, so the
    // map ends up with exactly SWEEP_INTERVAL entries instead of SWEEP_INTERVAL + 1.
    for (let i = 0; i < SWEEP_INTERVAL; i += 1) {
      Effect.runSync(limiter.check(userId(1000 + i)));
    }
    expect(limiter.windowsSizeForTest()).toBe(SWEEP_INTERVAL);
  });
});
