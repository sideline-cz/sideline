# Web App OTEL / SigNoz Monitoring

## Goal
Add OpenTelemetry monitoring to the Sideline web app using Effect's built-in observability, similarly to how server and bot are configured.

## Architecture

### Key decisions
- Use `ManagedRuntime` singleton (built once per page session) — NOT per-call `Effect.provide`
- The OTEL batch exporter stays alive for the full session; spans flush properly
- `initRuntime(serverUrl, telemetryLayer)` called in root route `beforeLoad` after `fetchEnv`
- `pagehide` handler calls `runtime.dispose()` to flush final spans before tab close
- OTEL vars are **optional** in `fetchEnv` — app works fine without them (local dev)

## Files to change

### 1. `applications/web/src/lib/telemetry.ts` (NEW)
```typescript
import { Layer } from 'effect';
import { layer as layerFetch } from 'effect/unstable/http/FetchHttpClient';
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
      }).pipe(Layer.provide(layerFetch));
```

### 2. `applications/web/src/env.ts`
Add 4 optional OTEL vars to `fetchEnv`'s server block:
```typescript
OTEL_EXPORTER_OTLP_ENDPOINT: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
OTEL_SERVICE_NAME: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
APP_ENV: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
APP_ORIGIN: Schema.UndefinedOr(Schema.NonEmptyString).pipe(Schema.toStandardSchemaV1),
```

### 3. `applications/web/src/lib/runtime.ts`
Replace static `AppLayer` + per-call `Effect.provide` with a `ManagedRuntime` singleton:

```typescript
// Replace static AppLayer with:
const makeAppLayer = (options: { serverUrl: string; telemetryLayer: Layer.Layer<never> }) =>
  Layer.mergeAll(
    ApiClientLive,
    Logger.layer([Logger.consolePretty()]),
    Layer.succeed(References.MinimumLogLevel, 'Info' as const),
    options.telemetryLayer,
  ).pipe(Layer.provide(Layer.succeed(ClientConfig, { baseUrl: options.serverUrl })));

// Module-level singleton:
let _runtime: ManagedRuntime.ManagedRuntime<ApiClient | ClientConfig, never> | null = null;

export const initRuntime = (options: { serverUrl: string; telemetryLayer: Layer.Layer<never> }): void => {
  if (_runtime !== null) return;  // already initialized — no-op on re-navigation
  _runtime = ManagedRuntime.make(makeAppLayer(options));
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => void _runtime?.dispose(), { once: true });
  }
};

const getRuntime = () => {
  if (_runtime === null) throw new Error('Runtime not initialized');
  return _runtime;
};

// runPromiseServer: keep existing signature for call-site compat, but route through runtime
export const runPromiseServer = (_serverUrl: string) => (abortController?) =>
  async <A>(effect) => {
    const exit = await getRuntime().runPromiseExit(effect.pipe(Effect.result), { signal: abortController?.signal });
    return resolveServerExit(exit, abortController?.signal.aborted ?? false);
  };

// runPromiseClient: route through runtime
export const runPromiseClient = (_serverUrl: string) => (options?) =>
  async <A>(effect) => {
    const effectResponse = effect.pipe(/* toast tapError/tap unchanged */, Effect.option);
    return await getRuntime().runPromise(effectResponse);
  };

// ServerRunner: route through runtime
```

### 4. `applications/web/src/routes/__root.tsx`
```typescript
import { initRuntime } from '~/lib/runtime';
import { makeTelemetryLayer } from '~/lib/telemetry';
// In beforeLoad:
const environment = await fetchEnv(abortController);
initRuntime({
  serverUrl: environment.SERVER_URL,
  telemetryLayer: makeTelemetryLayer({
    endpoint: environment.OTEL_EXPORTER_OTLP_ENDPOINT,
    serviceName: environment.OTEL_SERVICE_NAME,
    environment: environment.APP_ENV,
    origin: environment.APP_ORIGIN,
  }),
});
const makeRun = runPromiseServer(environment.SERVER_URL);
// rest unchanged
```

### 5. `docker-compose.yaml`
Add to `web.environment`:
```yaml
OTEL_EXPORTER_OTLP_ENDPOINT: https://otelcollectorhttp-ccogw4cogg00wwowc0s4c0cs.majksa.net/
OTEL_SERVICE_NAME: sideline-web
APP_ENV: preview
APP_ORIGIN: ${SERVICE_FQDN_PROXY}
```

## What's NOT changing
- `packages/effect-lib/src/Telemetry.ts` — NOT adding fetch variant (dead code; web doesn't import it)
- `docs` app — static Astro site, no OTEL needed
- All existing call sites of `runPromiseServer` / `runPromiseClient` — signatures unchanged

## Infrastructure note
The OTEL collector at `https://otelcollectorhttp-ccogw4cogg00wwowc0s4c0cs.majksa.net/` must have CORS headers allowing requests from the web app's browser origin for browser-side spans to reach it.
