import type { ErrorComponentProps } from '@tanstack/react-router';
import { useRouter } from '@tanstack/react-router';
import { Effect } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import { reassertThemeOnDocument, resolveStoredTheme } from '~/lib/resolveStoredTheme.js';
import { runEffect } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

export function RouteErrorComponent({ error }: ErrorComponentProps) {
  const router = useRouter();
  const [isOffline, setIsOffline] = React.useState(!navigator.onLine);

  // Re-assert theme on <html>/<body> immediately — this component is caught by
  // TanStack Router's inner CatchBoundary (below ThemeProvider), so the .dark
  // class may have been stripped when the component tree above unmounted.
  const resolved = resolveStoredTheme();
  React.useLayoutEffect(() => {
    reassertThemeOnDocument();
  }, []);

  React.useEffect(() => {
    runEffect(Effect.logError('Route error boundary caught', error));
  }, [error]);

  React.useEffect(() => {
    const goOnline = () => setIsOffline(false);
    const goOffline = () => setIsOffline(true);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // Explicit background prevents the white-screen: <body> has bg-background
  // which resolves to white when .dark is absent. The inline style is a
  // belt-and-suspenders guard until the layoutEffect fires.
  const bg = resolved === 'dark' ? '#0a0a0a' : '#ffffff';
  const fg = resolved === 'dark' ? '#ffffff' : '#0a0a0a';

  return (
    <div
      className='flex min-h-dvh flex-col items-center justify-center gap-6 p-8 text-center'
      style={{ backgroundColor: bg, color: fg, minHeight: '100dvh' }}
    >
      {isOffline ? (
        <>
          <img src='/icons/icon-192.png' alt='Sideline' className='h-20 w-20 opacity-60' />
          <div className='space-y-2'>
            <h1 className='text-2xl font-bold tracking-tight'>{tr('error_offline')}</h1>
            <p className='max-w-md text-muted-foreground'>{tr('error_offlineMessage')}</p>
          </div>
        </>
      ) : (
        <>
          <div className='text-6xl font-black text-muted-foreground/20'>!</div>
          <div className='space-y-2'>
            <h1 className='text-2xl font-bold tracking-tight'>{tr('error_title')}</h1>
            <p className='max-w-md text-muted-foreground'>{tr('error_message')}</p>
          </div>
        </>
      )}
      <div className='flex gap-3'>
        <Button onClick={() => router.invalidate()} variant='default'>
          {tr('error_tryAgain')}
        </Button>
        <Button asChild variant='outline'>
          <a href='/'>{tr('error_goHome')}</a>
        </Button>
      </div>
    </div>
  );
}
