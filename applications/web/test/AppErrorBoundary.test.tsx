// Tests for src/components/layouts/AppErrorBoundary.tsx
//
// API contract:
//   class AppErrorBoundary extends React.Component<{children: React.ReactNode}, {hasError: boolean}>
//     - renders children normally when no error
//     - when child throws on first commit: shows fallback (AppCrashFallback), children are gone
//     - logging path:
//         runtime null (runEffect is a no-op) → beaconCrash called with phase:"boundary"
//         runtime present (runEffect is active) → runEffect called (not beaconCrash)
//     - never throws from logging (try/catch around all logging)
//     - sets window.__SIDELINE_CRASHED__ = true when an error is caught
//     - module-level + sessionStorage one-shot guard prevents crash-in-fallback loop

import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Module mocks (declared before dynamic import)
// ---------------------------------------------------------------------------

// Mutable reference so individual tests can swap runtime state
let _runEffectMock = vi.fn();
let _runtimeIsInitialized = false;

vi.mock('~/lib/runtime.js', () => ({
  runEffect: (...args: unknown[]) => {
    if (_runtimeIsInitialized) {
      _runEffectMock(...args);
    }
    // When runtime is null, runEffect is a no-op (that's the real behaviour)
  },
  isRuntimeInitialized: () => _runtimeIsInitialized,
  initRuntime: vi.fn(),
}));

const _beaconCrashMock = vi.fn();
vi.mock('~/lib/crashBeacon.js', () => ({
  beaconCrash: (...args: unknown[]) => _beaconCrashMock(...args),
}));

// Mock AppCrashFallback so we control what it renders and can detect it
vi.mock('~/components/layouts/AppCrashFallback.js', () => ({
  AppCrashFallback: ({
    onReload,
    onReset,
  }: {
    onReload?: () => void;
    onReset?: () => void | Promise<void>;
  }) => (
    <div data-testid='app-crash-fallback'>
      <button type='button' onClick={onReload}>
        Reload
      </button>
      <button type='button' onClick={() => onReset?.()}>
        Reset app
      </button>
    </div>
  ),
}));

// Mock window.location.reload so the auto-reload path doesn't hit jsdom navigation.
const reloadMock = vi.fn();
Object.defineProperty(window, 'location', {
  value: { ...window.location, reload: reloadMock },
  writable: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ThrowOnRender({ shouldThrow }: { shouldThrow: boolean }) {
  if (shouldThrow) {
    throw new Error('Simulated render crash');
  }
  return <div data-testid='child-content'>Child rendered fine</div>;
}

// Suppress expected React error boundary console.error calls
let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetModules();
  _runEffectMock = vi.fn();
  _runtimeIsInitialized = false;
  _beaconCrashMock.mockClear();
  reloadMock.mockClear();
  // Start each test with a clean reload/auto-reload budget.
  sessionStorage.clear();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__SIDELINE_CRASHED__ = undefined;

  // Suppress React's "The above error occurred in the..." console.error noise
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
  vi.restoreAllMocks();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (window as any).__SIDELINE_CRASHED__ = undefined;
});

// ---------------------------------------------------------------------------
// Import the module under test (after mocks)
// ---------------------------------------------------------------------------

const { AppErrorBoundary } = await import('~/components/layouts/AppErrorBoundary.js');
const { AUTO_RELOAD_COUNT_KEY, AUTO_RELOAD_CAP } = await import('~/lib/reloadGuard.js');

