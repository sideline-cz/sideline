import { createRouter as createTanStackRouter } from '@tanstack/react-router';
import type React from 'react';
import * as TanstackQuery from '~/integrations/tanstack-query/root-provider';
import { routeTree } from './routeTree.gen';

/**
 * Tell TanStack Router that SSR serialization validation is disabled.
 * This is needed because Effect's Option type uses branded phantom types
 * (Covariant<A>) which contain function signatures. These are structurally
 * valid at runtime (Option serializes as { _tag, value }) but fail
 * TanStack's compile-time serialization check.
 *
 * The root route already sets `ssr: false` at runtime.
 */
declare module '@tanstack/react-router' {
  interface Register {
    // Registering the router is what gives `Route.useLoaderData()`, `useParams()` and
    // `useSearch()` their real types. Without it `RegisteredRouter` falls back to
    // `AnyRouter` and every route's loader data silently resolves to `any`.
    router: ReturnType<typeof getRouter>;
    config: {
      '~types': {
        defaultSsr: false;
        serializationAdapters: unknown;
        requestMiddleware: unknown;
        functionMiddleware: unknown;
      };
    };
  }
}

export function getRouter() {
  const rqContext = TanstackQuery.getContext();

  const router = createTanStackRouter({
    routeTree,
    context: { ...rqContext },
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    Wrap: (props: { children: React.ReactNode }) => {
      return <TanstackQuery.Provider {...rqContext}>{props.children}</TanstackQuery.Provider>;
    },
  });

  return router;
}
