import { notifyManager } from '@tanstack/react-query';
import { cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, vi } from 'vitest';

// React Query's `notifyManager` defers every observer notification (fetch-start, success,
// error) through `setTimeout(fn, 0)` (`@tanstack/query-core`'s `systemSetTimeoutZero`), late-
// bound so it correctly picks up `vi.useFakeTimers()`'s patched `setTimeout` rather than a
// frozen reference from module-load time. That's the good news; the bad news is it means a
// query's fetch-start dispatch and its success/error dispatch are each a SEPARATE 0ms-scheduled
// timer, and when a debounce timer set for exactly the same delay a test advances by (e.g. a
// 250ms debounce advanced by exactly 250ms) fires AT that boundary, the newly-scheduled 0ms
// notify timers it triggers land on that same boundary too — one `advanceTimersByTimeAsync`
// call does not reliably re-enter for timers scheduled exactly at its own target time, so the
// observer's re-render is silently deferred to "the next tick nobody asked for". A test that
// debounces via fake timers then asserts on the settled UI in the same `act()` sees stale
// (pre-fetch or mid-fetch) state — not a bug in the component, a scheduling gap between two
// independent fake-timer consumers.
//
// Forcing the scheduler synchronous removes the timer hop entirely: every notification runs
// inline, in the same synchronous flush `act()` already wraps. This is a test-only trade — it
// throws away react-query's default micro-batching of rapid-fire notifications, which is a
// performance nicety in the browser, never a correctness requirement, and every test in this
// suite (fake timers or not) is strictly more reliable without that gap. Never set this outside
// tests; production keeps the default (batched) scheduler.
notifyManager.setScheduler((callback) => callback());

// `@testing-library/dom`'s `waitFor` (and `@testing-library/react`'s `asyncWrapper`, which
// drains one more `setTimeout(fn, 0)` after every `waitFor` to flush in-flight act() work) both
// gate their fake-timer-aware code paths on `typeof jest !== 'undefined'`
// (`dom-testing-library`'s `jestFakeTimersAreEnabled()`). That is a real global, not a feature
// probe — Vitest is never `jest`, so under `vi.useFakeTimers()` both libraries silently fall
// back to their REAL-timer paths: `waitFor` polls via a `setInterval`/`MutationObserver`, and
// the post-`waitFor` drain schedules a bare `setTimeout(fn, 0)`. Both of those are registered on
// the very `setTimeout` `vi.useFakeTimers()` just replaced, and since nothing in this codebase's
// tests calls `vi.advanceTimersByTimeAsync` again after the assertion that made `waitFor`'s
// condition already true, those timers never fire — the test hangs until Vitest's own real-
// clock per-test timeout, even though the DOM already has exactly what the test wants.
//
// A minimal `jest.advanceTimersByTime` shim (the only member either library calls) makes both
// libraries detect Vitest's fake timers as "jest fake timers" and delegate to them instead:
// `waitFor` then re-checks its callback on every advance instead of parking on a dead real
// timer, and the post-`waitFor` drain actually advances by 0ms instead of waiting forever.
// `Object.defineProperty` (not a bare `globalThis.jest = ...` assignment) matches this file's
// own `localStorage` polyfill below, and sidesteps typing `globalThis` for a global neither
// library treats as anything but a duck-typed capability probe.
if (!('jest' in globalThis)) {
  Object.defineProperty(globalThis, 'jest', {
    value: { advanceTimersByTime: (ms: number) => vi.advanceTimersByTime(ms) },
    writable: true,
    configurable: true,
  });
}

// Polyfill ResizeObserver for jsdom (used by DashboardCustomizer auto-fit logic)
if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}

// Polyfill requestAnimationFrame/cancelAnimationFrame for jsdom (used by
// useAnimationFrame, the rules trainer's animation loop). jsdom has no
// rendering pipeline to drive a real rAF, so this falls back to a timer.
if (typeof globalThis.requestAnimationFrame === 'undefined') {
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback): number =>
    Number(setTimeout(() => callback(performance.now()), 16));
}
if (typeof globalThis.cancelAnimationFrame === 'undefined') {
  globalThis.cancelAnimationFrame = (handle: number): void => clearTimeout(handle);
}

