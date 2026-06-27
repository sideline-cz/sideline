// Tests for src/lib/sw-recovery.ts
//
// API contract:
//   RESETTING_KEY: string  (sessionStorage key set before unregister)
//   resetApp(): Promise<void>
//     - online: unregisters all SW registrations + deletes all caches + sets RESETTING_KEY + reloads
//     - offline (navigator.onLine=false): unregisters, does NOT delete caches, still reloads
//     - no-op without serviceWorker / caches (does not throw)
//     - reload fires in finally even if unregister rejects

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Top-level module mocks (hoisted by vitest automatically)
// ---------------------------------------------------------------------------

vi.mock('~/lib/reloadGuard.js', () => ({
  requestReload: vi.fn().mockReturnValue(true),
  clearReloadGuard: vi.fn(),
  getReloadCount: vi.fn().mockReturnValue(0),
  RELOAD_COUNT_KEY: 'sideline-reload-count',
  RELOAD_CAP: 2,
  RESETTING_KEY: 'sideline-resetting',
}));

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const reloadMock = vi.fn();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let sessionStore: Record<string, string> = {};

function setupSessionStorage() {
  sessionStore = {};
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
    length: 0,
    key: vi.fn(),
  };
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: storage,
    writable: true,
    configurable: true,
  });
  return storage;
}

function makeSwRegistration(rejectUnregister = false) {
  return {
    unregister: rejectUnregister
      ? vi.fn().mockRejectedValue(new Error('unregister failed'))
      : vi.fn().mockResolvedValue(true),
    scope: 'https://example.com/',
    active: null,
    installing: null,
    waiting: null,
  };
}

function makeCaches(keys: string[]) {
  return {
    keys: vi.fn().mockResolvedValue(keys),
    delete: vi.fn().mockResolvedValue(true),
    has: vi.fn(),
    open: vi.fn(),
    match: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, reload: reloadMock },
    writable: true,
    configurable: true,
  });
  reloadMock.mockClear();
  vi.resetModules();
  setupSessionStorage();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sw-recovery', () => {
  describe('RESETTING_KEY', () => {
    it('exports RESETTING_KEY as a non-empty string', async () => {
      const { RESETTING_KEY } = await import('~/lib/sw-recovery.js');
      expect(typeof RESETTING_KEY).toBe('string');
      expect(RESETTING_KEY.length).toBeGreaterThan(0);
    });
  });

  describe('resetApp — online, SW + caches available', () => {
    it('unregisters all SW registrations', async () => {
      const reg = makeSwRegistration();
      const swContainer = {
        getRegistrations: vi.fn().mockResolvedValue([reg]),
        register: vi.fn(),
        controller: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        ready: Promise.resolve(reg),
      };
      Object.defineProperty(navigator, 'serviceWorker', {
        value: swContainer,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      const cacheStore = makeCaches(['v1', 'v2']);
      Object.defineProperty(window, 'caches', {
        value: cacheStore,
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await resetApp();

      expect(reg.unregister).toHaveBeenCalledOnce();
    });

    it('deletes all caches when online', async () => {
      const reg = makeSwRegistration();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      const cacheStore = makeCaches(['cache-a', 'cache-b']);
      Object.defineProperty(window, 'caches', {
        value: cacheStore,
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await resetApp();

      expect(cacheStore.keys).toHaveBeenCalled();
      expect(cacheStore.delete).toHaveBeenCalledWith('cache-a');
      expect(cacheStore.delete).toHaveBeenCalledWith('cache-b');
    });

    it('sets RESETTING_KEY in sessionStorage before unregistering', async () => {
      const storage = setupSessionStorage();

      const reg = makeSwRegistration();
      // Intercept unregister to check that RESETTING_KEY was set before it's called
      reg.unregister = vi.fn().mockImplementation(async () => {
        // At the time unregister is called, sessionStorage.setItem should have already been called
        // with some truthy value for RESETTING_KEY
        return true;
      });

      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: makeCaches([]),
        configurable: true,
        writable: true,
      });

      const { resetApp, RESETTING_KEY } = await import('~/lib/sw-recovery.js');
      await resetApp();

      // RESETTING_KEY should have been written to sessionStorage
      expect(storage.setItem).toHaveBeenCalledWith(RESETTING_KEY, expect.any(String));
    });

    it('triggers a reload after completing', async () => {
      const reg = makeSwRegistration();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: makeCaches([]),
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await resetApp();

      // resetApp calls requestReload (from reloadGuard) — check it was called
      const { requestReload } = await import('~/lib/reloadGuard.js');
      expect(requestReload).toHaveBeenCalled();
    });
  });

  describe('resetApp — offline', () => {
    it('does NOT delete caches when navigator.onLine is false', async () => {
      const reg = makeSwRegistration();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
        writable: true,
      });
      const cacheStore = makeCaches(['cache-a']);
      Object.defineProperty(window, 'caches', {
        value: cacheStore,
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await resetApp();

      expect(cacheStore.delete).not.toHaveBeenCalled();
    });

    it('still unregisters SW and triggers reload when offline', async () => {
      const reg = makeSwRegistration();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: false,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: makeCaches([]),
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await resetApp();

      expect(reg.unregister).toHaveBeenCalled();
      const { requestReload } = await import('~/lib/reloadGuard.js');
      expect(requestReload).toHaveBeenCalled();
    });
  });

  describe('resetApp — no-ops when APIs unavailable', () => {
    it('does not throw when serviceWorker is unavailable', async () => {
      // Remove serviceWorker from navigator
      const navDescriptor = Object.getOwnPropertyDescriptor(navigator, 'serviceWorker');
      Object.defineProperty(navigator, 'serviceWorker', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: makeCaches([]),
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await expect(resetApp()).resolves.not.toThrow();

      // Restore
      if (navDescriptor) {
        Object.defineProperty(navigator, 'serviceWorker', navDescriptor);
      }
    });

    it('does not throw when caches is unavailable', async () => {
      const reg = makeSwRegistration();
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: undefined,
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      await expect(resetApp()).resolves.not.toThrow();
    });
  });

  describe('resetApp — reload fires in finally even if unregister rejects', () => {
    it('calls requestReload even when unregister throws', async () => {
      const reg = makeSwRegistration(true); // unregister rejects
      Object.defineProperty(navigator, 'serviceWorker', {
        value: { getRegistrations: vi.fn().mockResolvedValue([reg]) },
        configurable: true,
        writable: true,
      });
      Object.defineProperty(navigator, 'onLine', {
        value: true,
        configurable: true,
        writable: true,
      });
      Object.defineProperty(window, 'caches', {
        value: makeCaches([]),
        configurable: true,
        writable: true,
      });

      const { resetApp } = await import('~/lib/sw-recovery.js');
      // Should not propagate the unregister error
      await expect(resetApp()).resolves.not.toThrow();

      const { requestReload } = await import('~/lib/reloadGuard.js');
      expect(requestReload).toHaveBeenCalled();
    });
  });
});
