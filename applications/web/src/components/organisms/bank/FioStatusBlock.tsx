import type { BankSyncApi } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle,
  Clock,
  Landmark,
  RefreshCw,
  ServerCrash,
} from 'lucide-react';
import React from 'react';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { tr } from '~/lib/translations.js';

interface FioStatusBlockProps {
  readonly config: BankSyncApi.BankSyncConfigView | null;
  readonly onReplaceToken: () => void;
  readonly onRetryNow: () => void;
  readonly retrying: boolean;
  /** A save is in flight — the retry probe must not run against the token that is about to be
   * replaced by that save, so it is disabled the same way the standalone test button is. */
  readonly saving?: boolean;
  /** Only known where the queue's KPI summary was already loaded (`BankTransactionsPage`) — the
   * settings card renders the status without it, so "ok" there shows the title alone. */
  readonly summary?: { readonly importedCount: number; readonly pendingCount: number };
}

const FIVE_MINUTES_MS = 5 * 60 * 1000;

function toDate(opt: Option.Option<DateTime.DateTime>): Date | null {
  return Option.isSome(opt) ? DateTime.toDateUtc(opt.value) : null;
}

function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes)} min ${String(seconds)} s`;
}

/**
 * The status block at the top of the Fio card (design §2.5) — driven ENTIRELY by the
 * server-computed `status` literal (D11) and the additive `expiringSoon` boolean. The web never
 * re-derives the ladder from timestamps.
 */
export function FioStatusBlock({
  config,
  onReplaceToken,
  onRetryNow,
  retrying,
  saving = false,
  summary,
}: FioStatusBlockProps) {
  const { formatRelative } = useFormatDate();
  const [, forceTick] = React.useReducer((n: number) => n + 1, 0);

  // The activating countdown is plain text, `aria-live='off'` — only the transition out of the
  // state is announced (design §2.5 C). One tick per second keeps the countdown honest without
  // a screen-reader-hostile live region.
  React.useEffect(() => {
    if (config?.status !== 'activating') return;
    const id = setInterval(forceTick, 1000);
    return () => clearInterval(id);
  }, [config?.status]);

  if (config === null || config.status === 'not_connected') {
    return (
      <Alert variant='default' data-bank-sync-status='not_connected'>
        <Landmark aria-hidden='true' />
        <AlertTitle>{tr('fio_status_notConnectedTitle')}</AlertTitle>
        <AlertDescription>{tr('fio_status_notConnectedBody')}</AlertDescription>
      </Alert>
    );
  }

  const expiringBanner =
    config.expiringSoon && Option.isSome(config.tokenExpiresAt) ? (
      <ExpiringBanner
        tokenExpiresAt={config.tokenExpiresAt.value}
        onReplaceToken={onReplaceToken}
      />
    ) : null;

  let statusAlert: React.ReactNode;

  switch (config.status) {
    case 'ok': {
      const lastSyncedDate = toDate(config.lastSuccessAt);
      const time = lastSyncedDate ? formatRelative(lastSyncedDate) : '—';
      statusAlert = (
        <Alert variant='default' data-bank-sync-status='ok'>
          <CheckCircle aria-hidden='true' />
          <AlertTitle>{tr('fio_status_ok')}</AlertTitle>
          {summary ? (
            <AlertDescription aria-live='polite'>
              {tr('fio_status_okDetail', {
                time,
                imported: summary.importedCount,
                pending: summary.pendingCount,
              })}
            </AlertDescription>
          ) : null}
        </Alert>
      );
      break;
    }
    case 'activating': {
      const createdDate = toDate(config.tokenCreatedAt);
      const remainingMs = createdDate
        ? Math.max(0, createdDate.getTime() + FIVE_MINUTES_MS - Date.now())
        : 0;
      statusAlert = (
        <Alert variant='default' data-bank-sync-status='activating'>
          <Clock aria-hidden='true' />
          <AlertTitle>{tr('fio_status_activatingTitle')}</AlertTitle>
          <AlertDescription>
            <p>{tr('fio_status_activatingBody')}</p>
            <p aria-live='off'>
              {tr('fio_status_activatingRemaining', { time: formatDuration(remainingMs) })}
            </p>
            <Button
              type='button'
              variant='outline'
              size='sm'
              onClick={onRetryNow}
              disabled={retrying || saving}
            >
              {tr('fio_status_activatingRetry')}
            </Button>
          </AlertDescription>
        </Alert>
      );
      break;
    }
    case 'sync_failing': {
      const lastSuccessDate = toDate(config.lastSuccessAt);
      const time = lastSuccessDate ? formatRelative(lastSuccessDate) : '—';
      statusAlert = (
        <Alert variant='default' data-bank-sync-status='sync_failing'>
          <RefreshCw aria-hidden='true' />
          <AlertTitle>{tr('fio_status_syncFailingTitle')}</AlertTitle>
          <AlertDescription>{tr('fio_status_syncFailingBody', { time })}</AlertDescription>
        </Alert>
      );
      break;
    }
    case 'invalid': {
      const neverSucceeded = Option.isNone(config.lastSuccessAt);
      const lastAttemptDate = toDate(config.lastAttemptAt);
      const date = lastAttemptDate ? formatRelative(lastAttemptDate) : '—';
      statusAlert = (
        <Alert variant='destructive' data-bank-sync-status='invalid'>
          <AlertTriangle aria-hidden='true' />
          <AlertTitle>
            {neverSucceeded ? tr('fio_status_neverWorkedTitle') : tr('fio_status_invalidTitle')}
          </AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            <p>
              {neverSucceeded
                ? tr('fio_status_neverWorkedBody')
                : tr('fio_status_invalidBody', { date })}
            </p>
            {!neverSucceeded && <p>{tr('fio_status_invalidAction')}</p>}
            <Button type='button' variant='outline' size='sm' onClick={onReplaceToken}>
              {tr('fio_token_replace')}
            </Button>
          </AlertDescription>
        </Alert>
      );
      break;
    }
    case 'misconfigured': {
      statusAlert = (
        <Alert variant='destructive' data-bank-sync-status='misconfigured'>
          <ServerCrash aria-hidden='true' />
          <AlertTitle>{tr('fio_status_misconfiguredTitle')}</AlertTitle>
          <AlertDescription>{tr('fio_status_misconfiguredBody')}</AlertDescription>
        </Alert>
      );
      break;
    }
    default:
      statusAlert = null;
  }

  return (
    <div className='flex flex-col gap-3'>
      {expiringBanner}
      {statusAlert}
    </div>
  );
}

function ExpiringBanner({
  tokenExpiresAt,
  onReplaceToken,
}: {
  readonly tokenExpiresAt: DateTime.DateTime;
  readonly onReplaceToken: () => void;
}) {
  const expiresDate = DateTime.toDateUtc(tokenExpiresAt);
  const daysLeft = Math.max(
    0,
    Math.ceil((expiresDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)),
  );
  const dateLabel = new Intl.DateTimeFormat(undefined, { dateStyle: 'short' }).format(expiresDate);
  const escalated = daysLeft <= 7;

  return (
    <Alert variant={escalated ? 'destructive' : 'warning'} data-bank-sync-status='expiring_soon'>
      <CalendarClock aria-hidden='true' />
      <AlertTitle>
        {tr('fio_status_expiringTitle', { days: daysLeft })}{' '}
        {tr('fio_status_expiringDate', { date: dateLabel })}
      </AlertTitle>
      <AlertDescription className='flex flex-col gap-2'>
        <p>{tr('fio_status_expiringBody')}</p>
        <ul className='list-disc pl-4'>
          <li>{tr('fio_status_expiringOption1')}</li>
          <li>{tr('fio_status_expiringOption2')}</li>
        </ul>
        <div className='flex gap-2'>
          <Button asChild type='button' variant='outline' size='sm'>
            <a href='https://ib.fio.cz' target='_blank' rel='noopener noreferrer'>
              {tr('fio_status_createNewToken')}
            </a>
          </Button>
          <Button type='button' variant='outline' size='sm' onClick={onReplaceToken}>
            {tr('fio_token_replace')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}
