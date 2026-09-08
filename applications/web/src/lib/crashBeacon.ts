import { isTelemetryAllowed } from '~/lib/telemetryOptOut.js';

export interface CrashPayload {
  message: string;
  stack?: string;
  phase: 'pre-mount' | 'pre-init' | 'boundary' | 'preload-error';
  url: string;
  ts: number;
}

declare global {
  interface Window {
    __SIDELINE_OTLP__?: string;
  }
}

export function beaconCrash(payload: CrashPayload): void {
  try {
    // This path never touches the Effect runtime, so gating the telemetry
    // layer does not cover it. It also fires from a crashed or not-yet-booted
    // page, which is exactly when an objection is easiest to forget.
    if (!isTelemetryAllowed()) return;

    const endpoint = typeof window !== 'undefined' ? window.__SIDELINE_OTLP__ : undefined;
    if (!endpoint) return;

    const body = JSON.stringify(payload);

    if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
      try {
        navigator.sendBeacon(endpoint, new Blob([body], { type: 'application/json' }));
        return;
      } catch {
        // fall through to fetch fallback
      }
    }

    // Fallback: fetch with keepalive (fire-and-forget)
    if (typeof fetch === 'function') {
      fetch(endpoint, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        keepalive: true,
      }).catch(() => {
        // fire-and-forget: swallow errors
      });
    }
  } catch {
    // NEVER throws
  }
}
