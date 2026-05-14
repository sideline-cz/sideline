import { Download, Share, X } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { usePwaInstall } from '~/hooks/use-pwa-install.js';
import { tr } from '~/lib/translations.js';

export function PwaInstallPrompt() {
  const { canInstall, isIOS, promptInstall, dismiss } = usePwaInstall();

  if (!canInstall) {
    return null;
  }

  return (
    <div className='mx-4 my-4 flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-card-foreground shadow-sm'>
      <div className='flex shrink-0 items-center pt-0.5'>
        {isIOS ? (
          <Share className='h-5 w-5 text-muted-foreground' />
        ) : (
          <Download className='h-5 w-5 text-muted-foreground' />
        )}
      </div>
      <div className='flex flex-1 flex-col gap-1'>
        <p className='text-sm font-semibold leading-none'>{tr('pwa_installTitle')}</p>
        <p className='text-sm text-muted-foreground'>
          {isIOS ? tr('pwa_iosInstructions') : tr('pwa_installDescription')}
        </p>
        {!isIOS && (
          <div className='mt-2'>
            <Button size='sm' onClick={promptInstall}>
              {tr('pwa_installButton')}
            </Button>
          </div>
        )}
      </div>
      <Button
        variant='ghost'
        size='icon'
        className='shrink-0'
        onClick={dismiss}
        aria-label={tr('pwa_dismissButton')}
      >
        <X className='h-4 w-4' />
      </Button>
    </div>
  );
}
