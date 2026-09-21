import { Check, Copy } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { copyToClipboard } from '~/lib/clipboard';
import { tr } from '~/lib/translations.js';

export interface PaymentDetailsRow {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** `sr-only` label for the per-row copy button, e.g. "Zkopírovat číslo účtu". */
  readonly copyAriaLabel: string;
}

interface PaymentDetailsListProps {
  readonly rows: ReadonlyArray<PaymentDetailsRow>;
}

/**
 * Account / amount / VS / message rows with a per-row copy button — shared by the player-facing
 * QR card (`MyPaymentsPage`) and the resolve dialog's movement-detail sheet (design §9.2).
 * Copying always goes through `~/lib/clipboard` (never a bare `navigator.clipboard.writeText`).
 */
export function PaymentDetailsList({ rows }: PaymentDetailsListProps) {
  const [copiedKey, setCopiedKey] = React.useState<string | null>(null);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleCopy = (key: string, value: string) => {
    copyToClipboard(value).then((ok) => {
      if (!ok) return;
      setCopiedKey(key);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopiedKey(null), 2000);
    });
  };

  return (
    <dl className='flex flex-col gap-2'>
      {rows.map((row) => (
        <div key={row.key} className='flex items-center justify-between gap-2'>
          <div className='min-w-0'>
            <dt className='text-xs text-muted-foreground'>{row.label}</dt>
            <dd className='truncate font-mono text-sm tabular-nums'>{row.value}</dd>
          </div>
          <Button
            type='button'
            variant='ghost'
            size='icon'
            className='shrink-0'
            onClick={() => handleCopy(row.key, row.value)}
          >
            {copiedKey === row.key ? (
              <Check className='size-3.5' aria-hidden='true' />
            ) : (
              <Copy className='size-3.5' aria-hidden='true' />
            )}
            <span className='sr-only'>
              {copiedKey === row.key ? tr('my_payments_qr_copied') : row.copyAriaLabel}
            </span>
          </Button>
        </div>
      ))}
    </dl>
  );
}
