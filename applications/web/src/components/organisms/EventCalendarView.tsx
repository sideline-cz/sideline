import type { EventApi, TrainingTypeApi } from '@sideline/domain';
import { getLocale } from '@sideline/i18n/runtime';
import { Link } from '@tanstack/react-router';
import { format } from 'date-fns';
import { Option } from 'effect';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import React from 'react';
import { SearchableSelect } from '~/components/atoms/SearchableSelect';
import { Button } from '~/components/ui/button';
import { useDateFnsLocale } from '~/hooks/useDateFnsLocale';
import {
  buildMonthGrid,
  buildWeekDays,
  type CalendarDay,
  getWeekdayHeaders,
  navigateMonth,
  navigateWeek,
} from '~/lib/calendar-utils';
import { formatLocalTime } from '~/lib/datetime';
import {
  buildTrainingTypeColorMap,
  getEventColor,
  type TrainingTypeColorMap,
} from '~/lib/event-colors';
import { eventTypeLabels } from '~/lib/event-labels';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

const FILTER_ALL = '__all__';

interface EventCalendarViewProps {
  teamId: string;
  events: ReadonlyArray<EventApi.EventInfo>;
  trainingTypes: ReadonlyArray<TrainingTypeApi.TrainingTypeInfo>;
}

export function EventCalendarView({ teamId, events, trainingTypes }: EventCalendarViewProps) {
  const now = new Date();
  const dateFnsLocale = useDateFnsLocale();
  const [calendarMode, setCalendarMode] = React.useState<'month' | 'week'>('month');
  const [currentYear, setCurrentYear] = React.useState(now.getFullYear());
  const [currentMonth, setCurrentMonth] = React.useState(now.getMonth());
  const [currentWeekDate, setCurrentWeekDate] = React.useState(now);
  const [filterTrainingType, setFilterTrainingType] = React.useState(FILTER_ALL);

  const colorMap = React.useMemo<TrainingTypeColorMap>(
    () => buildTrainingTypeColorMap(trainingTypes.map((tt) => tt.name)),
    [trainingTypes],
  );

  const filteredEvents = React.useMemo(() => {
    if (filterTrainingType === FILTER_ALL) return events;
    return events.filter((e) => Option.getOrNull(e.trainingTypeName) === filterTrainingType);
  }, [events, filterTrainingType]);

  const monthGrid = React.useMemo(
    () => buildMonthGrid(currentYear, currentMonth, filteredEvents),
    [currentYear, currentMonth, filteredEvents],
  );

  const weekDays = React.useMemo(
    () => buildWeekDays(currentWeekDate, filteredEvents),
    [currentWeekDate, filteredEvents],
  );

  const localeTag = getLocale();
  const weekdayHeaders = React.useMemo(() => getWeekdayHeaders(localeTag), [localeTag]);

  const handlePrev = () => {
    if (calendarMode === 'month') {
      const nav = navigateMonth(currentYear, currentMonth, 'prev');
      setCurrentYear(nav.year);
      setCurrentMonth(nav.month);
    } else {
      setCurrentWeekDate(navigateWeek(currentWeekDate, 'prev'));
    }
  };

  const handleNext = () => {
    if (calendarMode === 'month') {
      const nav = navigateMonth(currentYear, currentMonth, 'next');
      setCurrentYear(nav.year);
      setCurrentMonth(nav.month);
    } else {
      setCurrentWeekDate(navigateWeek(currentWeekDate, 'next'));
    }
  };

  const handleToday = () => {
    const today = new Date();
    setCurrentYear(today.getFullYear());
    setCurrentMonth(today.getMonth());
    setCurrentWeekDate(today);
  };

  const title =
    calendarMode === 'month'
      ? format(new Date(currentYear, currentMonth), 'MMMM yyyy', { locale: dateFnsLocale })
      : `${format(weekDays[0]?.date ?? currentWeekDate, 'MMM d', { locale: dateFnsLocale })} – ${format(weekDays[6]?.date ?? currentWeekDate, 'MMM d, yyyy', { locale: dateFnsLocale })}`;

  return (
    <div className='flex flex-col gap-4'>
      {/* Toolbar */}
      <div className='flex flex-wrap items-center gap-2'>
        <div className='flex items-center gap-1'>
          <Button variant='outline' size='icon' onClick={handlePrev}>
            <ChevronLeft className='h-4 w-4' />
          </Button>
          <Button variant='outline' size='icon' onClick={handleNext}>
            <ChevronRight className='h-4 w-4' />
          </Button>
          <Button variant='outline' size='sm' onClick={handleToday}>
            {tr('event_calendarToday')}
          </Button>
        </div>

        <h2 className='text-lg font-semibold min-w-[180px]'>{title}</h2>

        <div className='ml-auto flex items-center gap-2'>
          <SearchableSelect
            value={filterTrainingType}
            onValueChange={setFilterTrainingType}
            className='w-[160px]'
            options={[
              { value: FILTER_ALL, label: tr('event_calendarFilterAll') },
              ...trainingTypes.map((tt) => ({ value: tt.name, label: tt.name })),
            ]}
            pinnedValues={[FILTER_ALL]}
          />

          <div className='flex rounded-md border'>
            <Button
              variant={calendarMode === 'month' ? 'default' : 'ghost'}
              size='sm'
              className='rounded-r-none'
              onClick={() => setCalendarMode('month')}
            >
              {tr('event_calendarMonth')}
            </Button>
            <Button
              variant={calendarMode === 'week' ? 'default' : 'ghost'}
              size='sm'
              className='rounded-l-none'
              onClick={() => setCalendarMode('week')}
            >
              {tr('event_calendarWeek')}
            </Button>
          </div>
        </div>
      </div>

      {/* Calendar Grid */}
      {calendarMode === 'month' ? (
        <MonthGrid
          days={monthGrid}
          weekdayHeaders={weekdayHeaders}
          teamId={teamId}
          colorMap={colorMap}
        />
      ) : (
        <WeekGrid days={weekDays} teamId={teamId} colorMap={colorMap} />
      )}
    </div>
  );
}

