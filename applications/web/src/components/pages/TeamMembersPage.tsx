import type { Roster } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import { AssignVariableSymbolsDialog } from '~/components/organisms/AssignVariableSymbolsDialog';
import { PlayerRow } from '~/components/organisms/PlayerRow';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Input } from '~/components/ui/input';
import { tr } from '~/lib/translations.js';

interface TeamMembersPageProps {
  teamId: string;
  canEdit: boolean;
  canRemove: boolean;
  players: ReadonlyArray<Roster.RosterPlayer>;
  onDeactivate: (memberId: string) => void;
  onMembersAssigned?: (updated: ReadonlyArray<Roster.RosterPlayer>) => void;
}

export function TeamMembersPage({
  teamId,
  canEdit,
  canRemove,
  players,
  onDeactivate,
  onMembersAssigned,
}: TeamMembersPageProps) {
  const [search, setSearch] = React.useState('');
  const [onlyMissingVs, setOnlyMissingVs] = React.useState(false);
  const [assignOpen, setAssignOpen] = React.useState(false);

  const missingVsCount = players.filter((p) => Option.isNone(p.variableSymbol)).length;

  const filtered = players.filter((p) => {
    const name = p.displayName.toLowerCase();
    if (!name.includes(search.toLowerCase())) return false;
    if (onlyMissingVs && Option.isSome(p.variableSymbol)) return false;
    return true;
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

      {canEdit && missingVsCount > 0 && (
        <Alert variant='warning' className='mb-4'>
          <AlertTriangle aria-hidden='true' />
          <AlertTitle>{tr('members_vs_bannerTitle', { count: missingVsCount })}</AlertTitle>
          <AlertDescription className='flex flex-col gap-2'>
            <p>{tr('members_vs_bannerBody')}</p>
            <div className='flex flex-wrap gap-2'>
              <Button
                type='button'
                variant='outline'
                size='sm'
                aria-pressed={onlyMissingVs}
                onClick={() => setOnlyMissingVs((v) => !v)}
              >
                {tr('members_vs_bannerShowOnly')}
              </Button>
              <Button type='button' variant='outline' size='sm' onClick={() => setAssignOpen(true)}>
                {tr('members_vs_bannerAssign')}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      <div className='flex flex-wrap gap-3 mb-4 items-center'>
        <Input
          placeholder={tr('members_searchPlaceholder')}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className='w-full sm:max-w-xs'
        />
        {missingVsCount > 0 && (
          <button
            type='button'
            aria-pressed={onlyMissingVs}
            onClick={() => setOnlyMissingVs((v) => !v)}
            className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
              onlyMissingVs
                ? 'bg-primary text-primary-foreground border-primary'
                : 'bg-background text-muted-foreground hover:bg-muted'
            }`}
          >
            {tr('members_vs_filterMissing')}
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className='text-muted-foreground'>{tr('members_noPlayers')}</p>
      ) : (
        <div className='overflow-x-auto'>
          <table className='w-full'>
            <thead>
              <tr className='border-b'>
                <th className='py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                  {tr('members_player')}
                </th>
                <th className='hidden sm:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                  {tr('members_vs_column')}
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
        </div>
      )}

      <AssignVariableSymbolsDialog
        open={assignOpen}
        teamId={teamId}
        onOpenChange={setAssignOpen}
        onAssigned={(updated) => onMembersAssigned?.(updated)}
      />
    </div>
  );
}
