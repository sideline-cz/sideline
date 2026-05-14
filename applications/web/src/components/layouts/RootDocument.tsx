import { getLocale } from '@sideline/i18n/runtime';
import { TanStackDevtools } from '@tanstack/react-devtools';
import { HeadContent, Scripts } from '@tanstack/react-router';
import { TanStackRouterDevtoolsPanel } from '@tanstack/react-router-devtools';
import React from 'react';
import { Toaster } from '~/components/ui/sonner';
import TanStackQueryDevtools from '~/integrations/tanstack-query/devtools';
import { type Run, RunProvider } from '~/lib/runtime';
import { TranslationOverridesProvider } from '~/lib/translation-overrides-context.js';

interface RootDocumentProps {
  run: Run;
  children: React.ReactNode;
  serverUrl: string;
}

export function RootDocument({ run, children, serverUrl }: RootDocumentProps) {
  const locale = getLocale();

  React.useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {
        // SW registration failed — app continues without offline support
      });
    }
  }, []);

  return (
    <html lang={locale}>
      <head>
        <HeadContent />
      </head>
      <body>
        <RunProvider value={run}>
          <TranslationOverridesProvider serverUrl={serverUrl}>
            {children}
          </TranslationOverridesProvider>
        </RunProvider>
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