/* ─── Month Grid ─── */

function MonthGrid({
  days,
  weekdayHeaders,
  teamId,
  colorMap,
}: {
  days: ReadonlyArray<CalendarDay>;
  weekdayHeaders: ReadonlyArray<string>;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}) {
  return (
    <div>
      <div className='grid grid-cols-7 border-b'>
        {weekdayHeaders.map((header) => (
          <div key={header} className='py-2 text-center text-xs font-medium text-muted-foreground'>
            {header}
          </div>
        ))}
      </div>
      <div className='grid grid-cols-7'>
        {days.map((day) => (
          <MonthDayCell
            key={day.date.toISOString()}
            day={day}
            teamId={teamId}
            colorMap={colorMap}
          />
        ))}
      </div>
    </div>
  );
}

const MAX_VISIBLE_CHIPS = 3;

function MonthDayCell({
  day,
  teamId,
  colorMap,
}: {
  day: CalendarDay;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}) {
  const visible = day.events.slice(0, MAX_VISIBLE_CHIPS);
  const overflowCount = day.events.length - MAX_VISIBLE_CHIPS;

  return (
    <div
      className={cn(
        'min-h-[80px] sm:min-h-[100px] border-b border-r p-1 sm:p-1.5',
        !day.isCurrentMonth && 'bg-muted/30',
      )}
    >
      <div
        className={cn(
          'text-xs sm:text-sm font-medium mb-0.5 w-6 h-6 flex items-center justify-center rounded-full',
          day.isToday && 'bg-primary text-primary-foreground',
          !day.isCurrentMonth && 'text-muted-foreground',
        )}
      >
        {day.date.getDate()}
      </div>

      {/* Desktop: chips */}
      <div className='hidden sm:flex flex-col gap-0.5'>
        {visible.map((event) => (
          <EventChip key={event.eventId} event={event} teamId={teamId} colorMap={colorMap} />
        ))}
        {overflowCount > 0 && (
          <span className='text-xs text-muted-foreground pl-1'>+{overflowCount} more</span>
        )}
      </div>

      {/* Mobile: dots */}
      <div className='flex sm:hidden gap-0.5 flex-wrap'>
        {day.events.map((event) => {
          const color = getEventColor(
            event.eventType,
            Option.getOrNull(event.trainingTypeName),
            colorMap,
          );
          return (
            <Link
              key={event.eventId}
              to='/teams/$teamId/events/$eventId'
              params={{ teamId, eventId: event.eventId }}
              className={cn('w-2 h-2 rounded-full', color.dot)}
            />
          );
        })}
      </div>
    </div>
  );
}

