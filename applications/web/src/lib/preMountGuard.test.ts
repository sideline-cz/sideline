// Tests for src/lib/preMountGuard.ts
//
// API contract:
//   WATCHDOG_MS: number                   (10000)
//   MOUNTED_FLAG: string                  ("__SIDELINE_MOUNTED__")
//   PRE_MOUNT_GUARD_SOURCE: string        (ES5 IIFE source; eval()-able in jsdom)
//   markAppMounted(): void                (sets MOUNTED_FLAG, clears watchdog timer — does NOT clear reload guard)
//   markRouteHealthy(): void              (clears reload guard — call from a successful child route)
//
// The IIFE behaviour under test (eval in jsdom sandbox):
//   - sets window[MOUNTED_FLAG] = false
//   - starts a setTimeout for WATCHDOG_MS; on fire:
//       if not mounted and not crashed → injects recovery HTML (contains Reload + Reset buttons)
//       if mounted or crashed → does NOT inject
//   - vite:preloadError dispatch → one reload under cap, else shows recovery HTML
//   - window.onerror / onunhandledrejection before mount → buffer to window.__SIDELINE_PENDING_ERRORS__

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
// Helpers
// ---------------------------------------------------------------------------

let sessionStore: Record<string, string> = {};

function setupSessionStorage() {
  sessionStore = {};
  Object.defineProperty(globalThis, 'sessionStorage', {
    value: {
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
    },
    writable: true,
    configurable: true,
  });
}

function cleanupGlobals() {
  // Clean up window globals that the IIFE sets
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const w = window as any;
  delete w.__SIDELINE_MOUNTED__;
  delete w.__SIDELINE_CRASHED__;
  delete w.__SIDELINE_PENDING_ERRORS__;
  delete w.__SIDELINE_OTLP__;
}

