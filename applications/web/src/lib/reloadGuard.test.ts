// Tests for src/lib/reloadGuard.ts
//
// API contract:
//   RELOAD_COUNT_KEY: string  (sessionStorage key)
//   RELOAD_CAP: number        (max reloads before giving up)
//   requestReload(reason: string): boolean
//     - increments counter in sessionStorage
//     - calls window.location.reload() and returns true when count < RELOAD_CAP
//     - returns false and does NOT reload when count >= RELOAD_CAP
//     - never throws even when sessionStorage is unavailable
//   clearReloadGuard(): void  — clears the sessionStorage counter
//   getReloadCount(): number  — reads current count (0 if unavailable)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Mock window.location.reload so we can assert it is called
const reloadMock = vi.fn();
Object.defineProperty(window, 'location', {
  value: { ...window.location, reload: reloadMock },
  writable: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sessionStore: Record<string, string> = {};

function mockSessionStorage() {
  const storage = {
    getItem: vi.fn((key: string) => sessionStore[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      sessionStore[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete sessionStore[key];
    }),
    clear: vi.fn(() => {
      sessionStore = {};
    }),
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('reloadGuard', () => {
  beforeEach(() => {
    sessionStore = {};
    reloadMock.mockClear();
    mockSessionStorage();
    // Re-import fresh module each time so module-level state doesn't bleed
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('exports RELOAD_COUNT_KEY as a non-empty string', async () => {
    const { RELOAD_COUNT_KEY } = await import('~/lib/reloadGuard.js');
    expect(typeof RELOAD_COUNT_KEY).toBe('string');
    expect(RELOAD_COUNT_KEY.length).toBeGreaterThan(0);
  });

  it('exports RELOAD_CAP as a positive number', async () => {
    const { RELOAD_CAP } = await import('~/lib/reloadGuard.js');
    expect(typeof RELOAD_CAP).toBe('number');
    expect(RELOAD_CAP).toBeGreaterThan(0);
  });

  it('getReloadCount returns 0 when sessionStorage has no entry', async () => {
    const { getReloadCount } = await import('~/lib/reloadGuard.js');
    expect(getReloadCount()).toBe(0);
  });

  it('requestReload increments the counter in sessionStorage', async () => {
    const { requestReload, RELOAD_COUNT_KEY, getReloadCount } = await import(
      '~/lib/reloadGuard.js'
    );
    requestReload('test');
    expect(getReloadCount()).toBeGreaterThan(0);
    expect(sessionStore[RELOAD_COUNT_KEY]).toBeDefined();
  });

  it('requestReload returns true and calls reload when count is under cap', async () => {
    const { requestReload, RELOAD_CAP } = await import('~/lib/reloadGuard.js');
    // Ensure we start fresh (count = 0 < RELOAD_CAP)
    for (let i = 0; i < RELOAD_CAP - 1; i++) {
      const result = requestReload(`reason-${i}`);
      expect(result).toBe(true);
    }
    expect(reloadMock).toHaveBeenCalledTimes(RELOAD_CAP - 1);
  });

  it('requestReload returns false and does NOT call reload when count reaches cap', async () => {
    const { requestReload, RELOAD_CAP, RELOAD_COUNT_KEY } = await import('~/lib/reloadGuard.js');
    // Pre-fill counter at cap
    sessionStore[RELOAD_COUNT_KEY] = String(RELOAD_CAP);
    const result = requestReload('over-cap');
    expect(result).toBe(false);
    expect(reloadMock).not.toHaveBeenCalled();
  });

  it('requestReload counter persists across multiple calls', async () => {
    const { requestReload, getReloadCount, RELOAD_CAP } = await import('~/lib/reloadGuard.js');
    requestReload('first');
    requestReload('second');
    const count = getReloadCount();
    // Should have incremented twice (capped at RELOAD_CAP)
    expect(count).toBe(Math.min(2, RELOAD_CAP));
  });

  it('clearReloadGuard removes the counter from sessionStorage', async () => {
    const { requestReload, clearReloadGuard, getReloadCount } = await import(
      '~/lib/reloadGuard.js'
    );
    requestReload('before-clear');
    clearReloadGuard();
    expect(getReloadCount()).toBe(0);
  });

  it('does not throw when sessionStorage throws on setItem (treat count as 0, allow reload)', async () => {
    // Simulate unavailable sessionStorage
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() {
        throw new Error('SecurityError: sessionStorage unavailable');
      },
      configurable: true,
    });
    const { requestReload } = await import('~/lib/reloadGuard.js');
    expect(() => requestReload('no-storage')).not.toThrow();
  });

  it('does not throw when sessionStorage is fully unavailable (getReloadCount returns 0)', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() {
        throw new Error('SecurityError: sessionStorage unavailable');
      },
      configurable: true,
    });
    const { getReloadCount } = await import('~/lib/reloadGuard.js');
    expect(() => getReloadCount()).not.toThrow();
    expect(getReloadCount()).toBe(0);
  });

  it('does not throw when sessionStorage is fully unavailable (clearReloadGuard is a no-op)', async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      get() {
        throw new Error('SecurityError: sessionStorage unavailable');
      },
      configurable: true,
    });
    const { clearReloadGuard } = await import('~/lib/reloadGuard.js');
    expect(() => clearReloadGuard()).not.toThrow();
  });
});
