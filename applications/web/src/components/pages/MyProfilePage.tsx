import type { Auth } from '@sideline/domain';
import { useRouter } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import React from 'react';

import { LanguageSwitcher } from '~/components/organisms/LanguageSwitcher';
import { ProfileEditForm } from '~/components/organisms/ProfileEditForm';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '~/components/ui/card';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

function discordAvatarUrl(discordId: string, avatar: string): string {
  return `https://cdn.discordapp.com/avatars/${discordId}/${avatar}.png?size=128`;
}

type JoinStatusView = {
  readonly acceptanceId: string;
  readonly state: 'preparing' | 'ready' | 'expired' | 'failed';
  readonly discordInviteUrl: Option.Option<string>;
  readonly errorCode: Option.Option<string>;
};

/**
 * PR-5 step 10 — a persistent, non-dismissible "Join the team Discord" row per team. The
 * banner (`PendingDiscordJoinBanner`) is dismissible and 24h-capped; this is the durable
 * fallback surface (designer §2.4). Reads the SAME `getMyPendingDiscordJoin` endpoint, but does
 * not poll — this is a landing page a member returns to, not a live-updating strip. Renders
 * nothing for a team with no pending join (already in the guild, or no invite ever generated).
 *
 * PR-9 owns migrating or deleting this row (CC-11) once `DiscordConnectCard` ships.
 */
function DiscordJoinRow({ team }: { readonly team: Auth.UserTeam }) {
  const run = useRun();
  const [status, setStatus] = React.useState<JoinStatusView | null>(null);
  const [hasLoaded, setHasLoaded] = React.useState(false);
  const [regenerating, setRegenerating] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    void ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.invite.getMyPendingDiscordJoin({ params: { teamId: team.teamId } }),
      ),
      Effect.map(Option.getOrNull),
      Effect.tap((result) =>
        Effect.sync(() => {
          if (cancelled) return;
          setStatus(result);
          setHasLoaded(true);
        }),
      ),
      Effect.mapError(() => new SilentClientError({ message: '' })),
      run(),
    );
    return () => {
      cancelled = true;
    };
  }, [team.teamId, run]);

  const handleRegenerate = React.useCallback(() => {
    setRegenerating(true);
    void ApiClient.asEffect()
      .pipe(
        Effect.flatMap((api) =>
          api.invite.regenerateMyDiscordInvite({ params: { teamId: team.teamId } }),
        ),
        Effect.map(Option.getOrNull),
        Effect.tap((result) => Effect.sync(() => setStatus(result))),
        Effect.mapError(() => new SilentClientError({ message: '' })),
        run(),
      )
      .then(() => setRegenerating(false));
  }, [team.teamId, run]);

  if (!hasLoaded || status === null) return null;

  return (
    <div className='flex items-center justify-between gap-3 border-t pt-3 first:border-t-0 first:pt-0'>
      <div className='min-w-0 flex-1'>
        <p className='truncate text-sm font-medium'>{team.teamName}</p>
        <p className='text-xs text-muted-foreground'>
          {status.state === 'preparing' && tr('invite_preparingDiscordInviteDescription')}
          {status.state === 'failed' && tr('invite_discordInviteFailedDescription')}
          {status.state === 'expired' && tr('discord_connect_expiredBody')}
          {status.state === 'ready' && tr('invite_joinDiscordBannerDescription')}
        </p>
      </div>
      {status.state === 'ready' && Option.isSome(status.discordInviteUrl) && (
        <a href={status.discordInviteUrl.value} target='_blank' rel='noopener noreferrer'>
          <Button size='sm' variant='outline'>
            {tr('invite_joinDiscordButton')}
            <ExternalLink className='size-3 ml-1' />
          </Button>
        </a>
      )}
      {status.state === 'expired' && (
        <Button size='sm' variant='outline' onClick={handleRegenerate} disabled={regenerating}>
          {regenerating && <Loader2 className='size-3 mr-1 animate-spin' aria-hidden='true' />}
          {tr('discord_connect_regenerateButton')}
        </Button>
      )}
    </div>
  );
}

function DiscordJoinSection({ teams }: { readonly teams: ReadonlyArray<Auth.UserTeam> }) {
  if (teams.length === 0) return null;

  return (
    <Card className='w-full max-w-md mt-4'>
      <CardHeader>
        <CardTitle>{tr('profile_discordJoinTitle')}</CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        {teams.map((team) => (
          <DiscordJoinRow key={team.teamId} team={team} />
        ))}
      </CardContent>
    </Card>
  );
}

interface MyProfilePageProps {
  user: Auth.CurrentUser;
  teams: ReadonlyArray<Auth.UserTeam>;
  onUpdated: () => void;
}

export function MyProfilePage({ user, teams, onUpdated }: MyProfilePageProps) {
  const router = useRouter();

  const initials = user.displayName.slice(0, 2).toUpperCase();

  return (
    <div className='flex min-h-screen flex-col'>
      <header className='sticky top-0 z-10 flex items-center justify-between border-b bg-background px-6 py-4'>
        <Button
          variant='ghost'
          size='icon'
          aria-label={tr('guild_back')}
          onClick={() => router.history.back()}
        >
          <ArrowLeft className='size-5' />
        </Button>
        <span className='text-lg font-bold'>{tr('app_name')}</span>
        <div className='flex items-center gap-3'>
          <LanguageSwitcher isAuthenticated />
        </div>
      </header>

      <main className='flex flex-1 flex-col items-center px-6 pt-16 pb-24'>
        <Card className='w-full max-w-md'>
          <CardHeader className='text-center'>
            <div className='flex justify-center mb-2'>
              <Avatar className='size-12'>
                {Option.isSome(user.avatar) && (
                  <AvatarImage
                    src={discordAvatarUrl(user.discordId, user.avatar.value)}
                    alt={tr('profile_discordAvatar')}
                  />
                )}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
            </div>
            <CardTitle>{tr('profile_title')}</CardTitle>
            <CardDescription>@{user.username}</CardDescription>
          </CardHeader>
          <CardContent>
            <ProfileEditForm user={user} onSuccess={onUpdated} />
          </CardContent>
        </Card>
        <DiscordJoinSection teams={teams} />
      </main>
    </div>
  );
}
