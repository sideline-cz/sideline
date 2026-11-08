import type { ActivityLogApi, Team } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { Link } from '@tanstack/react-router';
import { Option } from 'effect';
import React from 'react';
import { Button } from '~/components/ui/button';
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '~/components/ui/popover';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

interface ActivityMatrixProps {
  teamId: Team.TeamId;
  // YYYY-MM-DD Prague days, oldest first, today last
  days: ReadonlyArray<string>;
  rows: ReadonlyArray<ActivityLogApi.ActivityMatrixRow>;
  busy?: boolean;
}

// Day keys are calendar dates: read them at UTC noon so no zone shifts the day.
const toDate = (day: string) => new Date(`${day}T12:00:00Z`);

const sumMinutes = (entries: ReadonlyArray<ActivityLogApi.ActivityMatrixEntry>) =>
  entries.reduce<number | null>(
    (acc, e) => (Option.isSome(e.totalMinutes) ? (acc ?? 0) + e.totalMinutes.value : acc),
    null,
  );

export function ActivityMatrix({ teamId, days, rows, busy = false }: ActivityMatrixProps) {
  const locale = getLocale();
  const fmt = React.useMemo(
    () => ({
      weekday: new Intl.DateTimeFormat(locale, { weekday: 'narrow', timeZone: 'UTC' }),
      month: new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }),
      full: new Intl.DateTimeFormat(locale, {
        weekday: 'long',
        day: 'numeric',
        month: 'long',
        timeZone: 'UTC',
      }),
    }),
    [locale],
  );

  const todayIndex = days.length - 1;
  const frameRef = React.useRef<HTMLDivElement>(null);
  const cellRefs = React.useRef(new Map<string, HTMLElement>());
  // Roving tabindex: the whole day area is one tab stop (initially today in row 1)
  const [active, setActive] = React.useState({ r: 0, c: todayIndex });
  // Clamp at render: `rows` change per group filter and must never leave the grid without a tab stop
  const activeR = Math.max(0, Math.min(active.r, rows.length - 1));
  const activeC = Math.max(0, Math.min(active.c, todayIndex));

  // Today is the rightmost column: show it on a phone without a swipe
  React.useEffect(() => {
    const el = frameRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, []);

  const cellsByRow = React.useMemo(
    () => rows.map((row) => new Map(row.cells.map((cell) => [cell.date, cell.entries]))),
    [rows],
  );

  const focusCell = (r: number, c: number) => {
    const el = cellRefs.current.get(`${r}:${c}`);
    if (el === undefined) return;
    setActive({ r, c });
    el.focus();
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTableSectionElement>) => {
    const target = e.target;
    if (!(target instanceof HTMLElement)) return;
    const { r: rs, c: cs } = target.dataset;
    if (rs === undefined || cs === undefined) return;
    const r = Number(rs);
    const c = Number(cs);
    const next: Record<string, [number, number]> = {
      ArrowLeft: [r, Math.max(0, c - 1)],
      ArrowRight: [r, Math.min(todayIndex, c + 1)],
      ArrowUp: [Math.max(0, r - 1), c],
      ArrowDown: [Math.min(rows.length - 1, r + 1), c],
      Home: [r, 0],
      End: [r, todayIndex],
    };
    const to = next[e.key];
    if (to === undefined) return;
    e.preventDefault();
    focusCell(to[0], to[1]);
  };

  const cellProps = (r: number, c: number) => ({
    'data-r': r,
    'data-c': c,
    tabIndex: activeR === r && activeC === c ? 0 : -1,
    ref: (el: HTMLElement | null) => {
      if (el) cellRefs.current.set(`${r}:${c}`, el);
      else cellRefs.current.delete(`${r}:${c}`);
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      setActive({ r, c });
      // Keep the focused cell clear of the sticky name column (scroll-padding-left)
      e.currentTarget.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    },
  });

  return (
    // `relative`: the sr-only spans are absolute; without a positioned frame they escape the
    // scroller and widen the page
    <div
      ref={frameRef}
      data-testid='activity-matrix-frame'
      aria-busy={busy}
      className='relative max-h-[70vh] overflow-auto [--name-w:8.5rem] scroll-pl-(--name-w) sm:[--name-w:11rem]'
    >
      <table
        className='border-separate border-spacing-0 table-fixed text-sm'
        style={{ width: `calc(var(--name-w) + ${days.length * 2}rem)` }}
      >
        <caption className='sr-only'>{tr('makanicko_matrix_caption')}</caption>
        <thead>
          <tr>
            <th
              scope='col'
              className='sticky left-0 top-0 z-30 w-(--name-w) bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground shadow-[1px_0_0_var(--border)]'
            >
              {tr('makanicko_matrix_member')}
            </th>
            {days.map((day, c) => {
              const date = toDate(day);
              const isToday = c === todayIndex;
              const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
              const fullLabel = fmt.full.format(date);
              return (
                <th
                  key={day}
                  scope='col'
                  aria-label={
                    isToday ? tr('makanicko_matrix_todayLabel', { date: fullLabel }) : fullLabel
                  }
                  className={cn(
                    'sticky top-0 z-20 w-8 bg-card px-0 py-1 text-center align-bottom text-xs font-normal',
                    weekend && 'text-muted-foreground',
                  )}
                >
                  <span aria-hidden='true' className='flex flex-col items-center leading-tight'>
                    <span className='h-4 text-[10px] uppercase text-muted-foreground'>
                      {c === 0 || date.getUTCDate() === 1 ? fmt.month.format(date) : ''}
                    </span>
                    <span className={cn(isToday && 'font-bold')}>
                      {isToday ? tr('makanicko_matrix_today') : fmt.weekday.format(date)}
                    </span>
                    <span
                      className={cn(
                        'flex size-6 items-center justify-center tabular-nums',
                        isToday && 'rounded-full bg-primary font-bold text-primary-foreground',
                      )}
                    >
                      {date.getUTCDate()}
                    </span>
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody onKeyDown={handleKeyDown}>
          {rows.map((row, r) => {
            const cells = cellsByRow[r] ?? new Map();
            const activeDays = days.filter((d) => cells.has(d)).length;
            return (
              <tr key={row.memberId}>
                <th
                  scope='row'
                  className='sticky left-0 z-10 w-(--name-w) bg-card px-3 py-1 text-left font-normal shadow-[1px_0_0_var(--border)]'
                >
                  <Link
                    to='/teams/$teamId/workout/members/$memberId'
                    params={{ teamId, memberId: row.memberId }}
                    title={row.displayName}
                    className='block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50'
                  >
                    {row.displayName}
                  </Link>
                  <span aria-hidden='true' className='text-xs text-muted-foreground tabular-nums'>
                    {tr('makanicko_matrix_activeDays', { count: activeDays })}
                  </span>
                  <span className='sr-only'>
                    {tr('makanicko_matrix_activeDaysLabel', { count: activeDays })}
                  </span>
                </th>
                {days.map((day, c) => {
                  const date = toDate(day);
                  const isToday = c === todayIndex;
                  const weekend = date.getUTCDay() === 0 || date.getUTCDay() === 6;
                  const tdClass = cn(
                    'h-10 w-8 p-0 text-center',
                    weekend && 'bg-muted/50',
                    isToday && 'border-x border-ring bg-accent',
                  );
                  const entries = cells.get(day);
                  if (entries === undefined || entries.length === 0) {
                    return (
                      <td
                        key={day}
                        className={cn(
                          tdClass,
                          'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                        )}
                        {...cellProps(r, c)}
                      >
                        <span className='sr-only'>{tr('makanicko_matrix_cellNone')}</span>
                      </td>
                    );
                  }
                  const dateLabel = fmt.full.format(date);
                  const types = entries.map((e) => e.activityTypeName).join(', ');
                  const minutes = sumMinutes(entries);
                  const label =
                    minutes === null
                      ? tr('makanicko_matrix_cellLabelNoDuration', {
                          name: row.displayName,
                          date: dateLabel,
                          types,
                        })
                      : tr('makanicko_matrix_cellLabel', {
                          name: row.displayName,
                          date: dateLabel,
                          types,
                          minutes,
                        });
                  return (
                    <td key={day} className={tdClass}>
                      <Popover>
                        <PopoverTrigger asChild>
                          <Button
                            type='button'
                            variant='ghost'
                            aria-label={label}
                            data-matrix-dot=''
                            className='h-full w-full min-h-0 min-w-0 rounded-none p-0'
                            {...cellProps(r, c)}
                          >
                            <span aria-hidden='true' className='size-2.5 rounded-full bg-primary' />
                          </Button>
                        </PopoverTrigger>
                        <PopoverContent className='w-56'>
                          <PopoverTitle className='mb-2 text-sm font-medium'>
                            {dateLabel}
                          </PopoverTitle>
                          <ul className='flex flex-col gap-1 text-sm'>
                            {entries.map((e, i) => (
                              // biome-ignore lint/suspicious/noArrayIndexKey: entries have no id; order is stable
                              <li key={i}>
                                {Option.match(e.activityTypeEmoji, {
                                  onNone: () => null,
                                  onSome: (emoji) => (
                                    <span aria-hidden='true' className='mr-1'>
                                      {emoji}
                                    </span>
                                  ),
                                })}
                                {e.activityTypeName}
                                {Option.isSome(e.totalMinutes)
                                  ? ` · ${e.totalMinutes.value} min`
                                  : null}
                              </li>
                            ))}
                          </ul>
                          {entries.length > 1 && minutes !== null ? (
                            <p className='mt-2 border-t pt-2 text-sm font-medium'>
                              {tr('makanicko_matrix_total', { minutes })}
                            </p>
                          ) : null}
                        </PopoverContent>
                      </Popover>
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
