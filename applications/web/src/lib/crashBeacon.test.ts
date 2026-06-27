// Tests for src/lib/crashBeacon.ts
//
// API contract:
//   CrashPayload: { message: string; stack?: string; phase: "pre-mount" | "pre-init" | "boundary" | "preload-error"; url: string; ts: number }
//   beaconCrash(payload: CrashPayload): void
//     - uses navigator.sendBeacon when available
//     - falls back to fetch(..., { keepalive: true }) when sendBeacon unavailable
//     - no-op when window.__SIDELINE_OTLP__ is not set
//     - NEVER throws

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayload(phase: 'pre-mount' | 'pre-init' | 'boundary' | 'preload-error' = 'boundary') {
  return {
    message: 'Test crash',
    stack: 'Error: Test crash\n  at somewhere:1:1',
    phase,
    url: 'https://example.com/app',
    ts: Date.now(),
  };
}

beforeEach(() => {
  vi.resetModules();
  // Reset global OTLP endpoint
  (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ = undefined;
});

afterEach(() => {
  vi.restoreAllMocks();
  (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ = undefined;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('crashBeacon', () => {
  it('is a no-op when window.__SIDELINE_OTLP__ is not set', async () => {
    const sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeaconMock,
      configurable: true,
      writable: true,
    });

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    beaconCrash(makePayload());

    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it('uses navigator.sendBeacon when available and endpoint is set', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    const sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeaconMock,
      configurable: true,
      writable: true,
    });

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    beaconCrash(makePayload('boundary'));

    expect(sendBeaconMock).toHaveBeenCalledOnce();
    const [url, data] = sendBeaconMock.mock.calls[0] as [string, unknown];
    expect(url).toContain('example.com');
    // data should be a Blob or string containing payload
    expect(data).toBeTruthy();
  });

  it('falls back to fetch with keepalive when sendBeacon is not available', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    // Remove sendBeacon
    Object.defineProperty(navigator, 'sendBeacon', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    globalThis.fetch = fetchMock;

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    beaconCrash(makePayload('pre-mount'));

    // fetch may be called asynchronously (fire-and-forget), so give it a tick
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('example.com');
    expect(options?.keepalive).toBe(true);
  });

  it('never throws even when sendBeacon throws', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    Object.defineProperty(navigator, 'sendBeacon', {
      value: vi.fn().mockImplementation(() => {
        throw new Error('sendBeacon exploded');
      }),
      configurable: true,
      writable: true,
    });

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    expect(() => beaconCrash(makePayload())).not.toThrow();
  });

  it('never throws even when fetch throws', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    Object.defineProperty(navigator, 'sendBeacon', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    globalThis.fetch = vi.fn().mockRejectedValue(new Error('fetch failed'));

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    expect(() => beaconCrash(makePayload())).not.toThrow();
    // Also wait to ensure any async rejection is caught internally
    await Promise.resolve();
  });

  it('never throws when both sendBeacon and fetch are unavailable', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    Object.defineProperty(navigator, 'sendBeacon', {
      value: undefined,
      configurable: true,
      writable: true,
    });

    (globalThis as unknown as Record<string, unknown>).fetch = undefined;

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    expect(() => beaconCrash(makePayload())).not.toThrow();
  });

  it('includes phase in payload sent to sendBeacon', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';

    const sendBeaconMock = vi.fn().mockReturnValue(true);
    Object.defineProperty(navigator, 'sendBeacon', {
      value: sendBeaconMock,
      configurable: true,
      writable: true,
    });

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    const payload = makePayload('preload-error');
    beaconCrash(payload);

    const [, data] = sendBeaconMock.mock.calls[0] as [string, Blob | string];
    // Data could be Blob or string; convert for inspection
    let bodyText: string;
    if (data instanceof Blob) {
      bodyText = await data.text();
    } else {
      bodyText = String(data);
    }
    expect(bodyText).toContain('preload-error');
  });

  it('accepts all valid phase values without throwing', async () => {
    (window as unknown as Record<string, unknown>).__SIDELINE_OTLP__ =
      'https://collector.example.com/v1/logs';
    Object.defineProperty(navigator, 'sendBeacon', {
      value: vi.fn().mockReturnValue(true),
      configurable: true,
      writable: true,
    });

    const { beaconCrash } = await import('~/lib/crashBeacon.js');
    const phases: Array<'pre-mount' | 'pre-init' | 'boundary' | 'preload-error'> = [
      'pre-mount',
      'pre-init',
      'boundary',
      'preload-error',
    ];

    for (const phase of phases) {
      expect(() => beaconCrash(makePayload(phase))).not.toThrow();
    }
  });
});
