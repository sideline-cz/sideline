import { Effect, Layer, Metric } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { Otlp } from 'effect/unstable/observability';
import { isTelemetryAllowed } from '~/lib/telemetryOptOut.js';

export const makeTelemetryLayer = (options: {
  readonly endpoint: string | undefined;
  readonly serviceName: string | undefined;
  readonly environment: string | undefined;
  readonly origin: string | undefined;
}): Layer.Layer<never> =>
  // No endpoint, or this browser has objected (see `telemetryOptOut.ts`).
  // Returning an empty layer is what stops metrics and forwarded logs from
  // leaving the page at all, rather than collecting them and dropping them.
  !options.endpoint || !isTelemetryAllowed()
    ? Layer.empty
    : Otlp.layerJson({
        baseUrl: options.endpoint,
        resource: {
          serviceName: options.serviceName ?? 'sideline-web',
          attributes: {
            'deployment.environment': options.environment ?? 'unknown',
            'service.origin': options.origin ?? '',
          },
        },
      }).pipe(Layer.provide(FetchHttpClient.layer));

// ---------------------------------------------------------------------------
// Web Vitals metrics
// ---------------------------------------------------------------------------

const lcpMetric = Metric.histogram('web_vitals_lcp_ms', {
  description: 'Largest Contentful Paint in milliseconds',
  boundaries: [200, 500, 1000, 2000, 4000, 6000, 10000],
});

const clsMetric = Metric.histogram('web_vitals_cls', {
  description: 'Cumulative Layout Shift score',
  boundaries: [0.01, 0.05, 0.1, 0.15, 0.2, 0.25, 0.5, 1.0],
});

const fcpMetric = Metric.histogram('web_vitals_fcp_ms', {
  description: 'First Contentful Paint in milliseconds',
  boundaries: [200, 500, 1000, 2000, 4000, 6000, 10000],
});

const inpMetric = Metric.histogram('web_vitals_inp_ms', {
  description: 'Interaction to Next Paint in milliseconds',
  boundaries: [50, 100, 200, 500, 1000, 2000],
});

const ttfbMetric = Metric.histogram('web_vitals_ttfb_ms', {
  description: 'Time to First Byte in milliseconds',
  boundaries: [50, 100, 200, 500, 1000, 2000, 5000],
});

const pageLoadMetric = Metric.histogram('page_load_ms', {
  description: 'Full page load time (loadEventEnd) in milliseconds',
  boundaries: [200, 500, 1000, 2000, 5000, 10000],
});

const reactRenderMetric = Metric.histogram('react_render_ms', {
  description: 'React component tree render duration in milliseconds',
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500],
});

type RunEffect = (effect: Effect.Effect<void>) => void;

/**
 * Re-checks the objection at *send* time, not just at registration time.
 *
 * The Web Vitals and error listeners are attached once at boot, so a gate on
 * registration alone would keep sending for the rest of the session after
 * someone switches telemetry off. Wrapping the runner makes the switch take
 * effect immediately, with no reload.
 */
const gated =
  (runEffect: RunEffect): RunEffect =>
  (effect) => {
    if (!isTelemetryAllowed()) return;
    runEffect(effect);
  };

/**
 * Record a React Profiler render duration as an OTEL metric.
 * Call this from the `onRender` callback of a `<Profiler>` wrapper.
 */
export const recordReactRender = (runEffect: RunEffect, actualDuration: number): void => {
  if (!isTelemetryAllowed()) return;
  runEffect(Metric.update(reactRenderMetric, actualDuration));
};

let _vitalsRegistered = false;

/**
 * Register Web Vitals (LCP, CLS, FCP, INP, TTFB) and page-load reporters.
 * Must be called after `initRuntime`. Idempotent — safe to call on every navigation.
 * @param runEffect - fire-and-forget Effect runner, use `runEffect` from `~/lib/runtime`
 */
export const registerWebVitals = (runEffect: RunEffect): void => {
  if (typeof window === 'undefined') return;
  if (!isTelemetryAllowed()) return;
  if (_vitalsRegistered) return;
  _vitalsRegistered = true;

  const send = gated(runEffect);

  // Web Vitals — lazy import so the bundle doesn't grow unless used
  void import('web-vitals').then(({ onLCP, onCLS, onFCP, onINP, onTTFB }) => {
    onLCP((m) => send(Metric.update(lcpMetric, m.value)));
    onCLS((m) => send(Metric.update(clsMetric, m.value)));
    onFCP((m) => send(Metric.update(fcpMetric, m.value)));
    onINP((m) => send(Metric.update(inpMetric, m.value)));
    onTTFB((m) => send(Metric.update(ttfbMetric, m.value)));
  });

  // Page load timing — wait until load event so all timing is available
  const recordPageLoad = () => {
    const entries = performance.getEntriesByType('navigation');
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.loadEventEnd > 0) {
      send(Metric.update(pageLoadMetric, nav.loadEventEnd - nav.startTime));
    }
  };

  if (document.readyState === 'complete') {
    recordPageLoad();
  } else {
    window.addEventListener('load', recordPageLoad, { once: true });
  }
};

let _errorHandlersRegistered = false;

/**
 * Register global error handlers that forward unhandled JS errors and
 * unhandled promise rejections to SigNoz as OTEL log entries.
 * Idempotent — safe to call on every navigation.
 * @param runEffect - fire-and-forget Effect runner from `~/lib/runtime`
 */
export const registerErrorHandlers = (runEffect: RunEffect): void => {
  if (typeof window === 'undefined') return;
  if (!isTelemetryAllowed()) return;
  if (_errorHandlersRegistered) return;
  _errorHandlersRegistered = true;

  const send = gated(runEffect);

  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason instanceof Error ? event.reason : new Error(String(event.reason));
    send(Effect.logError('Unhandled promise rejection', reason));
  });

  window.addEventListener('error', (event) => {
    if (event.error instanceof Error) {
      send(Effect.logError('Unhandled error', event.error));
    }
  });
};
