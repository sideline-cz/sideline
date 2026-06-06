import { type Effect, Layer, Metric } from 'effect';
import { FetchHttpClient } from 'effect/unstable/http';
import { Otlp } from 'effect/unstable/observability';

export const makeTelemetryLayer = (options: {
  readonly endpoint: string | undefined;
  readonly serviceName: string | undefined;
  readonly environment: string | undefined;
  readonly origin: string | undefined;
}): Layer.Layer<never> =>
  !options.endpoint
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
 * Record a React Profiler render duration as an OTEL metric.
 * Call this from the `onRender` callback of a `<Profiler>` wrapper.
 */
export const recordReactRender = (runEffect: RunEffect, actualDuration: number): void => {
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
  if (_vitalsRegistered) return;
  _vitalsRegistered = true;

  // Web Vitals — lazy import so the bundle doesn't grow unless used
  void import('web-vitals').then(({ onLCP, onCLS, onFCP, onINP, onTTFB }) => {
    onLCP((m) => runEffect(Metric.update(lcpMetric, m.value)));
    onCLS((m) => runEffect(Metric.update(clsMetric, m.value)));
    onFCP((m) => runEffect(Metric.update(fcpMetric, m.value)));
    onINP((m) => runEffect(Metric.update(inpMetric, m.value)));
    onTTFB((m) => runEffect(Metric.update(ttfbMetric, m.value)));
  });

  // Page load timing — wait until load event so all timing is available
  const recordPageLoad = () => {
    const entries = performance.getEntriesByType('navigation');
    const nav = entries[0] as PerformanceNavigationTiming | undefined;
    if (nav && nav.loadEventEnd > 0) {
      runEffect(Metric.update(pageLoadMetric, nav.loadEventEnd - nav.startTime));
    }
  };

  if (document.readyState === 'complete') {
    recordPageLoad();
  } else {
    window.addEventListener('load', recordPageLoad, { once: true });
  }
};
