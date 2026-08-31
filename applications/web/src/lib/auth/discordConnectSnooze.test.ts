// PR-9 (Discord onboarding fix) — the "Skip for now" snooze storage. The single most important
// property under test: a `localStorage` throw is treated as SNOOZED (fail open), never as
// un-snoozed — that is what prevents Safari private mode from trapping a user in a redirect
// loop between `/teams/$teamId` and `/teams/$teamId/connect-discord`.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  discordConnectSkipCount,
  isDiscordConnectSnoozed,
  snoozeDiscordConnect,
} from './discordConnectSnooze.js';

const USER_ID = 'user-1';
const TEAM_ID = 'team-1';
const OTHER_TEAM_ID = 'team-2';

describe('discordConnectSnooze', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('is not snoozed when nothing has been recorded', () => {
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(false);
  });

  it('is snoozed immediately after snoozeDiscordConnect', () => {
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(true);
  });

  it('scopes the snooze to the (user, team) pair — a different team is unaffected', () => {
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    expect(isDiscordConnectSnoozed(USER_ID, OTHER_TEAM_ID)).toBe(false);
  });

  it('scopes the snooze per user — a shared-device second user is unaffected', () => {
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    expect(isDiscordConnectSnoozed('user-2', TEAM_ID)).toBe(false);
  });

  it('expires the snooze after its window elapses (24h for an early skip)', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(true);

    vi.setSystemTime(new Date(now.getTime() + 25 * 60 * 60 * 1000));
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(false);
    vi.useRealTimers();
  });

  it('escalates to a 7-day snooze after the third skip', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.useFakeTimers();
    vi.setSystemTime(now);

    snoozeDiscordConnect(USER_ID, TEAM_ID); // skip 1 — 24h
    snoozeDiscordConnect(USER_ID, TEAM_ID); // skip 2 — 24h
    snoozeDiscordConnect(USER_ID, TEAM_ID); // skip 3 — 24h
    snoozeDiscordConnect(USER_ID, TEAM_ID); // skip 4 — 7 days

    // 25h later: the first-three-skips window would have expired, but skip 4's 7-day window
    // has not.
    vi.setSystemTime(new Date(now.getTime() + 25 * 60 * 60 * 1000));
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(true);

    vi.setSystemTime(new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000));
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(false);
    vi.useRealTimers();
  });

  it('tracks the skip count', () => {
    expect(discordConnectSkipCount(USER_ID, TEAM_ID)).toBe(0);
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    snoozeDiscordConnect(USER_ID, TEAM_ID);
    expect(discordConnectSkipCount(USER_ID, TEAM_ID)).toBe(2);
  });

  // The load-bearing test: a throw from `getItem` must be treated as snoozed, not unsnoozed —
  // never trap a user in a redirect loop because Safari private mode threw. Overrides
  // `globalThis.localStorage` directly (matches `resolveStoredTheme.test.ts`'s precedent) rather
  // than `vi.spyOn(Storage.prototype, ...)`, since `test/setup.ts` installs a plain in-memory
  // object as `localStorage`, not a real `Storage` instance.
  it('treats a localStorage.getItem throw as snoozed (fail open)', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => {
          throw new DOMException('SecurityError');
        },
        setItem: () => {},
      },
      writable: true,
      configurable: true,
    });
    expect(isDiscordConnectSnoozed(USER_ID, TEAM_ID)).toBe(true);
    Object.defineProperty(globalThis, 'localStorage', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  it('does not throw when localStorage.setItem throws — the snooze click never crashes', () => {
    const original = globalThis.localStorage;
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('QuotaExceededError');
        },
      },
      writable: true,
      configurable: true,
    });
    expect(() => snoozeDiscordConnect(USER_ID, TEAM_ID)).not.toThrow();
    Object.defineProperty(globalThis, 'localStorage', {
      value: original,
      writable: true,
      configurable: true,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });
});
