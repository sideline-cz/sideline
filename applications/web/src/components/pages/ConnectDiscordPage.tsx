import type { Team } from '@sideline/domain';
import { useNavigate } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { Check, CheckCircle, Copy, ExternalLink, Loader2 } from 'lucide-react';
import React from 'react';
import { DiscordIcon } from '~/components/atoms/DiscordIcon.js';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { Skeleton } from '~/components/ui/skeleton';
import { discordConnectSkipCount, snoozeDiscordConnect } from '~/lib/auth/discordConnectSnooze.js';
import { copyToClipboard } from '~/lib/clipboard';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

const POLL_INTERVAL_MS = 2000;
const NUDGE_SKIP_THRESHOLD = 3;
const SUCCESS_AUTO_NAVIGATE_MS = 1500;

type ConnectStatusView = {
  readonly state: 'preparing' | 'ready' | 'expired' | 'failed' | 'joined';
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<string>;
};

const errorCopyKey = (errorCode: Option.Option<string>): string =>
  Option.match(errorCode, {
    onNone: () => 'discord_connect_error_generic',
    onSome: (code) =>
      code === 'welcome_channel_missing' || code === 'welcome_channel_deleted'
        ? 'discord_connect_error_captainAction'
        : code === 'bot_missing_perms' || code === 'bot_not_in_guild'
          ? 'discord_connect_error_botPerms'
          : code === 'rate_limited'
            ? 'discord_connect_error_rateLimited'
            : 'discord_connect_error_generic',
  });

interface ConnectDiscordPageProps {
  readonly teamId: Team.TeamId;
  readonly teamName: string;
  readonly userId: string;
  readonly next?: string;
}

/**
 * The designer's §2.1 interstitial. Renders inside the sidebar shell (CC-12) — the caller (the
 * `connect-discord.tsx` route, nested under `teams/$teamId/route.tsx`) already provides
 * `AuthenticatedLayout`'s header/breadcrumbs/sidebar; this component is the card content only.
 */
