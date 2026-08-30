import { cleanup } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeAll, vi } from 'vitest';

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
