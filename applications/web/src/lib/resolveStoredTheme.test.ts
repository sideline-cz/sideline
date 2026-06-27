// Tests for src/lib/resolveStoredTheme.ts
//
// API contract:
//   resolveStoredTheme(): 'dark' | 'light'
//     - returns 'dark'  when localStorage['sideline-theme'] === 'dark'
//     - returns 'light' when localStorage['sideline-theme'] === 'light'
//     - falls back to matchMedia when stored value is 'system'
//     - falls back to matchMedia when localStorage has no entry
//     - falls back to 'dark' when both localStorage and matchMedia are unavailable
//     - never throws
//   reassertThemeOnDocument(): void
//     - adds .dark class + sets colorScheme/backgroundColor for dark theme
//     - removes .dark class + sets colorScheme/backgroundColor for light theme
//     - never throws

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let localStore: Record<string, string> = {};

function setupLocalStorage(store: Record<string, string> = {}) {
  localStore = { ...store };
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: vi.fn((key: string) => localStore[key] ?? null),
      setItem: vi.fn((key: string, value: string) => {
        localStore[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
        delete localStore[key];
      }),
      clear: vi.fn(() => {
        localStore = {};
      }),
    },
    writable: true,
    configurable: true,
  });
}

function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockReturnValue({ matches: prefersDark }),
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules();
  setupLocalStorage();
  mockMatchMedia(false); // default: OS=light
});

afterEach(() => {
  vi.restoreAllMocks();
  // Reset html element state
  document.documentElement.classList.remove('dark');
  document.documentElement.style.removeProperty('background-color');
  document.documentElement.style.removeProperty('color-scheme');
  if (document.body) {
    document.body.style.removeProperty('background-color');
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('resolveStoredTheme', () => {
  it('returns "dark" when localStorage has sideline-theme=dark (even with OS=light)', async () => {
    setupLocalStorage({ 'sideline-theme': 'dark' });
    mockMatchMedia(false); // OS=light
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('dark');
  });

  it('returns "light" when localStorage has sideline-theme=light (even with OS=dark)', async () => {
    setupLocalStorage({ 'sideline-theme': 'light' });
    mockMatchMedia(true); // OS=dark
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('light');
  });

  it('falls back to OS dark when localStorage has sideline-theme=system', async () => {
    setupLocalStorage({ 'sideline-theme': 'system' });
    mockMatchMedia(true); // OS=dark
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('dark');
  });

  it('falls back to OS light when localStorage has sideline-theme=system and OS=light', async () => {
    setupLocalStorage({ 'sideline-theme': 'system' });
    mockMatchMedia(false); // OS=light
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('light');
  });

  it('falls back to OS preference when localStorage has no entry', async () => {
    setupLocalStorage({}); // no sideline-theme
    mockMatchMedia(true); // OS=dark
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('dark');
  });

  it('falls back to OS light when localStorage is empty and OS=light', async () => {
    setupLocalStorage({});
    mockMatchMedia(false); // OS=light
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(resolveStoredTheme()).toBe('light');
  });

  it('falls back to "dark" when localStorage throws', async () => {
    Object.defineProperty(globalThis, 'localStorage', {
      get() {
        throw new Error('SecurityError: localStorage unavailable');
      },
      configurable: true,
    });
    // Also make matchMedia unavailable so we test the ultimate fallback
    Object.defineProperty(window, 'matchMedia', {
      value: undefined,
      writable: true,
      configurable: true,
    });
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(() => resolveStoredTheme()).not.toThrow();
    expect(resolveStoredTheme()).toBe('dark');
  });

  it('never throws even when matchMedia throws', async () => {
    setupLocalStorage({ 'sideline-theme': 'system' });
    Object.defineProperty(window, 'matchMedia', {
      value: vi.fn().mockImplementation(() => {
        throw new Error('matchMedia exploded');
      }),
      writable: true,
      configurable: true,
    });
    const { resolveStoredTheme } = await import('~/lib/resolveStoredTheme.js');
    expect(() => resolveStoredTheme()).not.toThrow();
  });
});

describe('reassertThemeOnDocument', () => {
  it('adds .dark class and sets dark colorScheme when theme is dark', async () => {
    setupLocalStorage({ 'sideline-theme': 'dark' });
    const { reassertThemeOnDocument } = await import('~/lib/resolveStoredTheme.js');
    reassertThemeOnDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    // jsdom normalizes hex colors to rgb() — check it is non-empty (was set)
    expect(document.documentElement.style.backgroundColor).toBeTruthy();
    expect(document.documentElement.style.colorScheme).toBe('dark');
  });

  it('removes .dark class and sets light colorScheme when theme is light', async () => {
    setupLocalStorage({ 'sideline-theme': 'light' });
    document.documentElement.classList.add('dark'); // pre-add to test removal
    const { reassertThemeOnDocument } = await import('~/lib/resolveStoredTheme.js');
    reassertThemeOnDocument();
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(document.documentElement.style.backgroundColor).toBeTruthy();
    expect(document.documentElement.style.colorScheme).toBe('light');
  });

  it('never throws', async () => {
    const { reassertThemeOnDocument } = await import('~/lib/resolveStoredTheme.js');
    expect(() => reassertThemeOnDocument()).not.toThrow();
  });

  it('sets body background color when resolved theme is dark', async () => {
    setupLocalStorage({ 'sideline-theme': 'dark' });
    const { reassertThemeOnDocument } = await import('~/lib/resolveStoredTheme.js');
    reassertThemeOnDocument();
    // jsdom normalizes hex to rgb() — check it is non-empty (was set)
    expect(document.body.style.backgroundColor).toBeTruthy();
  });
});
