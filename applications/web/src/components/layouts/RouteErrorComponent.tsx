import { useRouter } from '@tanstack/react-router';
import React from 'react';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';

export function RouteErrorComponent() {
  const router = useRouter();
  const [isOffline, setIsOffline] = React.useState(!navigator.onLine);

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

  return (
    <div className='flex min-h-[60vh] flex-col items-center justify-center gap-6 p-8 text-center'>
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
