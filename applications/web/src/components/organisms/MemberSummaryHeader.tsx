import type { Roster } from '@sideline/domain';
import { Option } from 'effect';
import { Calendar } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { tr } from '~/lib/translations.js';

interface MemberSummaryHeaderProps {
  player: Roster.RosterPlayer;
  canManageRoles: boolean;
}

export function MemberSummaryHeader({ player, canManageRoles }: MemberSummaryHeaderProps) {
  const { formatMonthYear } = useFormatDate();
  const displayName = player.displayName;
  const initials = displayName.slice(0, 2).toUpperCase();
  const [primaryRole, ...extraRoles] = player.roleNames;
  const joinedDate = formatMonthYear(new Date(player.joinedAt));

  return (
    <div className='flex flex-col gap-4 sm:flex-row sm:items-start sm:gap-6'>
      <Avatar className='size-16 sm:size-20'>
        {Option.isSome(player.avatar) && (
          <AvatarImage
            src={`https://cdn.discordapp.com/avatars/${player.discordId}/${player.avatar.value}.png?size=128`}
            alt={displayName}
          />
        )}
        <AvatarFallback className='text-lg'>{initials}</AvatarFallback>
      </Avatar>
      <div className='flex flex-1 flex-col gap-2 min-w-0'>
        <div className='flex flex-wrap items-baseline gap-2'>
          <h1 className='text-2xl font-bold truncate'>{displayName}</h1>
          <span className='text-muted-foreground'>@{player.username}</span>
          {Option.isSome(player.jerseyNumber) ? (
            <span className='text-muted-foreground'>#{player.jerseyNumber.value}</span>
          ) : null}
        </div>
        <div className='flex items-center gap-1.5 text-sm text-muted-foreground'>
          <Calendar className='size-4' aria-hidden='true' />
          <span>{tr('members_joinedLabel', { date: joinedDate })}</span>
        </div>
        {primaryRole !== undefined ? (
          <div className='flex flex-wrap items-center gap-2'>
            <Badge>{primaryRole}</Badge>
            {extraRoles.length > 0 ? <Badge variant='outline'>+{extraRoles.length}</Badge> : null}
          </div>
        ) : null}
        {canManageRoles ? (
          <div className='flex flex-col gap-1 text-sm text-muted-foreground'>
            <p className='font-medium text-foreground'>{tr('members_permissionsTitle')}</p>
            <p>{player.discordId}</p>
            <div className='flex flex-wrap gap-1'>
              {player.permissions.map((permission) => (
                <Badge key={permission} variant='secondary'>
                  {permission}
                </Badge>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
