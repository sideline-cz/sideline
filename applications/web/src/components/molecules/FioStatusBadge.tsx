import type { BankSyncConfig } from '@sideline/domain';
import type { LucideIcon } from 'lucide-react';
import {
  AlertTriangle,
  CheckCircle,
  Clock,
  Landmark,
  RefreshCw,
  ServerCrash,
  ShieldAlert,
} from 'lucide-react';
import { Badge } from '~/components/ui/badge';
import { tr } from '~/lib/translations.js';

interface FioStatusBadgeProps {
  readonly status: BankSyncConfig.BankSyncStatusCode;
}

/**
 * The compact status badge for surfaces that just need "is the bank connected" at a glance (the
 * bank page header, `DiscordConnectionBadge.tsx` shape). The full explanation — including the
 * additive `expiringSoon` banner — lives in `organisms/bank/FioStatusBlock.tsx`; this molecule
 * never re-derives the status, it only renders the server-computed literal (D11).
 */
const STATUS_META: Record<
  BankSyncConfig.BankSyncStatusCode,
  {
    readonly Icon: LucideIcon;
    readonly labelKey: string;
    readonly variant: 'success' | 'default' | 'destructive';
  }
> = {
  ok: { Icon: CheckCircle, labelKey: 'fio_status_ok', variant: 'success' },
  activating: { Icon: Clock, labelKey: 'fio_status_activatingTitle', variant: 'default' },
  sync_failing: { Icon: RefreshCw, labelKey: 'fio_status_syncFailingTitle', variant: 'default' },
  invalid: { Icon: AlertTriangle, labelKey: 'fio_status_invalidTitle', variant: 'destructive' },
  account_mismatch: {
    Icon: ShieldAlert,
    labelKey: 'fio_status_accountMismatchTitle',
    variant: 'destructive',
  },
  misconfigured: {
    Icon: ServerCrash,
    labelKey: 'fio_status_misconfiguredTitle',
    variant: 'destructive',
  },
  not_connected: { Icon: Landmark, labelKey: 'fio_status_notConnectedTitle', variant: 'default' },
};

export function FioStatusBadge({ status }: FioStatusBadgeProps) {
  const { Icon, labelKey, variant } = STATUS_META[status];

  return (
    <Badge variant={variant} className='gap-1' data-bank-sync-status={status}>
      <Icon className='size-3' aria-hidden='true' />
      {tr(labelKey)}
    </Badge>
  );
}
