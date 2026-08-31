/**
 * PR-5 rewrite (`.work-plans/discord-onboarding-fix-plan.md`) — server-sourced replacement for
 * the old localStorage-only banner. Sources its state from
 * `api.invite.getMyPendingDiscordJoin({ params: { teamId: teamIdBranded } })`, polled every 2s, and stops
 * polling once a terminal state (`'expired'` | `'failed'`) is reached. `getPendingDiscordJoin`
 * (localStorage) is read only once, as an initial hint rendered while the first request is in
 * flight — the server response always wins the moment it arrives, even if it disagrees.
 *
 * The poll's failures map to `SilentClientError`, not `ClientError`, so `runPromiseClient`
 * never fires an empty `toast.error('')` every 2s while polling fails (the real production
 * regression this PR fixes).
 */
import { Team } from '@sideline/domain';
import { Effect, Option, Schema } from 'effect';
import { ExternalLink, Loader2, X } from 'lucide-react';
import React from 'react';
import { Button } from '~/components/ui/button';
import { getPendingDiscordJoin } from '~/lib/auth';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const POLL_INTERVAL_MS = 2000;

type JoinStatusView = {
  readonly acceptanceId: string;
  readonly state: 'preparing' | 'ready' | 'expired' | 'failed';
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<string>;
};

const TERMINAL_STATES: ReadonlySet<JoinStatusView['state']> = new Set(['expired', 'failed']);

const isTerminal = (status: JoinStatusView | null): boolean =>
  status !== null && TERMINAL_STATES.has(status.state);

function errorCopyKey(errorCode: Option.Option<string>): string {
  return Option.match(errorCode, {
    onNone: () => 'discord_connect_error_generic',
    onSome: (code) =>
      code === 'welcome_channel_missing' || code === 'welcome_channel_deleted'
        ? 'discord_connect_error_captainAction'
        : code === 'bot_missing_perms'
          ? 'discord_connect_error_botPerms'
          : 'discord_connect_error_generic',
  });
}

interface PendingDiscordJoinBannerProps {
  readonly teamId: string;
}

