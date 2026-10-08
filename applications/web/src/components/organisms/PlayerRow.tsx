import type { Roster } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { AlertTriangle } from 'lucide-react';
import { EffectiveRolesList } from '~/components/molecules/EffectiveRolesList.js';
import { Avatar, AvatarFallback, AvatarImage } from '~/components/ui/avatar';
import { Button } from '~/components/ui/button';
import { resolveEffectiveRoles } from '~/lib/roles/resolveEffectiveRoles.js';
import { tr } from '~/lib/translations.js';

interface PlayerRowProps {
  player: Roster.RosterPlayer;
  teamId: string;
  canEdit: boolean;
  canRemove: boolean;
  onDeactivate: (memberId: string) => void;
}

/**
 * Direct group membership, comma-joined and truncated. Deliberately plainer than the role
 * badges: groups are context for the roles above them, and badging both doubles the row height
 * on a phone. `player.groupNames` is the member's OWN groups — not
 * `effectiveRoles[].groupNames`, which only names the groups that grant a given role and so
 * silently omits any group holding no roles.
 */
function GroupNames({ names, className }: { names: ReadonlyArray<string>; className?: string }) {
  if (names.length === 0) return null;
  const joined = names.join(', ');
  return (
    <p className={className} title={joined}>
      {joined}
    </p>
  );
}

/** Missing VS is not neutral — icon + word, never colour alone (design §5.2). */
function VariableSymbolMarker() {
  return (
    <span className='inline-flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300'>
      <AlertTriangle className='size-3' aria-hidden='true' />
      {tr('members_vs_missing')}
    </span>
  );
}

export function PlayerRow({ player, teamId, canEdit, canRemove, onDeactivate }: PlayerRowProps) {
  const displayName = player.displayName;
  // A member in several groups can now reach 6+ effective role names — render through
  // `EffectiveRolesList` (with a fixed, layout-appropriate limit) instead of an unbounded
  // `join(', ')`, which grew the row without bound. Ordering is the same `sortEffectiveRoles`
  // used by the member detail header, so the badge shown at a low limit is the member's
  // highest built-in role rather than an alphabetical accident.
  const effectiveRoles = resolveEffectiveRoles(player);
  const jerseyNumber = player.jerseyNumber.pipe(
    Option.map((v) => `#${v}`),
    Option.getOrElse(() => '—'),
  );
  const hasVs = Option.isSome(player.variableSymbol);

  return (
    <tr className={player.active ? 'border-b' : 'border-b opacity-60'}>
      <td className='py-2 px-4'>
        <div className='flex items-center gap-2'>
          <Avatar className='size-8'>
            {Option.isSome(player.avatar) && (
              <AvatarImage
                src={`https://cdn.discordapp.com/avatars/${player.discordId}/${player.avatar.value}.png?size=32`}
                alt={displayName}
              />
            )}
            <AvatarFallback>{displayName.slice(0, 2).toUpperCase()}</AvatarFallback>
          </Avatar>
          <div className='min-w-0'>
            <p className='font-medium truncate'>
              {displayName}
              {!player.active && (
                <span className='ml-2 text-xs font-normal text-muted-foreground'>
                  {tr('members_inactiveBadge')}
                </span>
              )}
            </p>
            {/* Role + VS shown inline on mobile since the desktop columns are hidden */}
            <div className='sm:hidden flex items-center gap-2'>
              {!hasVs && <VariableSymbolMarker />}
              {effectiveRoles.length === 0 && (
                <p className='text-xs text-muted-foreground'>{tr('members_fieldEmpty')}</p>
              )}
            </div>
            <div className='md:hidden'>
              {effectiveRoles.length > 0 ? (
                <EffectiveRolesList roles={effectiveRoles} limit={1} className='text-xs' />
              ) : null}
              <GroupNames
                names={player.groupNames}
                className='truncate text-xs text-muted-foreground'
              />
            </div>
          </div>
        </div>
      </td>
      <td className='hidden sm:table-cell py-2 px-4 tabular-nums'>
        {hasVs ? player.variableSymbol.value : <VariableSymbolMarker />}
      </td>
      <td className='hidden md:table-cell py-2 px-4'>{jerseyNumber}</td>
      <td className='hidden md:table-cell max-w-[16rem] py-2 px-4'>
        {effectiveRoles.length > 0 ? (
          <EffectiveRolesList roles={effectiveRoles} limit={2} />
        ) : (
          tr('members_fieldEmpty')
        )}
      </td>
      <td className='hidden md:table-cell max-w-[14rem] py-2 px-4 text-sm text-muted-foreground'>
        {player.groupNames.length > 0 ? (
          <GroupNames names={player.groupNames} className='truncate' />
        ) : (
          tr('members_fieldEmpty')
        )}
      </td>
      {canEdit || canRemove ? (
        <td className='py-2 px-4'>
          <div className='flex gap-2 flex-wrap'>
            {canEdit ? (
              <Button asChild variant='outline' size='sm'>
                <Link
                  to='/teams/$teamId/members/$memberId'
                  params={{ teamId, memberId: player.memberId }}
                >
                  {tr('members_editPlayer')}
                </Link>
              </Button>
            ) : null}
            {canRemove ? (
              <Button variant='destructive' size='sm' onClick={() => onDeactivate(player.memberId)}>
                {tr('members_deactivatePlayer')}
              </Button>
            ) : null}
          </div>
        </td>
      ) : (
        <td className='py-2 px-4' />
      )}
    </tr>
  );
}