beforeEach(() => {
  setupSessionStorage();
  cleanupGlobals();
  vi.useFakeTimers();
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  cleanupGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('preMountGuard', () => {
  describe('constants', () => {
    it('exports WATCHDOG_MS as 10000', async () => {
      const { WATCHDOG_MS } = await import('~/lib/preMountGuard.js');
      expect(WATCHDOG_MS).toBe(10000);
    });

    it('exports MOUNTED_FLAG as "__SIDELINE_MOUNTED__"', async () => {
      const { MOUNTED_FLAG } = await import('~/lib/preMountGuard.js');
      expect(MOUNTED_FLAG).toBe('__SIDELINE_MOUNTED__');
    });

    it('exports PRE_MOUNT_GUARD_SOURCE as a non-empty string', async () => {
      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');
      expect(typeof PRE_MOUNT_GUARD_SOURCE).toBe('string');
      expect(PRE_MOUNT_GUARD_SOURCE.length).toBeGreaterThan(0);
    });
  });

  describe('PRE_MOUNT_GUARD_SOURCE IIFE', () => {
    it('is valid JavaScript that can be eval()-ed without syntax errors', async () => {
      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');
      expect(() => {
        // Wrap in a function to avoid polluting the global scope with let/const
        // The source is an IIFE so it is self-contained
        new Function(PRE_MOUNT_GUARD_SOURCE)();
      }).not.toThrow();
    });

    it('sets window.__SIDELINE_MOUNTED__ = false when eval()-ed', async () => {
      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).__SIDELINE_MOUNTED__).toBe(false);
    });

    it('watchdog fires after WATCHDOG_MS and injects recovery HTML when not mounted', async () => {
      const { PRE_MOUNT_GUARD_SOURCE, WATCHDOG_MS } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).__SIDELINE_MOUNTED__).toBe(false);

      // Advance timer past watchdog timeout
      vi.advanceTimersByTime(WATCHDOG_MS + 100);

      // Recovery HTML should have been injected into document.body
      expect(document.body.innerHTML).not.toBe('');
      // Should contain some form of action buttons
      const bodyText = document.body.textContent ?? '';
      // The recovery UI should mention reload/reset in some form
      expect(bodyText.toLowerCase()).toMatch(/reload|reset/i);
    });

    it('watchdog does NOT inject recovery HTML when MOUNTED_FLAG is true', async () => {
      const { PRE_MOUNT_GUARD_SOURCE, WATCHDOG_MS } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      // Simulate successful mount before watchdog fires
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__SIDELINE_MOUNTED__ = true;

      document.body.innerHTML = '';
      vi.advanceTimersByTime(WATCHDOG_MS + 100);

      // No recovery HTML should have been injected
      expect(document.body.innerHTML).toBe('');
    });

    it('watchdog does NOT inject recovery HTML when __SIDELINE_CRASHED__ is true', async () => {
      const { PRE_MOUNT_GUARD_SOURCE, WATCHDOG_MS } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      // Simulate crash flag being set
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__SIDELINE_CRASHED__ = true;

      document.body.innerHTML = '';
      vi.advanceTimersByTime(WATCHDOG_MS + 100);

      expect(document.body.innerHTML).toBe('');
    });

    it('vite:preloadError dispatch triggers a reload when under cap', async () => {
      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');

      // Stub sessionStorage to track reload count (start at 0)
      setupSessionStorage();
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
        configurable: true,
      });

      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      const event = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(event);

      // Either reload was called or it fell through to recovery UI (under cap → reload)
      // Since sessionStorage starts at 0 (under cap of 2), a reload should be triggered
      // (The IIFE reads sessionStorage directly, so we check the mock)
      expect(reloadMock).toHaveBeenCalled();
    });

    it('vite:preloadError dispatch shows recovery HTML when over reload cap', async () => {
      // Pre-fill reload count at cap (2) so reload is skipped
      sessionStore['sideline-reload-count'] = '2';
      const reloadMock = vi.fn();
      Object.defineProperty(window, 'location', {
        value: { ...window.location, reload: reloadMock },
        writable: true,
        configurable: true,
      });

      document.body.innerHTML = '';

      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      const event = new Event('vite:preloadError', { cancelable: true });
      window.dispatchEvent(event);

      // Should NOT reload — should inject recovery HTML instead
      expect(reloadMock).not.toHaveBeenCalled();
      expect(document.body.innerHTML).not.toBe('');
    });

    it('window.onerror before mount buffers errors to window.__SIDELINE_PENDING_ERRORS__', async () => {
      const { PRE_MOUNT_GUARD_SOURCE } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      // Simulate a pre-mount error via window.onerror
      window.onerror?.('Something broke', 'app.js', 10, 5, new Error('Something broke'));

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const pending = (window as any).__SIDELINE_PENDING_ERRORS__;
      expect(Array.isArray(pending)).toBe(true);
      expect(pending.length).toBeGreaterThan(0);
    });
  });

  describe('markAppMounted', () => {
    it('sets window.__SIDELINE_MOUNTED__ to true', async () => {
      const { PRE_MOUNT_GUARD_SOURCE, markAppMounted } = await import('~/lib/preMountGuard.js');
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);
      markAppMounted();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).__SIDELINE_MOUNTED__).toBe(true);
    });

    it('prevents watchdog from injecting recovery HTML after markAppMounted is called', async () => {
      const { PRE_MOUNT_GUARD_SOURCE, markAppMounted, WATCHDOG_MS } = await import(
        '~/lib/preMountGuard.js'
      );
      // biome-ignore lint/security/noGlobalEval: intentionally evaluating the self-contained pre-mount guard IIFE source under test
      eval(PRE_MOUNT_GUARD_SOURCE);

      markAppMounted();
      document.body.innerHTML = '';
      vi.advanceTimersByTime(WATCHDOG_MS + 100);

      expect(document.body.innerHTML).toBe('');
    });

    it('does NOT clear the reload guard — that is done by markRouteHealthy', async () => {
      const { markAppMounted } = await import('~/lib/preMountGuard.js');
      const { clearReloadGuard } = await import('~/lib/reloadGuard.js');

      markAppMounted();

      expect(clearReloadGuard).not.toHaveBeenCalled();
    });

    it('markRouteHealthy clears the reload guard', async () => {
      const { markRouteHealthy } = await import('~/lib/preMountGuard.js');
      const { clearReloadGuard } = await import('~/lib/reloadGuard.js');

      markRouteHealthy();

      expect(clearReloadGuard).toHaveBeenCalled();
    });
  });
});
