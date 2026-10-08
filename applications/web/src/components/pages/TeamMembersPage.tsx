import type { Roster } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { AlertTriangle } from 'lucide-react';
import React from 'react';
import {
  ListToolbar,
  listHeaderClass,
  listScrollClass,
} from '~/components/molecules/ListToolbar.js';
import { AssignVariableSymbolsDialog } from '~/components/organisms/AssignVariableSymbolsDialog';
import { PlayerRow } from '~/components/organisms/PlayerRow';
import { Alert, AlertDescription, AlertTitle } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { tr } from '~/lib/translations.js';
import { useListFilter } from '~/lib/useListFilter.js';

// "Active" here is `RosterPlayer.active` — still on the team. `listMembers` is the only caller
// that asks the server for departed members at all, so this is the one place they surface.
const MEMBER_FILTERS = [
  {
    value: 'active',
    labelKey: 'list_filter_active',
    predicate: (p: Roster.RosterPlayer) => p.active,
  },
  { value: 'all', labelKey: 'list_filter_all', predicate: () => true },
] as const;

const MEMBER_SORTS = [
  {
    value: 'name',
    labelKey: 'list_sort_name',
    compare: (a: Roster.RosterPlayer, b: Roster.RosterPlayer) =>
      a.displayName.localeCompare(b.displayName),
  },
  {
    value: 'jersey',
    labelKey: 'list_sort_jersey',
    // Members with no jersey number sort last rather than colliding at 0.
    compare: (a: Roster.RosterPlayer, b: Roster.RosterPlayer) =>
      Option.getOrElse(a.jerseyNumber, () => Number.POSITIVE_INFINITY) -
      Option.getOrElse(b.jerseyNumber, () => Number.POSITIVE_INFINITY),
  },
  {
    value: 'joined',
    labelKey: 'list_sort_joined',
    // `joined_at` is an ISO-8601 UTC string from the server, so lexical order is chronological.
    compare: (a: Roster.RosterPlayer, b: Roster.RosterPlayer) =>
      b.joinedAt.localeCompare(a.joinedAt),
  },
] as const;

const memberSearchFields = (p: Roster.RosterPlayer) => [
  p.displayName,
  p.username,
  ...p.groupNames,
  ...p.roleNames,
];

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
  const [onlyMissingVs, setOnlyMissingVs] = React.useState(false);
  const [assignOpen, setAssignOpen] = React.useState(false);

  // Counted over ACTIVE members only: a departed member keeps their variable symbol on purpose
  // (it stays reserved), so counting them would nag about rows nobody can act on.
  const missingVsCount = players.filter((p) => p.active && Option.isNone(p.variableSymbol)).length;

  const memberList = useListFilter(players, {
    searchOf: memberSearchFields,
    filters: MEMBER_FILTERS,
    sorts: MEMBER_SORTS,
  });

  // The missing-VS toggle stacks ON TOP of the active/all chips rather than being a fourth chip:
  // it answers a different question, and the VS banner's "show only these" button drives it too.
  const filtered = onlyMissingVs
    ? memberList.filtered.filter((p) => Option.isNone(p.variableSymbol))
    : memberList.filtered;

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

      <ListToolbar
        className='mb-4'
        search={memberList.search}
        onSearchChange={memberList.setSearch}
        searchPlaceholderKey='members_searchPlaceholder'
        filters={MEMBER_FILTERS}
        filter={memberList.filter}
        onFilterChange={memberList.setFilter}
        sorts={MEMBER_SORTS}
        sort={memberList.sort}
        onSortChange={memberList.setSort}
      >
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
      </ListToolbar>

      {filtered.length === 0 ? (
        <p className='text-muted-foreground'>
          {players.length === 0 ? tr('members_noPlayers') : tr('list_noMatches')}
        </p>
      ) : (
        <div className={listScrollClass}>
          <table className='w-full'>
            <thead className={listHeaderClass}>
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
                <th className='hidden md:table-cell py-2 px-4 text-left text-sm font-medium text-muted-foreground'>
                  {tr('members_groupsColumn')}
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
