// Devtools gating test for RootDocument
//
// Per impl-spec.md section D:
//   - Gate <TanStackDevtools> (and related devtools) behind import.meta.env.DEV
//   - When DEV is false (production), no devtools trigger should appear in the DOM
//
// This test asserts RootDocument renders NO devtools trigger when
// import.meta.env.DEV is false (production build).
//
// The primary proof is the post-build grep (CI step), but this unit test
// catches the gate logic at the component level.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// Stub i18n runtime (RootDocument calls getLocale())
vi.mock('@sideline/i18n/runtime', () => ({
  getLocale: () => 'en',
  setLocale: vi.fn(),
}));

// Stub sw-reload so the serviceWorker effect doesn't blow up in jsdom
vi.mock('~/lib/sw-reload.js', () => ({
  shouldReloadOnControllerChange: vi.fn().mockReturnValue(false),
}));

// Stub reloadGuard (used by RootDocument after D edit for SW controllerchange)
vi.mock('~/lib/reloadGuard.js', () => ({
  requestReload: vi.fn().mockReturnValue(false),
  clearReloadGuard: vi.fn(),
  getReloadCount: vi.fn().mockReturnValue(0),
  RELOAD_COUNT_KEY: 'sideline-reload-count',
  RELOAD_CAP: 2,
  RESETTING_KEY: 'sideline-resetting',
}));

// Stub Sonner Toaster
vi.mock('~/components/ui/sonner', () => ({
  Toaster: () => <div data-testid='toaster' />,
}));

// Stub TanStack Scripts / HeadContent — they write to <head> which jsdom doesn't need
vi.mock('@tanstack/react-router', () => ({
  HeadContent: () => null,
  Scripts: () => null,
  Link: ({ children }: React.PropsWithChildren) => <span>{children}</span>,
}));

// Stub devtools modules — they are dynamically imported behind DEV guard
// even if they exist as bare imports, we stub them here so the test doesn't
// need the actual packages installed in test mode
vi.mock('@tanstack/react-devtools', () => ({
  TanStackDevtools: () => <div data-testid='tanstack-devtools' />,
}));
vi.mock('@tanstack/react-router-devtools', () => ({
  TanStackRouterDevtoolsPanel: () => <div data-testid='router-devtools' />,
}));
vi.mock('~/integrations/tanstack-query/devtools', () => ({
  default: { name: 'ReactQuery', render: <div data-testid='query-devtools' /> },
}));

// ---------------------------------------------------------------------------
// Force import.meta.env.DEV = false (production mode)
// The vitest.config.ts does not set this, so it defaults to false in test mode.
// We verify this in the test assertion.
// ---------------------------------------------------------------------------

const { RootDocument } = await import('~/components/layouts/RootDocument.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RootDocument — devtools gating', () => {
  it('does NOT render the TanStack devtools trigger when import.meta.env.DEV is false', () => {
    // import.meta.env.DEV is false in the test environment (vitest test mode),
    // which correctly simulates a production build.
    expect(import.meta.env.DEV).toBe(false);

    render(
      <RootDocument>
        <div data-testid='children' />
      </RootDocument>,
    );

    // In production mode, no devtools panel should appear in the DOM.
    // The TanStackDevtools stub renders data-testid='tanstack-devtools'.
    // If gating is correct, this element must be absent.
    expect(screen.queryByTestId('tanstack-devtools')).toBeNull();
  });

  it('always renders children regardless of DEV mode', () => {
    render(
      <RootDocument>
        <div data-testid='app-children' />
      </RootDocument>,
    );
    expect(screen.getByTestId('app-children')).not.toBeNull();
  });

  it('always renders the Toaster', () => {
    render(
      <RootDocument>
        <div />
      </RootDocument>,
    );
    expect(screen.getByTestId('toaster')).not.toBeNull();
  });
});
