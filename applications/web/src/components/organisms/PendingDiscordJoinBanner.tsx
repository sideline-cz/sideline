import * as m from '@sideline/i18n/messages';
import { Effect, Option } from 'effect';
import { ExternalLink, X } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import {
  clearPendingDiscordJoin,
  getPendingDiscordJoin,
  type PendingDiscordJoin,
} from '~/lib/auth';
import { ApiClient, ClientError, useRun } from '~/lib/runtime';

const STALE_MS = 24 * 60 * 60 * 1000; // 24h matches the Discord invite max_age

export function PendingDiscordJoinBanner() {
  const run = useRun();
  const [entry, setEntry] = React.useState<PendingDiscordJoin | null>(null);
  const [discordUrl, setDiscordUrl] = React.useState<string | null>(null);
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    const loaded = Effect.runSync(getPendingDiscordJoin);
    if (Option.isNone(loaded)) return;
    if (Date.now() - loaded.value.ts > STALE_MS) {
      Effect.runFork(clearPendingDiscordJoin);
      return;
    }
    setEntry(loaded.value);
  }, []);

  const acceptanceId = entry?.acceptanceId;

  React.useEffect(() => {
    if (!acceptanceId) return;
    if (discordUrl !== null || failed) return;

    let cancelled = false;
    const poll = () =>
      ApiClient.asEffect().pipe(
        Effect.flatMap((api) =>
          api.invite.getJoinStatus({ params: { acceptanceId: acceptanceId as never } }),
        ),
        Effect.tap((status) =>
          Effect.sync(() => {
            if (cancelled) return;
            if (Option.isSome(status.discordInviteUrl)) {
              setDiscordUrl(status.discordInviteUrl.value);
            } else if (Option.isSome(status.errorCode)) {
              setFailed(true);
            }
          }),
        ),
        Effect.mapError(() => ClientError.make('')),
        run(),
      );

    void poll();
    const interval = window.setInterval(poll, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [acceptanceId, discordUrl, failed, run]);

  const handleDismiss = React.useCallback(() => {
    Effect.runFork(clearPendingDiscordJoin);
    setEntry(null);
  }, []);

  const handleOpen = React.useCallback(() => {
    Effect.runFork(clearPendingDiscordJoin);
  }, []);

  if (entry === null) return null;
  if (failed) {
    return (
      <div className='border-b bg-destructive/10 px-4 py-2 text-sm flex items-center justify-between gap-3'>
        <span>{m.invite_discordInviteFailedDescription()}</span>
        <Button variant='ghost' size='icon' onClick={handleDismiss} aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
    );
  }
  if (discordUrl === null) {
    return (
      <div className='border-b bg-muted px-4 py-2 text-sm flex items-center justify-between gap-3'>
        <span className='text-muted-foreground'>
          {m.invite_preparingDiscordInviteDescription()}
        </span>
        <Button variant='ghost' size='icon' onClick={handleDismiss} aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
    );
  }
  return (
    <div className='border-b bg-primary/10 px-4 py-2 text-sm flex items-center justify-between gap-3'>
      <span>{m.invite_joinDiscordBannerDescription()}</span>
      <div className='flex items-center gap-1'>
        <a href={discordUrl} target='_blank' rel='noopener noreferrer' onClick={handleOpen}>
          <Button size='sm'>
            {m.invite_joinDiscordButton()}
            <ExternalLink className='size-3 ml-1' />
          </Button>
        </a>
        <Button variant='ghost' size='icon' onClick={handleDismiss} aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
    </div>
  );
}
