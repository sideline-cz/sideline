import type { Roster } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import React from 'react';
import { PlayerRow } from '~/components/organisms/PlayerRow';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { tr } from '~/lib/translations.js';

interface TeamMembersPageProps {
  teamId: string;
  canEdit: boolean;
  canRemove: boolean;
  players: ReadonlyArray<Roster.RosterPlayer>;
  onDeactivate: (memberId: string) => void;
}

export function TeamMembersPage({
  teamId,
  canEdit,
  canRemove,
  players,
  onDeactivate,
}: TeamMembersPageProps) {
  const [search, setSearch] = React.useState('');

  const filtered = players.filter((p) => {
    const name = Option.getOrElse(p.name, () => p.username).toLowerCase();
    return name.includes(search.toLowerCase());
  });

  return (
    <div>
      <header className='mb-8'>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId' params={{ teamId }}>
            ← {tr('team_backToTeams')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('members_title')}</h1>
      </header>
      <div className='flex gap-4 mb-4'>
        <Input
          placeholder={tr('members_searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='w-full sm:max-w-xs'
        />
      </div>
      {filtered.length === 0 ? (
        <p className='text-muted-foreground'>{tr('members_noPlayers')}</p>
      ) : (
        <table className='w-full'>
          <thead>
            <tr className='border-b'>
              <th className='py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                {tr('members_player')}
              </th>
              <th className='hidden md:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                {tr('members_jerseyNumber')}
              </th>
              <th className='hidden md:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                {tr('members_role')}
              </th>
              <th className='py-2 px-4' />
            </tr>
          </thead>
          <tbody>
            {filtered.map((player) => (
              <PlayerRow
                key={player.memberId}
                player={player}
                teamId={teamId}
                canEdit={canEdit}
                canRemove={canRemove}
                onDeactivate={onDeactivate}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
