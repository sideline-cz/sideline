import { setLocale } from '@sideline/i18n/runtime';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext, Outlet } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import type React from 'react';
import { Profiler, useEffect } from 'react';
import { AppErrorBoundary } from '~/components/layouts/AppErrorBoundary.js';
import { RootDocument } from '~/components/layouts/RootDocument';
import { RouteErrorComponent } from '~/components/layouts/RouteErrorComponent';
import { RouteNotFoundComponent } from '~/components/layouts/RouteNotFoundComponent';
import { RoutePendingComponent } from '~/components/layouts/RoutePendingComponent';
import { fetchEnv } from '~/env.js';
import { markAppMounted, markRouteHealthy } from '~/lib/preMountGuard.js';
import {
  ApiClient,
  initRuntime,
  RunProvider,
  runEffect,
  runPromiseClient,
  runPromiseServer,
} from '~/lib/runtime';
import {
  makeTelemetryLayer,
  recordReactRender,
  registerErrorHandlers,
  registerWebVitals,
} from '~/lib/telemetry';
import { ThemeProvider } from '~/lib/theme.js';
import { TranslationOverridesProvider } from '~/lib/translation-overrides-context.js';
import appCss from '../styles.css?url';

const getCurrentUser = ApiClient.asEffect().pipe(
  Effect.flatMap((api) => api.auth.me()),
  Effect.map(Option.some),
  Effect.catchTag('Unauthorized', () => Effect.succeed(Option.none())),
  Effect.tap((user) => Effect.logInfo('Logged in as', user)),
);

// Timeout for the initial user fetch — if it takes too long, treat as logged-out
// rather than hanging indefinitely. On a genuine navigation supersede, the
// abortController.signal.aborted guard takes precedence.
const USER_FETCH_TIMEOUT_MS = 10000;

interface MyRouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<MyRouterContext>()({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        title: 'Sideline — Team Management',
      },
      {
        name: 'theme-color',
        content: '#0a0a0a',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'default',
      },
      {
        name: 'apple-mobile-web-app-title',
        content: 'Sideline',
      },
      {
        name: 'description',
        content:
          'Events, attendance, workouts, and team management — all in one place. Integrated with Discord.',
      },
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: 'Sideline' },
      { property: 'og:title', content: 'Sideline — Team Management' },
      {
        property: 'og:description',
        content:
          'Events, attendance, workouts, and team management — all in one place. Integrated with Discord.',
      },
      { property: 'og:image', content: '/og-image.png' },
      { name: 'twitter:card', content: 'summary_large_image' },
      { name: 'twitter:title', content: 'Sideline — Team Management' },
      {
        name: 'twitter:description',
        content:
          'Events, attendance, workouts, and team management — all in one place. Integrated with Discord.',
      },
      { name: 'twitter:image', content: '/og-image.png' },
    ],
    links: [
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.json',
      },
      {
        rel: 'apple-touch-icon',
        href: '/icons/apple-touch-icon.png',
      },
      {
        rel: 'icon',
        type: 'image/png',
        sizes: '32x32',
        href: '/icons/favicon-32.png',
      },
    ],
  }),
  wrapInSuspense: true,
  ssr: false,
  shellComponent: RootDocumentRoute,
  component: RootComponent,
  errorComponent: RouteErrorComponent,
  pendingComponent: RoutePendingComponent,
  notFoundComponent: RouteNotFoundComponent,
  beforeLoad: async ({ abortController }) => {
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
    registerWebVitals(runEffect);
    registerErrorHandlers(runEffect);
    const makeRun = runPromiseServer(environment.SERVER_URL);
    const run = makeRun(abortController);
    // B3: timeout the user fetch so the initial load produces a definite outcome.
    // A genuine supersede (abortController.signal.aborted) is handled inside run()
    // via resolveServerExit — those never resolve, which is correct.
    // The timeout only guards against the initial non-superseded load hanging.
    const _timeoutSentinel = Symbol('timeout');
    const userFetchPromise = getCurrentUser.pipe(Effect.option, Effect.map(Option.flatten), run);
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof _timeoutSentinel>((resolve) => {
      timeoutId = setTimeout(() => resolve(_timeoutSentinel), USER_FETCH_TIMEOUT_MS);
    });
    const raceResult = await Promise.race([userFetchPromise, timeoutPromise]);
    // Always clear the timeout to prevent it from firing after a successful fetch
    clearTimeout(timeoutId);
    // If the navigation was superseded while we were waiting, never resolve —
    // preserve the original supersede semantics (the router discards this load).
    if (abortController.signal.aborted) {
      return new Promise<never>(() => {});
    }
    // If timeout won on a genuine (non-superseded) initial load, treat as logged-out
    // and emit a diagnostic so we can measure slow-but-healthy connections.
    if (raceResult === _timeoutSentinel) {
      runEffect(
        Effect.logWarning('User fetch timed out on initial load — treating as logged-out', {
          timeoutMs: USER_FETCH_TIMEOUT_MS,
          url: typeof window !== 'undefined' ? window.location.href : '',
        }),
      );
    }
    const user = raceResult === _timeoutSentinel ? Option.none() : raceResult;
    if (Option.isSome(user)) {
      setLocale(user.value.locale);
    }
    return {
      environment,
      run,
      userOption: user,
      serverUrl: environment.SERVER_URL,
    };
  },
});

// The document shell renders ABOVE the root match's context provider (see
// @tanstack/react-router Match.js), so `Route.useRouteContext()` is NOT
// available here — anything that depends on the loaded route context (e.g.
// `serverUrl` from `beforeLoad`) must live in `RootComponent` instead.
function RootDocumentRoute({ children }: { children: React.ReactNode }) {
  return (
    <AppErrorBoundary>
      <ThemeProvider>
        <RootDocument>{children}</RootDocument>
      </ThemeProvider>
    </AppErrorBoundary>
  );
}

// Rendered inside the root match's context provider, so `serverUrl` (resolved
// in `beforeLoad`) is reliably available — unlike in the shell. The API base
// URL flows from here into every client call via `RunProvider` /
// `TranslationOverridesProvider`.
function RootComponent() {
  const { serverUrl } = Route.useRouteContext();

  // Signal the pre-mount watchdog that the app has successfully mounted.
  // Note: does NOT clear the reload guard here — that only happens once a
  // child route renders successfully (see HealthyOutlet below).
  useEffect(() => markAppMounted(), []);

  return (
    <RunProvider value={runPromiseClient(serverUrl)}>
      <TranslationOverridesProvider serverUrl={serverUrl}>
        <Profiler
          id='app'
          onRender={(_id, _phase, actualDuration) => recordReactRender(runEffect, actualDuration)}
        >
          <HealthyOutlet />
        </Profiler>
      </TranslationOverridesProvider>
    </RunProvider>
  );
}

// Wrapper that clears the reload guard once the Outlet has committed — i.e.
// a real child route rendered without crashing. This is the "healthy" signal
// that tells the watchdog the app is genuinely working.
function HealthyOutlet() {
  useEffect(() => {
    markRouteHealthy();
  }, []);
  return <Outlet />;
}
