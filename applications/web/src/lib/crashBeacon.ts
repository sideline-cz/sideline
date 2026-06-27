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
