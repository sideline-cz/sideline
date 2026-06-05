import { getLocale } from '@sideline/i18n/runtime';
import { TanStackDevtools } from '@tanstack/react-devtools';
import { HeadContent, Scripts } from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import React from 'react';
import { Toaster } from '~/components/ui/sonner';
import TanStackQueryDevtools from '~/integrations/tanstack-query/devtools';
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
      swReloaded = true;
      window.location.reload();
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
      </head>
      <body>
        {children}
        <TanStackDevtools
          config={{
            position: 'bottom-right',
          }}
          plugins={[
            {
              name: 'Tanstack Router',
              render: <TanStackRouterDevtoolsPanel />,
            },
            TanStackQueryDevtools,
          ]}
        />
        <Toaster position='top-right' richColors closeButton />
        <Scripts />
      </body>
    </html>
  );
}
