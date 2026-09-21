import { RefreshCw } from 'lucide-react';
import { Button } from '~/components/ui/button';
import { Skeleton } from '~/components/ui/skeleton';
import type { UseQrObjectUrlState } from '~/lib/finance/useQrObjectUrl.js';
import { tr } from '~/lib/translations.js';

interface QrPaymentCodeProps {
  readonly url: string | null;
  readonly state: UseQrObjectUrlState;
  /** Informative alt text carrying the payment data — never `alt=''` (design §6.6). */
  readonly alt: string;
  readonly size?: number;
  /** The hook owns no retry itself (fixed 3-arg signature); the caller re-triggers a fetch by
   * remounting (e.g. bumping a `key`). Omit to render the error text with no button. */
  readonly onRetry?: () => void;
}

/**
 * Presentational only — takes `{ url, state }` from `useQrObjectUrl` and owns no fetch of its
 * own (design §9.2). Fixed `width`/`height` so the row never jumps; `loading='lazy'`.
 */
export function QrPaymentCode({ url, state, alt, size = 200, onRetry }: QrPaymentCodeProps) {
  if (state === 'loading') {
    return <Skeleton style={{ width: size, height: size }} />;
  }

  if (state === 'error' || url === null) {
    return (
      <div
        className='flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground'
        style={{ width: size, height: size }}
      >
        <p>{tr('my_payments_qr_error')}</p>
        {onRetry ? (
          <Button type='button' variant='outline' size='sm' onClick={onRetry}>
            <RefreshCw className='size-3' aria-hidden='true' />
            {tr('bank_export_retry')}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <img
      src={url}
      alt={alt}
      width={size}
      height={size}
      loading='lazy'
      className='rounded-md border'
    />
  );
}
