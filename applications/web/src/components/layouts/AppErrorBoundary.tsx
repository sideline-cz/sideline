import { Effect } from 'effect';
import React from 'react';
import { AppCrashFallback } from '~/components/layouts/AppCrashFallback.js';
import { beaconCrash } from '~/lib/crashBeacon.js';
import { reassertThemeOnDocument } from '~/lib/resolveStoredTheme.js';
import { isRuntimeInitialized, runEffect } from '~/lib/runtime.js';

declare global {
  interface Window {
    __SIDELINE_CRASHED__?: boolean;
  }
}

export class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { hasError: boolean }
> {
  // Per-instance one-shot guard: prevents the same boundary instance from logging twice
  // (loop prevention: if the fallback itself crashes, we don't log recursively)
  private _hasLoggedCrash = false;

  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_error: unknown): { hasError: boolean } {
    // Re-assert theme synchronously so the fallback never renders on a white
    // background even when ThemeProvider is no longer mounted.
    reassertThemeOnDocument();
    return { hasError: true };
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
  }

  render() {
    if (this.state.hasError) {
      return <AppCrashFallback />;
    }
    return this.props.children;
  }
}