export function ConnectDiscordPage({ teamId, teamName, userId, next }: ConnectDiscordPageProps) {
  const run = useRun();
  const navigate = useNavigate();
  const headingRef = React.useRef<HTMLHeadingElement>(null);
  const [status, setStatus] = React.useState<ConnectStatusView | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);
  // Blocker 3 (whole-series review, fix/discord-onboarding-webapp): `regenerateMyDiscordInvite`
  // returns `None` for two structurally different reasons that both collapse onto
  // `status === null` — the initial "no acceptance row yet" state, and (per the server's own
  // doc comment on the `activeInvite` step) "the team has no active invite link at all". The
  // second one is not retryable by a member — clicking "Get a new invite" again returns `None`
  // again, forever, with no visible change. Track that the LAST regenerate click specifically
  // hit that case so the render below can swap to the "ask your captain" copy instead of the
  // misleading, endlessly-repeatable CTA. Only `handleRegenerate` updates this — the polling
  // `fetchStatus` says nothing about invite-link existence, so it must not clear it.
  const [inviteMissing, setInviteMissing] = React.useState(false);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const successTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const returnTo = next ?? `/teams/${teamId}`;

  // Focus the heading on mount (designer §8 / AGENTS.md a11y): a screen-reader user landing
  // here after a redirect hears the page's purpose rather than being dropped at document start.
  React.useEffect(() => {
    headingRef.current?.focus();
  }, []);

  React.useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
      if (successTimerRef.current !== null) clearTimeout(successTimerRef.current);
    },
    [],
  );

  const fetchStatus = React.useCallback(() => {
    void ApiClient.asEffect()
      .pipe(
        Effect.flatMap((api) => api.invite.getMyPendingDiscordJoin({ params: { teamId } })),
        Effect.map(Option.getOrNull),
        Effect.tap((result) =>
          Effect.sync(() => {
            setHasLoaded(true);
            setStatus(result);
          }),
        ),
        Effect.mapError(() => new SilentClientError({ message: '' })),
        run(),
      )
      .then(() => undefined);
  }, [teamId, run]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: fetchStatus is stable per teamId; re-created identity must not restart the interval
  React.useEffect(() => {
    let cancelled = false;
    fetchStatus();
    const intervalId = window.setInterval(() => {
      if (!cancelled) fetchStatus();
    }, POLL_INTERVAL_MS);
    const onFocus = () => {
      if (!cancelled) fetchStatus();
    };
    window.addEventListener('focus', onFocus);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener('focus', onFocus);
    };
  }, [teamId]);

  // Auto-navigate 1.5s after success — long enough not to yank focus mid-announcement; the
  // explicit "Continue" button means a keyboard user is never dependent on the timer.
  React.useEffect(() => {
    if (status?.state !== 'joined') return;
    successTimerRef.current = setTimeout(() => {
      navigate({ to: returnTo });
    }, SUCCESS_AUTO_NAVIGATE_MS);
    return () => {
      if (successTimerRef.current !== null) clearTimeout(successTimerRef.current);
    };
  }, [status?.state, navigate, returnTo]);

  const handleCopy = React.useCallback((url: string) => {
    void copyToClipboard(url).then((ok) => {
      if (!ok) return;
      setCopied(true);
      copyTimerRef.current = setTimeout(() => setCopied(false), 2000);
    });
  }, []);

  const handleRegenerate = React.useCallback(() => {
    setRegenerating(true);
    void ApiClient.asEffect()
      .pipe(
        Effect.flatMap((api) => api.invite.regenerateMyDiscordInvite({ params: { teamId } })),
        Effect.map(Option.getOrNull),
        Effect.tap((result) =>
          Effect.sync(() => {
            setHasLoaded(true);
            setStatus(result);
            setInviteMissing(result === null);
          }),
        ),
        Effect.mapError(() => new SilentClientError({ message: '' })),
        run(),
      )
      .then(() => setRegenerating(false));
  }, [teamId, run]);

  const handleSkip = React.useCallback(() => {
    snoozeDiscordConnect(userId, teamId);
    navigate({ to: returnTo });
  }, [userId, teamId, navigate, returnTo]);

  const handleContinue = React.useCallback(() => {
    navigate({ to: returnTo });
  }, [navigate, returnTo]);

  const skipCount = discordConnectSkipCount(userId, teamId);
  const readyInviteUrl =
    status?.state === 'ready' ? Option.getOrNull(status.discordInviteUrl) : null;

  return (
    <div className='flex flex-1 flex-col items-center px-6 py-10'>
      <Card className='w-full max-w-md'>
        <CardHeader className='text-center'>
          <div className='mb-2 flex justify-center'>
            <div className='flex size-12 items-center justify-center rounded-full bg-primary/10'>
              <DiscordIcon className='size-6 text-primary' />
            </div>
          </div>
          <CardTitle>
            <h2 ref={headingRef} tabIndex={-1} className='outline-none'>
              {tr('discord_connect_title', { teamName })}
            </h2>
          </CardTitle>
          <CardDescription>{tr('discord_connect_description')}</CardDescription>
        </CardHeader>
        <CardContent className='flex flex-col gap-4'>
          {skipCount >= NUDGE_SKIP_THRESHOLD && status?.state !== 'joined' && (
            <Alert variant='warning'>
              <AlertTitle>{tr('discord_connect_nudgeRepeat')}</AlertTitle>
            </Alert>
          )}

          <div role='status' aria-live='polite' className='flex flex-col gap-4'>
            {!hasLoaded && (
              <>
                <Skeleton className='h-10 w-full' />
                <Skeleton className='h-4 w-40' />
              </>
            )}

            {hasLoaded && status === null && inviteMissing && (
              // Blocker 3: the team has no active invite link at all (the server's own doc
              // comment on `regenerateMyDiscordInvite`'s `activeInvite` step). Nothing a member
              // can do fixes this — no CTA, matching the designer's §4.2(b) "ask your captain"
              // copy (`.work-plans/discord-connect-enforcement-design.md`).
              <Alert variant='default'>
                <AlertTitle>{tr('discord_connect_noGuildTitle')}</AlertTitle>
                <AlertDescription>{tr('discord_connect_noGuildBody')}</AlertDescription>
              </Alert>
            )}

            {hasLoaded && status === null && !inviteMissing && (
              <>
                <Alert variant='default'>
                  <AlertTitle>{tr('discord_connect_noLinkTitle')}</AlertTitle>
                  <AlertDescription>{tr('discord_connect_noLinkBody')}</AlertDescription>
                </Alert>
                <Button onClick={handleRegenerate} disabled={regenerating}>
                  {regenerating && <Loader2 className='size-4 animate-spin' aria-hidden='true' />}
                  {tr('discord_connect_regenerateButton')}
                </Button>
              </>
            )}

            {hasLoaded && status?.state === 'preparing' && (
              <div className='flex flex-col gap-1'>
                <Button disabled className='w-full'>
                  <Loader2 className='size-4 animate-spin' aria-hidden='true' />
                  {tr('invite_preparingDiscordInviteTitle')}
                </Button>
                <p className='text-xs text-muted-foreground'>
                  {tr('invite_preparingDiscordInviteDescription')}
                </p>
              </div>
            )}

            {hasLoaded && status?.state === 'ready' && readyInviteUrl !== null && (
              <>
                <Button asChild className='w-full'>
                  <a href={readyInviteUrl} target='_blank' rel='noopener noreferrer'>
                    {tr('discord_connect_openServer')}
                    <ExternalLink className='size-4' aria-hidden='true' />
                  </a>
                </Button>
                <div className='flex items-center justify-between gap-2 rounded-md border px-3 py-2'>
                  <span className='select-all text-sm'>{readyInviteUrl}</span>
                  <Button
                    type='button'
                    variant='ghost'
                    size='icon'
                    aria-label={tr('discord_copyLinkAria')}
                    onClick={() => handleCopy(readyInviteUrl)}
                  >
                    {copied ? (
                      <Check className='size-4' aria-hidden='true' />
                    ) : (
                      <Copy className='size-4' aria-hidden='true' />
                    )}
                  </Button>
                </div>
                <p className='text-xs text-muted-foreground'>{tr('discord_connect_autoDetect')}</p>
              </>
            )}

            {hasLoaded && status?.state === 'expired' && (
              <>
                <Alert variant='default'>
                  <AlertTitle>{tr('discord_connect_expiredTitle')}</AlertTitle>
                  <AlertDescription>{tr('discord_connect_expiredBody')}</AlertDescription>
                </Alert>
                <Button onClick={handleRegenerate} disabled={regenerating}>
                  {regenerating && <Loader2 className='size-4 animate-spin' aria-hidden='true' />}
                  {tr('discord_connect_regenerateButton')}
                </Button>
              </>
            )}

            {hasLoaded && status?.state === 'failed' && (
              <Alert variant={Option.isSome(status.errorCode) ? 'warning' : 'destructive'}>
                <AlertTitle>{tr(errorCopyKey(status.errorCode))}</AlertTitle>
                {Option.isNone(status.errorCode) && (
                  <AlertDescription>
                    <Button variant='outline' size='sm' onClick={handleRegenerate}>
                      {tr('discord_connect_retry')}
                    </Button>
                  </AlertDescription>
                )}
              </Alert>
            )}

            {hasLoaded && status?.state === 'joined' && (
              <div className='flex flex-col items-center gap-3 text-center'>
                <CheckCircle className='size-8 text-success' aria-hidden='true' />
                <p className='text-sm font-semibold'>{tr('discord_connect_successTitle')}</p>
                <p className='text-sm text-muted-foreground'>
                  {tr('discord_connect_successBody', { teamName })}
                </p>
                <Button onClick={handleContinue}>{tr('discord_connect_continue')}</Button>
              </div>
            )}
          </div>

          {status?.state !== 'joined' && (
            <Button type='button' variant='ghost' onClick={handleSkip}>
              {tr('discord_connect_skip')}
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
