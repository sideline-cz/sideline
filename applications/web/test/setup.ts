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

// Ensure localStorage is available in jsdom tests (needed by @sideline/i18n/runtime)
beforeAll(() => {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        getItem: vi.fn(() => null),
        setItem: vi.fn(),
        removeItem: vi.fn(),
        clear: vi.fn(),
      },
      writable: true,
    });
  }
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
