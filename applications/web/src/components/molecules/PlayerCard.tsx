import type { TeamGenerationApi } from '@sideline/domain';
import { Option } from 'effect';
import { CircleDashed, Mars, Venus } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Badge } from '~/components/ui/badge';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface PlayerCardProps {
  player: TeamGenerationApi.GeneratedTeamMember;
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (player: TeamGenerationApi.GeneratedTeamMember) => void;
  teamColor?: string;
}

export function PlayerCard({ player, selectable, selected, onSelect, teamColor }: PlayerCardProps) {
  const avatarSrc =
    Option.isSome(player.discordId) && Option.isSome(player.avatar)
      ? `https://cdn.discordapp.com/avatars/${player.discordId.value}/${player.avatar.value}.png?size=32`
      : undefined;

  const fallback = player.displayName.slice(0, 2).toUpperCase();

  const roleLabel = Option.getOrNull(player.role);
  const jerseyLabel = Option.isSome(player.jerseyNumber)
    ? `#${player.jerseyNumber.value}`
    : undefined;

  const secondaryLine = [jerseyLabel, roleLabel].filter(Boolean).join(' · ') || undefined;

  const genderIcon = Option.match(player.gender, {
    onNone: () => null,
    onSome: (g) => {
      if (g === 'male') {
        return (
          <Mars
            className='size-3.5 text-blue-500 shrink-0'
            aria-label={tr('gender_male')}
            role='img'
          />
        );
      }
      if (g === 'female') {
        return (
          <Venus
            className='size-3.5 text-pink-500 shrink-0'
            aria-label={tr('gender_female')}
            role='img'
          />
        );
      }
      return (
        <CircleDashed
          className='size-3.5 text-muted-foreground shrink-0'
          aria-label={tr('gender_other')}
          role='img'
        />
      );
    },
  });

  const ratingDisplay = player.isCalibrating ? (
    <span className='tabular-nums text-xs text-muted-foreground'>
      {tr('teamGen_calibrating')}
      {player.rating}
    </span>
  ) : (
    <span className='tabular-nums text-xs text-muted-foreground'>{player.rating}</span>
  );

  const content = (
    <div className='flex items-center gap-2 w-full min-w-0'>
      {teamColor && (
        <span
          className='w-1 self-stretch rounded-full shrink-0'
          style={{ backgroundColor: teamColor }}
          aria-hidden='true'
        />
      )}
      <Avatar className='size-8 shrink-0'>
        {avatarSrc && <AvatarImage src={avatarSrc} alt={player.displayName} />}
        <AvatarFallback className='text-xs'>{fallback}</AvatarFallback>
      </Avatar>
      <div className='flex flex-col min-w-0 flex-1'>
        <span className='text-sm font-medium truncate leading-tight'>{player.displayName}</span>
        {secondaryLine && (
          <span className='text-xs text-muted-foreground truncate leading-tight'>
            {secondaryLine}
          </span>
        )}
      </div>
      <div className='flex items-center gap-1.5 shrink-0'>
        {genderIcon}
        {ratingDisplay}
        {player.isCalibrating && (
          <Badge variant='secondary' className='text-xs px-1 py-0'>
            ~
          </Badge>
        )}
      </div>
    </div>
  );

  if (selectable) {
    return (
      <button
        type='button'
        onClick={() => onSelect?.(player)}
        aria-pressed={selected}
        aria-label={
          selected
            ? tr('teamGen_playerCardSelectedLabel', { name: player.displayName })
            : tr('teamGen_playerCardSelectLabel', { name: player.displayName })
        }
        className={cn(
          'flex items-center h-12 w-full rounded-md border px-2 text-left transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1',
          selected
            ? 'border-primary bg-primary/10 ring-2 ring-primary ring-offset-1'
            : 'hover:bg-accent hover:border-accent-foreground/20',
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <div className={cn('flex items-center h-12 w-full rounded-md border px-2', 'bg-card')}>
      {content}
    </div>
  );
}
