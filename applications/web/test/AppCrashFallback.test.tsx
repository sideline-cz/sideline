// Tests for src/components/layouts/AppCrashFallback.tsx
//
// API contract:
//   AppCrashFallbackProps {
//     onReload?: () => void          (default: requestReload("crash-fallback"))
//     onReset?: () => void | Promise<void>  (default: resetApp)
//   }
//   AppCrashFallback(props: AppCrashFallbackProps): JSX.Element
//
// Critical regression test: the fallback MUST render an explicit DARK background
// when window.matchMedia reports dark. This is the direct guard against the white screen.

import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (declared before dynamic import)
// ---------------------------------------------------------------------------

// Mock reloadGuard so we can assert it is called and avoid side effects
vi.mock('~/lib/reloadGuard.js', () => ({
  requestReload: vi.fn().mockReturnValue(true),
  clearReloadGuard: vi.fn(),
  getReloadCount: vi.fn().mockReturnValue(0),
  RELOAD_COUNT_KEY: 'sideline-reload-count',
  RELOAD_CAP: 2,
}));

// Mock sw-recovery so resetApp doesn't touch the DOM/SW APIs
vi.mock('~/lib/sw-recovery.js', () => ({
  resetApp: vi.fn().mockResolvedValue(undefined),
  RESETTING_KEY: 'sideline-resetting',
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockMatchMedia(prefersDark: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(prefers-color-scheme: dark)' ? prefersDark : false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
    writable: true,
    configurable: true,
  });
}

// ---------------------------------------------------------------------------
// Import component under test (after mocks)
// ---------------------------------------------------------------------------

const { AppCrashFallback } = await import('~/components/layouts/AppCrashFallback.js');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppCrashFallback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('content', () => {
    it('renders a reassuring headline mentioning "went wrong"', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      const heading = screen.getByRole('heading');
      expect(heading.textContent?.toLowerCase()).toMatch(/went wrong/i);
    });

    it('renders copy that says data is safe', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      expect(screen.getByText(/your data is safe/i)).not.toBeNull();
    });

    it('renders a Reload button', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      const reloadBtn = screen.getByRole('button', { name: /reload/i });
      expect(reloadBtn).not.toBeNull();
    });

    it('renders a Reset app button', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      const resetBtn = screen.getByRole('button', { name: /reset/i });
      expect(resetBtn).not.toBeNull();
    });

    it('renders the reset explainer text', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      // The explainer mentions clearing offline data
      expect(
        screen.getByText(/clears.*saved.*data|saved.*offline.*data|offline data/i),
      ).not.toBeNull();
    });
  });

  describe('actions', () => {
    it('calls onReload when Reload button is clicked', () => {
      mockMatchMedia(false);
      const onReload = vi.fn();
      render(<AppCrashFallback onReload={onReload} />);
      fireEvent.click(screen.getByRole('button', { name: /reload/i }));
      expect(onReload).toHaveBeenCalledOnce();
    });

    it('calls default requestReload when no onReload prop is provided', async () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      fireEvent.click(screen.getByRole('button', { name: /reload/i }));
      const { requestReload } = await import('~/lib/reloadGuard.js');
      expect(requestReload).toHaveBeenCalled();
    });

    it('calls onReset when Reset app button is clicked', async () => {
      mockMatchMedia(false);
      const onReset = vi.fn().mockResolvedValue(undefined);
      render(<AppCrashFallback onReset={onReset} />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /reset/i }));
      });
      expect(onReset).toHaveBeenCalledOnce();
    });

    it('calls default resetApp when no onReset prop is provided', async () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /reset/i }));
      });
      const { resetApp } = await import('~/lib/sw-recovery.js');
      expect(resetApp).toHaveBeenCalled();
    });

    it('shows "Resetting…" while onReset promise is pending', async () => {
      mockMatchMedia(false);
      let resolveReset!: () => void;
      const onReset = vi.fn().mockReturnValue(
        new Promise<void>((resolve) => {
          resolveReset = resolve;
        }),
      );
      render(<AppCrashFallback onReset={onReset} />);

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: /reset/i }));
      });

      // While pending, should show "Resetting…"
      expect(screen.getByText(/resetting/i)).not.toBeNull();

      // Resolve and verify it clears
      await act(async () => {
        resolveReset();
      });
    });
  });

  describe('DARK MODE REGRESSION GUARD — white screen prevention', () => {
    it('renders with an explicit DARK background colour (#0a0a0a) when matchMedia reports dark', () => {
      mockMatchMedia(true); // dark mode ON
      const { container } = render(<AppCrashFallback />);

      // The root element (or wrapper) MUST have an explicit background style in dark mode.
      // This is the core regression guard: without this, a crash during ThemeProvider init
      // causes the CSS .dark class to drop off <html>, and the page goes white.
      const rootEl = container.firstElementChild as HTMLElement | null;
      expect(rootEl).not.toBeNull();

      const style = rootEl?.getAttribute('style') ?? '';
      // Must contain the dark background colour (#0a0a0a) as an inline style
      expect(style).toMatch(/#0a0a0a|rgb\(10,\s*10,\s*10\)|rgb\(10, 10, 10\)/i);
    });

    it('renders with a LIGHT background colour (#ffffff) when matchMedia reports light', () => {
      mockMatchMedia(false); // dark mode OFF
      const { container } = render(<AppCrashFallback />);

      const rootEl = container.firstElementChild as HTMLElement | null;
      expect(rootEl).not.toBeNull();

      const style = rootEl?.getAttribute('style') ?? '';
      // Must contain the light background colour
      expect(style).toMatch(/#ffffff|rgb\(255,\s*255,\s*255\)|rgb\(255, 255, 255\)/i);
    });

    it('does NOT rely on any CSS class for dark mode (inline styles only)', () => {
      mockMatchMedia(true); // dark mode ON
      const { container } = render(<AppCrashFallback />);
      // The component must NOT use a .dark class to achieve its background,
      // since that class lives on <html> and drops when ThemeProvider crashes.
      // All colour must come from inline styles.
      // Verify by checking that the background is present as an inline style, not CSS class.
      const rootEl = container.firstElementChild as HTMLElement | null;
      const bgColor = rootEl?.style?.backgroundColor;
      expect(bgColor).toBeTruthy();
    });

    it('renders 100dvh or full-height container', () => {
      mockMatchMedia(false);
      const { container } = render(<AppCrashFallback />);
      const rootEl = container.firstElementChild as HTMLElement | null;
      const style = rootEl?.getAttribute('style') ?? '';
      // Should have min-height or height covering full viewport
      expect(style).toMatch(/100dvh|100vh/i);
    });

    it('buttons have at least 44px min-height for touch targets', () => {
      mockMatchMedia(false);
      render(<AppCrashFallback />);
      const reloadBtn = screen.getByRole('button', { name: /reload/i });
      const resetBtn = screen.getByRole('button', { name: /reset/i });

      const reloadStyle = reloadBtn.getAttribute('style') ?? '';
      const resetStyle = resetBtn.getAttribute('style') ?? '';

      // Either inline style or the rendered style contains minHeight: 44px
      // (jsdom doesn't compute CSS, so we check inline styles)
      expect(reloadStyle + resetStyle).toMatch(/44px/i);
    });
  });

  describe('self-contained — no app imports', () => {
    it('renders without crashing when window.matchMedia is not available', () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).matchMedia = undefined;
      expect(() => render(<AppCrashFallback />)).not.toThrow();
    });
  });
});