function EventChip({
  event,
  teamId,
  colorMap,
}: {
  event: EventApi.EventInfo;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}) {
  const color = getEventColor(event.eventType, Option.getOrNull(event.trainingTypeName), colorMap);
  const isCancelled = event.status === 'cancelled';
  const time = formatLocalTime(event.startAt);

  return (
    <Link
      to='/teams/$teamId/events/$eventId'
      params={{ teamId, eventId: event.eventId }}
      className={cn(
        'flex items-center gap-1 rounded px-1.5 py-0.5 text-xs truncate border',
        color.bg,
        color.text,
        color.border,
        isCancelled && 'line-through opacity-60',
      )}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', color.dot)} />
      <span className='truncate'>
        {time} {event.title}
      </span>
    </Link>
  );
}

/* ─── Week Grid ─── */

function WeekGrid({
  days,
  teamId,
  colorMap,
}: {
  days: ReadonlyArray<CalendarDay>;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}) {
  const dateFnsLocale = useDateFnsLocale();
  return (
    <>
      {/* Desktop: 7-column grid */}
      <div className='hidden sm:grid grid-cols-7 gap-px bg-border rounded-md overflow-hidden'>
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            className={cn(
              'bg-background min-h-[200px] p-2',
              day.isToday && 'ring-2 ring-primary ring-inset',
            )}
          >
            <div className='flex items-center gap-1 mb-2'>
              <span className='text-xs text-muted-foreground'>
                {format(day.date, 'EEE', { locale: dateFnsLocale })}
              </span>
              <span
                className={cn(
                  'text-sm font-medium w-6 h-6 flex items-center justify-center rounded-full',
                  day.isToday && 'bg-primary text-primary-foreground',
                )}
              >
                {day.date.getDate()}
              </span>
            </div>
            <div className='flex flex-col gap-1'>
              {day.events.length === 0 ? (
                <span className='text-xs text-muted-foreground'>
                  {tr('event_calendarNoEvents')}
                </span>
              ) : (
                day.events.map((event) => (
                  <WeekEventCard
                    key={event.eventId}
                    event={event}
                    teamId={teamId}
                    colorMap={colorMap}
                  />
                ))
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Mobile: vertical card stack */}
      <div className='flex sm:hidden flex-col gap-3'>
        {days.map((day) => (
          <div key={day.date.toISOString()}>
            <div className={cn('text-sm font-medium mb-1 px-1', day.isToday && 'text-primary')}>
              {format(day.date, 'EEEE, MMM d', { locale: dateFnsLocale })}
            </div>
            {day.events.length === 0 ? (
              <p className='text-xs text-muted-foreground px-1'>{tr('event_calendarNoEvents')}</p>
            ) : (
              <div className='flex flex-col gap-1'>
                {day.events.map((event) => (
                  <WeekEventCard
                    key={event.eventId}
                    event={event}
                    teamId={teamId}
                    colorMap={colorMap}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function WeekEventCard({
  event,
  teamId,
  colorMap,
}: {
  event: EventApi.EventInfo;
  teamId: string;
  colorMap: TrainingTypeColorMap;
}) {
  const color = getEventColor(event.eventType, Option.getOrNull(event.trainingTypeName), colorMap);
  const isCancelled = event.status === 'cancelled';
  const time = formatLocalTime(event.startAt);
  const endTime = Option.map(event.endAt, formatLocalTime);

  return (
    <Link
      to='/teams/$teamId/events/$eventId'
      params={{ teamId, eventId: event.eventId }}
      className={cn(
        'block rounded-md border p-2',
        color.bg,
        color.border,
        isCancelled && 'line-through opacity-60',
      )}
    >
      <div className={cn('text-sm font-medium', color.text)}>{event.title}</div>
      <div className='text-xs text-muted-foreground'>
        {time}
        {endTime.pipe(
          Option.map((v) => ` – ${v}`),
          Option.getOrElse(() => ''),
        )}{' '}
        · {eventTypeLabels[event.eventType]()}
        {event.trainingTypeName.pipe(
          Option.map((v) => ` · ${v}`),
          Option.getOrElse(() => ''),
        )}
      </div>
      {Option.isSome(event.location) && (
        <div className='text-xs text-muted-foreground mt-0.5'>{event.location.value}</div>
      )}
    </Link>
  );
}
