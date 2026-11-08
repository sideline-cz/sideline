import type { ActivityLogApi, Team } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Activity, Users } from 'lucide-react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { ActivityMatrix } from '~/components/organisms/ActivityMatrix.js';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import { toGroupOptions } from '~/lib/group-options.js';
import { tr } from '~/lib/translations.js';

const ALL_VALUE = '__all__';

interface WorkoutTeamPageProps {
  teamId: Team.TeamId;
  // null = the matrix failed to load
  matrix: ActivityLogApi.ActivityMatrixResponse | null;
  groupId: string | undefined;
  onGroupChange: (groupId: string | undefined) => void;
  onRetry: () => void;
  isPending?: boolean;
}

export function WorkoutTeamPage({
  teamId,
  matrix,
  groupId,
  onGroupChange,
  onRetry,
  isPending = false,
}: WorkoutTeamPageProps) {
  const rows = matrix?.rows ?? [];
  const hasActivity = rows.some((r) => r.cells.length > 0);
  // Server days are Prague dates, today last: never the browser clock
  const lastDay = matrix?.days.at(-1);
  const todayDay = lastDay === undefined ? '' : Number(lastDay.slice(8, 10));

  return (
    <div className='flex min-w-0 flex-col gap-6'>
      <header>
        <Button asChild variant='ghost' size='sm' className='mb-2'>
          <Link to='/teams/$teamId/workout' params={{ teamId }}>
            ← {tr('makanicko_matrix_back')}
          </Link>
        </Button>
        <h1 className='text-2xl font-bold'>{tr('makanicko_matrix_title')}</h1>
        <p className='text-sm text-muted-foreground'>{tr('makanicko_matrix_subtitle')}</p>
      </header>

      <div className='flex flex-wrap items-end gap-x-6 gap-y-3'>
        <div className='flex w-full flex-col gap-1.5 sm:w-64'>
          <Label htmlFor='matrix-group'>{tr('makanicko_matrix_groupLabel')}</Label>
          <SearchableSelect
            id='matrix-group'
            value={groupId ?? ALL_VALUE}
            onValueChange={(v) => onGroupChange(v === ALL_VALUE ? undefined : v)}
            options={[
              { value: ALL_VALUE, label: tr('makanicko_matrix_groupAll') },
              ...toGroupOptions(matrix?.groups ?? []),
            ]}
            pinnedValues={[ALL_VALUE]}
          />
        </div>
        <ul className='flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground'>
          <li className='flex items-center gap-1.5'>
            <span aria-hidden='true' className='size-2.5 rounded-full bg-primary' />
            {tr('makanicko_matrix_legendDot')}
          </li>
          <li className='flex items-center gap-1.5'>
            <span
              aria-hidden='true'
              className='rounded-full bg-primary px-1.5 font-bold text-primary-foreground'
            >
              {todayDay}
            </span>
            {tr('makanicko_matrix_today')}
          </li>
          <li className='flex items-center gap-1.5'>
            <span aria-hidden='true' className='size-3 rounded-sm border bg-muted/50' />
            {tr('makanicko_matrix_legendWeekend')}
          </li>
        </ul>
      </div>

      {matrix === null ? (
        <Alert variant='destructive'>
          <AlertDescription className='flex flex-wrap items-center gap-3'>
            {tr('makanicko_matrix_error')}
            <Button size='sm' onClick={onRetry}>
              {tr('common_retry')}
            </Button>
          </AlertDescription>
        </Alert>
      ) : rows.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-2 py-10 text-center'>
          <Users className='size-8 text-muted-foreground' aria-hidden='true' />
          <p className='font-medium'>{tr('makanicko_matrix_noMembers_title')}</p>
          {groupId !== undefined ? (
            <Button variant='outline' size='sm' onClick={() => onGroupChange(undefined)}>
              {tr('makanicko_matrix_noMembers_cta')}
            </Button>
          ) : null}
        </div>
      ) : !hasActivity ? (
        <div className='flex flex-col items-center justify-center gap-2 py-10 text-center'>
          <Activity className='size-8 text-muted-foreground' aria-hidden='true' />
          <p className='font-medium'>{tr('makanicko_matrix_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('makanicko_matrix_empty_body')}</p>
        </div>
      ) : (
        <Card
          className={`min-w-0 overflow-hidden p-0${isPending ? ' opacity-60 transition-opacity' : ''}`}
        >
          <ActivityMatrix teamId={teamId} days={matrix.days} rows={rows} busy={isPending} />
        </Card>
      )}
    </div>
  );
}
