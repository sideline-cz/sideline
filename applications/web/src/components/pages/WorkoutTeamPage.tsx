import type { ActivityLogApi, ActivityType, Team } from '@sideline/domain';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import { Activity, Plus, Users } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { ActivityMatrix } from '~/components/organisms/ActivityMatrix.js';
import { LogActivityForm, type LogActivityInput } from '~/components/organisms/LogActivityForm.js';
import { Alert, AlertDescription } from '~/components/ui/alert';
import { Button } from '~/components/ui/button';
import { Card } from '~/components/ui/card';
import { Label } from '~/components/ui/label';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '~/components/ui/sheet';
import { activityTypeColors, FALLBACK_COLOR } from '~/lib/activityColors.js';
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
  // The team's full type list keeps each type's colour stable across group filters
  activityTypes?: ReadonlyArray<{
    name: string;
    emoji: Option.Option<string>;
    color?: Option.Option<ActivityType.ActivityTypeColor>;
  }>;
  isPending?: boolean;
  currentMemberId?: string | null;
  // Types the viewer can log; empty hides the log button
  logActivityTypes?: ReadonlyArray<{
    id: ActivityType.ActivityTypeId;
    name: string;
    emoji: Option.Option<string>;
  }>;
  // Resolves true once saved (the caller refreshes the matrix)
  onLogActivity?: (input: LogActivityInput) => Promise<boolean>;
}

export function WorkoutTeamPage({
  teamId,
  matrix,
  groupId,
  onGroupChange,
  onRetry,
  activityTypes = [],
  isPending = false,
  currentMemberId = null,
  logActivityTypes = [],
  onLogActivity,
}: WorkoutTeamPageProps) {
  const [logOpen, setLogOpen] = React.useState(false);
  const canLog =
    currentMemberId !== null && onLogActivity !== undefined && logActivityTypes.length > 0;
  const rows = matrix?.rows ?? [];
  // Only members who logged something in the window get a row
  const activeRows = rows.filter((r) => r.cells.length > 0);
  const colors = React.useMemo(() => activityTypeColors(activityTypes), [activityTypes]);
  // Legend: only the types that appear in the grid
  const shownTypes = React.useMemo(() => {
    const seen = new Set(
      activeRows.flatMap((r) => r.cells.flatMap((c) => c.entries.map((e) => e.activityTypeName))),
    );
    const known = activityTypes.filter((t) => seen.has(t.name));
    const knownNames = new Set(known.map((t) => t.name));
    return [
      ...known,
      ...[...seen]
        .filter((n) => !knownNames.has(n))
        .map((name) => ({ name, emoji: Option.none<string>() })),
    ];
  }, [activeRows, activityTypes]);
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
        <div className='flex flex-wrap items-start justify-between gap-3'>
          <div>
            <h1 className='text-2xl font-bold'>{tr('makanicko_matrix_title')}</h1>
            <p className='text-sm text-muted-foreground'>{tr('makanicko_matrix_subtitle')}</p>
          </div>
          {canLog ? (
            <Button size='sm' onClick={() => setLogOpen(true)}>
              <Plus aria-hidden='true' />
              {tr('activityLog_logActivity')}
            </Button>
          ) : null}
        </div>
      </header>

      {canLog ? (
        <Sheet open={logOpen} onOpenChange={setLogOpen}>
          <SheetContent>
            <SheetHeader>
              <SheetTitle>{tr('activityLog_logActivity')}</SheetTitle>
            </SheetHeader>
            <div className='px-4 pb-4'>
              <LogActivityForm
                activityTypes={logActivityTypes}
                onCreateLog={async (input) => {
                  if (await onLogActivity(input)) setLogOpen(false);
                }}
              />
            </div>
          </SheetContent>
        </Sheet>
      ) : null}

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
          {shownTypes.map((t) => (
            <li key={t.name} className='flex items-center gap-1.5'>
              <span
                aria-hidden='true'
                className={`size-2.5 rounded-full ${colors.get(t.name) ?? FALLBACK_COLOR}`}
              />
              {Option.match(t.emoji, {
                onNone: () => null,
                onSome: (e) => <span aria-hidden='true'>{e}</span>,
              })}
              {t.name}
            </li>
          ))}
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
      ) : activeRows.length === 0 ? (
        <div className='flex flex-col items-center justify-center gap-2 py-10 text-center'>
          <Activity className='size-8 text-muted-foreground' aria-hidden='true' />
          <p className='font-medium'>{tr('makanicko_matrix_empty_title')}</p>
          <p className='text-sm text-muted-foreground'>{tr('makanicko_matrix_empty_body')}</p>
        </div>
      ) : (
        <Card
          className={`min-w-0 overflow-hidden p-0${isPending ? ' opacity-60 transition-opacity' : ''}`}
        >
          <ActivityMatrix
            teamId={teamId}
            days={matrix.days}
            rows={activeRows}
            colors={colors}
            busy={isPending}
            currentMemberId={currentMemberId}
          />
        </Card>
      )}
    </div>
  );
}
