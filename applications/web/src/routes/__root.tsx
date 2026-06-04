import { setLocale } from '@sideline/i18n/runtime';
import type { QueryClient } from '@tanstack/react-query';
import { createRootRouteWithContext } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import type React from 'react';
import { RootDocument } from '~/components/layouts/RootDocument';
import { RouteErrorComponent } from '~/components/layouts/RouteErrorComponent';
import { RouteNotFoundComponent } from '~/components/layouts/RouteNotFoundComponent';
import { RoutePendingComponent } from '~/components/layouts/RoutePendingComponent';
import { fetchEnv } from '~/env.js';
import { ApiClient, runPromiseClient, runPromiseServer } from '~/lib/runtime';
import { ThemeProvider } from '~/lib/theme.js';
import appCss from '../styles.css?url';

const getCurrentUser = ApiClient.asEffect().pipe(
  Effect.flatMap((api) => api.auth.me()),
  Effect.map(Option.some),
  Effect.catchTag('Unauthorized', () => Effect.succeed(Option.none())),
  Effect.tap((user) => Effect.logInfo('Logged in as', user)),
);

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
  errorComponent: RouteErrorComponent,
  pendingComponent: RoutePendingComponent,
  notFoundComponent: RouteNotFoundComponent,
  beforeLoad: async ({ abortController }) => {
    const environment = await fetchEnv(abortController);
    const makeRun = runPromiseServer(environment.SERVER_URL);
    const run = makeRun(abortController);
    // On a superseded navigation this intentionally never resolves — do not add a timeout.
    const user = await getCurrentUser.pipe(Effect.option, Effect.map(Option.flatten), run);
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

function RootDocumentRoute({ children }: { children: React.ReactNode }) {
  const { serverUrl } = Route.useRouteContext();

  return (
    <ThemeProvider>
      <RootDocument run={runPromiseClient(serverUrl)} serverUrl={serverUrl}>
        {children}
      </RootDocument>
    </ThemeProvider>
  );
}
