import { Effect } from 'effect';
import React from 'react';
import { AppCrashFallback } from '~/components/layouts/AppCrashFallback.js';
import { AppReloadingScreen } from '~/components/layouts/AppReloadingScreen.js';
import { beaconCrash } from '~/lib/crashBeacon.js';
import { canAutoReloadOnce, requestAutoReloadOnce } from '~/lib/reloadGuard.js';
import { reassertThemeOnDocument } from '~/lib/resolveStoredTheme.js';
import { isRuntimeInitialized, runEffect } from '~/lib/runtime.js';

declare global {
  interface Window {
    __SIDELINE_CRASHED__?: boolean;
  }
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean; autoReloading: boolean }
> {
  // Per-instance one-shot guard: prevents the same boundary instance from logging twice
  // (loop prevention: if the fallback itself crashes, we don't log recursively)
  private _hasLoggedCrash = false;

  // Per-instance one-shot guard so the automatic reload is attempted at most once.
  private _autoReloadTriggered = false;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false, autoReloading: false };
  }

  static getDerivedStateFromError(_error: unknown): { hasError: boolean; autoReloading: boolean } {
    // Re-assert theme synchronously so the fallback never renders on a white
    // background even when ThemeProvider is no longer mounted.
    reassertThemeOnDocument();
    // Decide up front whether we'll auto-reload, so render can show the quiet
    // "Reloading…" placeholder instead of flashing the full crash screen.
    return { hasError: true, autoReloading: canAutoReloadOnce() };
  }

  componentDidCatch(error: Error, _info: React.ErrorInfo): void {
    // Set the crashed flag so pre-mount watchdog doesn't double-fire
    if (typeof window !== 'undefined') {
      window.__SIDELINE_CRASHED__ = true;
    }
    // Re-assert in componentDidCatch as well (belt-and-suspenders)
    reassertThemeOnDocument();

    // One-shot logging guard per instance
    if (this._hasLoggedCrash) return;
    this._hasLoggedCrash = true;

    // Lazily log inside try/catch — NEVER throw from this method
    try {
      if (isRuntimeInitialized()) {
        // Runtime is live — use Effect logging pipeline (which routes to OTel)
        runEffect(
          Effect.logError('App boundary caught crash', {
            message: error.message,
            stack: error.stack,
          }),
        );
      } else {
        // Runtime not yet initialized — beacon directly (fire-and-forget via navigator.sendBeacon)
        beaconCrash({
          phase: 'boundary',
          message: error.message,
          stack: error.stack,
          url: typeof window !== 'undefined' ? window.location.href : '',
          ts: Date.now(),
        });
      }
    } catch {
      // Never propagate logging errors
    }

    // Auto-reload once: silently reload a single time before showing the manual
    // crash screen. requestAutoReloadOnce is a no-op (returns false) once the
    // one-shot budget or the shared reload cap is spent — in that case we fall
    // back to the manual screen instead of leaving the user on the placeholder.
    if (this.state.autoReloading && !this._autoReloadTriggered) {
      this._autoReloadTriggered = true;
      let reloaded = false;
      try {
        reloaded = requestAutoReloadOnce('crash-auto');
      } catch {
        reloaded = false;
      }
      if (!reloaded) {
        this.setState({ autoReloading: false });
      }
    }
  }

  render() {
    if (this.state.hasError) {
      if (this.state.autoReloading) {
        return <AppReloadingScreen />;
      }
      return <AppCrashFallback />;
    }
    return this.props.children;
  }
}