// Polyfill matchMedia for jsdom (used by useIsMobile, resolveStoredTheme.ts,
// preMountGuard.ts and use-pwa-install.ts). jsdom does not implement it, but every
// real browser does, so callers are written to call it unguarded; individual tests
// that need specific match results (e.g. resolveStoredTheme.test.ts,
// AppCrashFallback.test.tsx) override `window.matchMedia` themselves.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList => {
    const listeners = new Set<EventListenerOrEventListenerObject>();
    const mql: MediaQueryList = {
      matches: false,
      media: query,
      onchange: null,
      // Deprecated pre-`EventTarget` API — unused by this codebase (which calls
      // `addEventListener`/`removeEventListener`, see `use-mobile.ts`) but required by the
      // `MediaQueryList` type.
      addListener: () => {},
      removeListener: () => {},
      addEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener !== null) listeners.add(listener);
      },
      removeEventListener: (_type: string, listener: EventListenerOrEventListenerObject | null) => {
        if (listener !== null) listeners.delete(listener);
      },
      dispatchEvent: (event: Event): boolean => {
        for (const listener of listeners) {
          if (typeof listener === 'function') {
            listener(event);
          } else {
            listener.handleEvent(event);
          }
        }
        return true;
      },
    };
    return mql;
  };
}

// Ensure localStorage is available in jsdom tests (needed by @sideline/i18n/runtime).
//
// The fallback must be a WORKING in-memory store, not a no-op. It used to stub `setItem` as
// `vi.fn()` and `getItem` as `vi.fn(() => null)`, which silently swallowed every write — any
// test asserting that something was persisted then failed with "expected null to be ...", but
// only on a runner whose jsdom lacks localStorage. That is invisible locally and fails in CI,
// and worse, it would let a genuine persistence regression pass wherever jsdom does provide it.
//
// It is installed UNCONDITIONALLY, once per test file. Several suites redefine
// `globalThis.localStorage` themselves — `resolveStoredTheme.test.ts` even installs one whose
// getter throws — and `Object.defineProperty` on `globalThis` is not undone between files in the
// same worker. A conditional install therefore inherits whatever the previously-run file left
// behind, which makes storage-dependent tests pass or fail based on file order. Starting every
// file from a clean in-memory store removes that coupling; suites needing custom behaviour still
// override it in their own `beforeEach`, which runs after this.
beforeAll(() => {
  const store = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => {
        store.set(key, String(value));
      },
      removeItem: (key: string) => {
        store.delete(key);
      },
      clear: () => {
        store.clear();
      },
      key: (index: number) => Array.from(store.keys())[index] ?? null,
      get length() {
        return store.size;
      },
    },
    writable: true,
    configurable: true,
  });
});

afterEach(() => {
  cleanup();
});

// Mock Radix UI dropdown-menu so its content is always rendered in the DOM.
// Without this, Radix UI portals only render content when the dropdown is open,
// making it impossible to test content without simulating user interaction.
vi.mock('~/components/ui/dropdown-menu', () => {
  const passThrough =
    (displayName: string) =>
    ({ children, className, ...rest }: React.PropsWithChildren<Record<string, unknown>>) =>
      React.createElement('div', { 'data-testid': displayName, className, ...rest }, children);

  return {
    DropdownMenu: passThrough('dropdown-menu'),
    DropdownMenuTrigger: passThrough('dropdown-menu-trigger'),
    DropdownMenuContent: passThrough('dropdown-menu-content'),
    DropdownMenuGroup: passThrough('dropdown-menu-group'),
    DropdownMenuItem: ({
      children,
      onClick,
      asChild,
      ...rest
    }: React.PropsWithChildren<{
      onClick?: () => void;
      asChild?: boolean;
    }>) =>
      React.createElement(
        'div',
        { 'data-testid': 'dropdown-menu-item', onClick, ...rest },
        children,
      ),
    DropdownMenuLabel: passThrough('dropdown-menu-label'),
    DropdownMenuSeparator: () =>
      React.createElement('hr', { 'data-testid': 'dropdown-menu-separator' }),
    DropdownMenuSub: passThrough('dropdown-menu-sub'),
    DropdownMenuSubTrigger: passThrough('dropdown-menu-sub-trigger'),
    DropdownMenuSubContent: passThrough('dropdown-menu-sub-content'),
  };
});