export function PendingDiscordJoinBanner({ teamId }: PendingDiscordJoinBannerProps) {
  const teamIdBranded = Schema.decodeSync(Team.TeamId)(teamId);
  const run = useRun();
  const [status, setStatus] = React.useState<JoinStatusView | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [noInviteAvailable, setNoInviteAvailable] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  const [dismissed, setDismissed] = React.useState(false);
  // Read once on mount — purely an initial hint while the first server request is in flight.
  // The server response (below) always wins once it arrives, whether or not it agrees.
  const [hint] = React.useState(() => Effect.runSync(getPendingDiscordJoin));

  // `teamId` is not read in the body — it exists purely to reset local state when the caller
  // switches the active team out from under this component.
  // biome-ignore lint/correctness/useExhaustiveDependencies: teamId is a deliberate reset trigger, not a value read here
  React.useEffect(() => {
    setStatus(null);
    setHasLoaded(false);
    setNoInviteAvailable(false);
    setDismissed(false);
  }, [teamId]);

  // `pollGeneration` exists purely so `handleRegenerate` can force this effect to restart
  // polling after a successful (non-terminal) regenerate — bumping it re-runs the effect body,
  // which immediately issues a fresh poll instead of waiting for the next tick.
  const [pollGeneration, setPollGeneration] = React.useState(0);

  // biome-ignore lint/correctness/useExhaustiveDependencies: pollGeneration is a deliberate restart trigger, not a value read here
  React.useEffect(() => {
    let cancelled = false;
    let timeoutId: number | undefined;

    const poll = () => {
      void ApiClient.asEffect()
        .pipe(
          Effect.flatMap((api) =>
            api.invite.getMyPendingDiscordJoin({ params: { teamId: teamIdBranded } }),
          ),
          Effect.map(Option.getOrNull),
          Effect.tap((result) =>
            Effect.sync(() => {
              if (cancelled) return;
              setHasLoaded(true);
              setNoInviteAvailable(false);
              setStatus(result);
            }),
          ),
          Effect.mapError(() => new SilentClientError({ message: '' })),
          run(),
        )
        .then((outcome) => {
          if (cancelled) return;
          const result = Option.getOrNull(outcome);
          if (!isTerminal(result)) {
            timeoutId = window.setTimeout(poll, POLL_INTERVAL_MS);
          }
        });
    };

    poll();
    return () => {
      cancelled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
    };
  }, [teamIdBranded, run, pollGeneration]);

  const handleRegenerate = React.useCallback(() => {
    setRegenerating(true);
    void ApiClient.asEffect()
      .pipe(
        Effect.flatMap((api) =>
          api.invite.regenerateMyDiscordInvite({ params: { teamId: teamIdBranded } }),
        ),
        Effect.map(Option.getOrNull),
        Effect.tap((result) =>
          Effect.sync(() => {
            setHasLoaded(true);
            setStatus(result);
            setNoInviteAvailable(result === null);
            // Resume polling only when the response is a real, non-terminal state — an
            // 'expired'/'failed' result (or None) has nothing further to wait for.
            if (!isTerminal(result)) {
              setPollGeneration((g) => g + 1);
            }
          }),
        ),
        Effect.mapError(() => new SilentClientError({ message: '' })),
        run(),
      )
      .then(() => {
        setRegenerating(false);
      });
  }, [teamIdBranded, run]);

  if (dismissed) return null;

  if (noInviteAvailable) {
    return (
      <div className='border-b bg-muted px-4 py-2 text-sm flex items-center justify-between gap-3'>
        <div className='flex flex-col'>
          <span className='font-medium'>{tr('discord_connect_noLinkTitle')}</span>
          <span className='text-muted-foreground'>{tr('discord_connect_noLinkBody')}</span>
        </div>
        <Button variant='ghost' size='icon' onClick={() => setDismissed(true)} aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
    );
  }

  const effective = hasLoaded
    ? status
    : Option.isSome(hint) && hint.value.teamId === teamId
      ? {
          acceptanceId: hint.value.acceptanceId,
          state: 'preparing' as const,
          discordInviteUrl: Option.none<string>(),
          errorCode: Option.none<string>(),
        }
      : null;

  if (effective === null) return null;

  if (effective.state === 'failed') {
    return (
      <div
        role='status'
        aria-live='polite'
        className='border-b bg-destructive/10 px-4 py-2 text-sm flex items-center justify-between gap-3'
      >
        <span>{tr(errorCopyKey(effective.errorCode))}</span>
        <Button variant='ghost' size='icon' onClick={() => setDismissed(true)} aria-label='Dismiss'>
          <X className='size-4' />
        </Button>
      </div>
    );
  }

  if (effective.state === 'expired') {
    return (
      <div
        role='status'
        aria-live='polite'
        className='border-b bg-muted px-4 py-2 text-sm flex items-center justify-between gap-3'
      >
        <div className='flex flex-col'>
          <span className='font-medium'>{tr('discord_connect_expiredTitle')}</span>
          <span className='text-muted-foreground'>{tr('discord_connect_expiredBody')}</span>
        </div>
        <div className='flex items-center gap-1'>
          <Button size='sm' onClick={handleRegenerate} disabled={regenerating}>
            {regenerating && <Loader2 className='size-3 mr-1 animate-spin' aria-hidden='true' />}
            {tr('discord_connect_regenerateButton')}
          </Button>
          <Button
            variant='ghost'
            size='icon'
            onClick={() => setDismissed(true)}
            aria-label='Dismiss'
          >
            <X className='size-4' />
          </Button>
        </div>
      </div>
    );
  }

  if (effective.state === 'ready') {
    return (
      <div
        role='status'
        aria-live='polite'
        className='border-b bg-primary/10 px-4 py-2 text-sm flex items-center justify-between gap-3'
      >
        <span>{tr('invite_joinDiscordBannerDescription')}</span>
        <div className='flex items-center gap-1'>
          {Option.isSome(effective.discordInviteUrl) && (
            <a href={effective.discordInviteUrl.value} target='_blank' rel='noopener noreferrer'>
              <Button size='sm'>
                {tr('invite_joinDiscordButton')}
                <ExternalLink className='size-3 ml-1' />
              </Button>
            </a>
          )}
          <Button
            variant='ghost'
            size='icon'
            onClick={() => setDismissed(true)}
            aria-label='Dismiss'
          >
            <X className='size-4' />
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      role='status'
      aria-live='polite'
      className='border-b bg-muted px-4 py-2 text-sm flex items-center justify-between gap-3'
    >
      <span className='text-muted-foreground'>
        {tr('invite_preparingDiscordInviteDescription')}
      </span>
      <Button variant='ghost' size='icon' onClick={() => setDismissed(true)} aria-label='Dismiss'>
        <X className='size-4' />
      </Button>
    </div>
  );
}