// Simulate that the app has already used its single automatic reload this session,
// so the boundary shows the manual crash screen instead of auto-reloading again.
function spendAutoReloadBudget() {
  sessionStorage.setItem(AUTO_RELOAD_COUNT_KEY, String(AUTO_RELOAD_CAP));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppErrorBoundary', () => {
  describe('normal path — no error', () => {
    it('renders children when no error is thrown', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={false} />
        </AppErrorBoundary>,
      );
      expect(screen.getByTestId('child-content')).not.toBeNull();
      expect(screen.queryByTestId('app-crash-fallback')).toBeNull();
    });
  });

  describe('auto-reload once — first crash of a healthy session', () => {
    it('reloads exactly once and shows the Reloading placeholder (not the crash screen)', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      expect(reloadMock).toHaveBeenCalledTimes(1);
      expect(screen.getByText('Reloading…')).not.toBeNull();
      expect(screen.queryByTestId('app-crash-fallback')).toBeNull();
    });

    it('hides the crashing child while auto-reloading', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      expect(screen.queryByTestId('child-content')).toBeNull();
    });

    it('sets window.__SIDELINE_CRASHED__ = true when error is caught', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((window as any).__SIDELINE_CRASHED__).toBe(true);
    });
  });

  describe('manual crash screen — after the one automatic reload is spent', () => {
    beforeEach(() => {
      spendAutoReloadBudget();
    });

    it('shows the crash fallback when a child throws', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      expect(screen.getByTestId('app-crash-fallback')).not.toBeNull();
    });

    it('does not auto-reload again', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      expect(reloadMock).not.toHaveBeenCalled();
    });

    it('hides the crashing child after error', () => {
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );
      expect(screen.queryByTestId('child-content')).toBeNull();
    });
  });

  describe('logging path — runtime null', () => {
    it('calls beaconCrash with phase "boundary" when runtime is null (runEffect is no-op)', () => {
      _runtimeIsInitialized = false; // runtime not initialized → runEffect is no-op

      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(_beaconCrashMock).toHaveBeenCalledOnce();
      const payload = _beaconCrashMock.mock.calls[0][0];
      expect(payload.phase).toBe('boundary');
      expect(payload.message).toBeTruthy();
    });

    it('does not call runEffect when runtime is null', () => {
      _runtimeIsInitialized = false;

      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(_runEffectMock).not.toHaveBeenCalled();
    });
  });

  describe('logging path — runtime present', () => {
    it('calls runEffect when runtime is initialized', () => {
      _runtimeIsInitialized = true; // runtime initialized → runEffect is active

      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(_runEffectMock).toHaveBeenCalledOnce();
    });

    it('does not call beaconCrash when runtime is present (runEffect handles logging)', () => {
      _runtimeIsInitialized = true;

      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(_beaconCrashMock).not.toHaveBeenCalled();
    });
  });

  describe('logging safety — never throws from logging', () => {
    it('does not propagate errors thrown inside logging (beaconCrash path)', () => {
      _runtimeIsInitialized = false;
      _beaconCrashMock.mockImplementation(() => {
        throw new Error('beaconCrash exploded');
      });

      // Should NOT throw even though beaconCrash throws
      expect(() =>
        render(
          <AppErrorBoundary>
            <ThrowOnRender shouldThrow={true} />
          </AppErrorBoundary>,
        ),
      ).not.toThrow();
    });

    it('does not propagate errors thrown inside logging (runEffect path)', () => {
      _runtimeIsInitialized = true;
      _runEffectMock.mockImplementation(() => {
        throw new Error('runEffect exploded');
      });

      expect(() =>
        render(
          <AppErrorBoundary>
            <ThrowOnRender shouldThrow={true} />
          </AppErrorBoundary>,
        ),
      ).not.toThrow();
    });
  });

  describe('loop guard — crash-in-fallback prevention', () => {
    it('renders fallback even if beaconCrash is called more than once (one-shot guard)', () => {
      _runtimeIsInitialized = false;
      // Past the single auto-reload, so the boundary renders the manual fallback.
      spendAutoReloadBudget();

      // First render
      const { unmount } = render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(screen.getByTestId('app-crash-fallback')).not.toBeNull();
      unmount();

      // Second render should still show fallback (not loop)
      render(
        <AppErrorBoundary>
          <ThrowOnRender shouldThrow={true} />
        </AppErrorBoundary>,
      );

      expect(screen.getByTestId('app-crash-fallback')).not.toBeNull();
    });
  });
});
