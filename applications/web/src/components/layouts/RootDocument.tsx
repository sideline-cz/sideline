import { getLocale } from '@sideline/i18n/runtime';
import { HeadContent, Scripts } from '@tanstack/react-router';
import React from 'react';
import { Toaster } from '~/components/ui/sonner';
import { PRE_MOUNT_GUARD_SOURCE } from '~/lib/preMountGuard.js';
import { RESETTING_KEY, requestSwReload } from '~/lib/reloadGuard.js';
import { shouldReloadOnControllerChange } from '~/lib/sw-reload.js';

interface RootDocumentProps {
  children: React.ReactNode;
}

// Module-level so it survives Suspense/StrictMode remounts within the same
// document and only resets on a real page reload — prevents reload loops.
let swReloaded = false;

export function RootDocument({ children }: RootDocumentProps) {
  const locale = getLocale();

  React.useEffect(() => {
    if (!('serviceWorker' in navigator)) {
      return;
    }

    // Captured synchronously before registration: was the page already
    // controlled by an earlier SW? If so, a later controllerchange means an
    // updated SW took over and we should reload to escape any stale code.
    const hadController = navigator.serviceWorker.controller !== null;

    const onControllerChange = () => {
      if (!shouldReloadOnControllerChange(hadController, swReloaded)) {
        return;
      }
      // Skip if we're in the middle of an SW reset (sw-recovery sets this flag)
      try {
        if (sessionStorage.getItem(RESETTING_KEY)) {
          return;
        }
      } catch {
        // sessionStorage unavailable — proceed with reload
      }
      swReloaded = true;
      requestSwReload();
    };

    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange);
    navigator.serviceWorker.register('/sw.js').catch(() => {
      // SW registration failed — app continues without offline support
    });

    return () => {
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);

  return (
    <html lang={locale}>
      <head>
        <HeadContent />
        {/* Pre-mount watchdog: injected before the bundle to set up error guards.
            The source is a build-time constant (no user input), so XSS is not a concern. */}
        {/* biome-ignore lint/security/noDangerouslySetInnerHtml: build-time constant guard script, no user input */}
        <script dangerouslySetInnerHTML={{ __html: PRE_MOUNT_GUARD_SOURCE }} />
      </head>
      <body>
        {children}
        {import.meta.env.DEV && <DevtoolsPanel />}
        <Toaster position='top-right' richColors closeButton />
        <Scripts />
      </body>
    </html>
  );
}

// Devtools are lazily imported and only included in dev builds.
// The dynamic import ensures the devtools packages are fully tree-shaken in production.
function DevtoolsPanel() {
  const [DevtoolsComponent, setDevtoolsComponent] = React.useState<React.ComponentType | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [
        { TanStackDevtools },
        { TanStackRouterDevtoolsPanel },
        { default: TanStackQueryDevtools },
      ] = await Promise.all([
        import('@tanstack/react-devtools'),
        import('@tanstack/react-router-devtools'),
        import('~/integrations/tanstack-query/devtools'),
      ]);
      if (!cancelled) {
        const Devtools = () => (
          <div data-testid='tanstack-devtools'>
            <TanStackDevtools
              config={{ position: 'bottom-right' }}
              plugins={[
                { name: 'Tanstack Router', render: <TanStackRouterDevtoolsPanel /> },
                TanStackQueryDevtools,
              ]}
            />
          </div>
        );
        setDevtoolsComponent(() => Devtools);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!DevtoolsComponent) return null;
  return <DevtoolsComponent />;
}
