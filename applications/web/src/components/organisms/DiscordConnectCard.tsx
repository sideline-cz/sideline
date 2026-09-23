import type { Auth } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { AlertTriangle } from 'lucide-react';
import { DiscordConnectionBadge } from '~/components/molecules/DiscordConnectionBadge.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { tr } from '~/lib/translations.js';

interface DiscordConnectCardProps {
  readonly team: Auth.UserTeam;
}

/**
 * The designer's §2.2/§5.2 card: amber + non-dismissible when `not_connected`, neutral when
 * `connected`. `'unknown'` renders NOTHING (CC-15/§3.6) — this is the
 * one component that reads `Auth.UserTeam.discordJoined`, so `MyProfilePage`'s per-team row and
 * `TeamDetailPage`'s dashboard slot can never disagree (CC-11).
 *
 * Deliberately has no dismiss control anywhere in this file — the reporter's original complaint
 * was precisely that the old banner could be dismissed and forgotten (designer §3.3).
 */
export function DiscordConnectCard({ team }: DiscordConnectCardProps) {
  if (team.discordJoined === 'unknown') return null;

  if (team.discordJoined === 'not_connected') {
    return (
      <Card className='border-amber-200 bg-amber-50/50 py-4 gap-3 dark:border-amber-800 dark:bg-amber-950/20'>
        <CardContent className='flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between'>
          <div className='flex items-center gap-3'>
            <div className='flex size-6 shrink-0 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/50'>
              <AlertTriangle
                className='size-3.5 text-amber-700 dark:text-amber-300'
                aria-hidden='true'
              />
            </div>
            <div>
              <p className='text-sm font-semibold'>{tr('discord_connect_bannerTitle')}</p>
              <p className='text-xs text-muted-foreground'>{tr('discord_connect_bannerBody')}</p>
            </div>
          </div>
          <Button asChild size='sm'>
            <Link to='/teams/$teamId/connect-discord' params={{ teamId: team.teamId }}>
              {tr('discord_connect_bannerCta')}
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className='py-4 gap-3'>
      <CardContent className='flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div className='flex items-center gap-3'>
          <p className='text-sm font-semibold'>Discord</p>
          <DiscordConnectionBadge state={team.discordJoined} />
        </div>
      </CardContent>
    </Card>
  );
}
