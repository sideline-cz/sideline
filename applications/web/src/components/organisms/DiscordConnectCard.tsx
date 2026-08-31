import type { Auth, TeamMember } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Effect, Option } from 'effect';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { DiscordConnectionBadge } from '~/components/molecules/DiscordConnectionBadge.js';
import { SyncRolesButton } from '~/components/molecules/SyncRolesButton.js';
import { Button } from '~/components/ui/button';
import { Card, CardContent } from '~/components/ui/card';
import { ApiClient, SilentClientError, useRun } from '~/lib/runtime';
import { tr } from '~/lib/translations.js';

interface DiscordConnectCardProps {
  readonly team: Auth.UserTeam;
  /** The calling user's own `team_members.id` for `team`, when known — required to wire the
   * "Sync roles" affordance (`role.syncMemberDiscordRoles`). Omitted on surfaces that have no
   * cheap way to resolve it (e.g. `MyProfilePage`, which lists every team the user belongs to
   * without loading each one's dashboard) — the card degrades gracefully by omitting the
   * button rather than fetching it separately. */
  readonly myMemberId?: TeamMember.TeamMemberId;
}

/**
 * The designer's §2.2/§5.2 card: amber + non-dismissible when `not_connected`, neutral with the
 * role-sync affordance when `connected`. `'unknown'` renders NOTHING (CC-15/§3.6) — this is the
 * one component that reads `Auth.UserTeam.discordJoined`, so `MyProfilePage`'s per-team row and
 * `TeamDetailPage`'s dashboard slot can never disagree (CC-11).
 *
 * Deliberately has no dismiss control anywhere in this file — the reporter's original complaint
 * was precisely that the old banner could be dismissed and forgotten (designer §3.3).
 */
export function DiscordConnectCard({ team, myMemberId }: DiscordConnectCardProps) {
  const run = useRun();

  const handleSync = React.useCallback(async () => {
    if (myMemberId === undefined) {
      throw new Error('DiscordConnectCard: handleSync called without myMemberId');
    }
    const result = await ApiClient.asEffect().pipe(
      Effect.flatMap((api) =>
        api.role.syncMemberDiscordRoles({ params: { teamId: team.teamId, memberId: myMemberId } }),
      ),
      Effect.mapError(() => new SilentClientError({ message: '' })),
      run(),
    );
    return Option.match(result, {
      onNone: () => {
        throw new Error('Discord role sync failed');
      },
      onSome: (value) => value,
    });
  }, [team.teamId, myMemberId, run]);

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
        {myMemberId !== undefined && <SyncRolesButton onSync={handleSync} />}
      </CardContent>
    </Card>
  );
}
