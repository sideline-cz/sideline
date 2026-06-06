import type { EventApi } from '@sideline/domain';
import {
  addDays,
  addMonths,
  addWeeks,
  eachDayOfInterval,
  endOfMonth,
  endOfWeek,
  isSameDay,
  isSameMonth,
  isToday,
  startOfMonth,
  startOfWeek,
  subMonths,
  subWeeks,
} from 'date-fns';
import { DateTime, Option } from 'effect';
import { formatUtcDate } from '~/lib/datetime.js';

export interface CalendarDay {
  date: Date;
  isCurrentMonth: boolean;
  isToday: boolean;
  events: ReadonlyArray<EventApi.EventInfo>;
}

/** A grid day's calendar date as YYYY-MM-DD in the browser's local timezone. */
function localDateKey(date: Date): string {
  const y = date.getFullYear();
  const mo = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${y}-${mo}-${day}`;
}

function eventsForDay(
  date: Date,
  events: ReadonlyArray<EventApi.EventInfo>,
): ReadonlyArray<EventApi.EventInfo> {
  const key = localDateKey(date);
  return events.filter((e) => {
    // All-day events span every calendar day from their (UTC) start through end date.
    if (e.allDay) {
      const start = formatUtcDate(e.startAt);
      const end = Option.match(e.endAt, { onNone: () => start, onSome: formatUtcDate });
      return key >= start && key <= end;
    }
    return isSameDay(new Date(DateTime.toEpochMillis(e.startAt)), date);
  });
}

export function buildMonthGrid(
  year: number,
  month: number,
  events: ReadonlyArray<EventApi.EventInfo>,
): ReadonlyArray<CalendarDay> {
  const reference = new Date(year, month);
  const monthStart = startOfMonth(reference);
  const monthEnd = endOfMonth(reference);
  const gridStart = startOfWeek(monthStart, { weekStartsOn: 1 });
  const gridEnd = endOfWeek(monthEnd, { weekStartsOn: 1 });

  return eachDayOfInterval({ start: gridStart, end: gridEnd }).map((date) => ({
    date,
    isCurrentMonth: isSameMonth(date, reference),
    isToday: isToday(date),
    events: eventsForDay(date, events),
  }));
}

export function buildWeekDays(
  referenceDate: Date,
  events: ReadonlyArray<EventApi.EventInfo>,
): ReadonlyArray<CalendarDay> {
  const weekStart = startOfWeek(referenceDate, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(referenceDate, { weekStartsOn: 1 });

  return eachDayOfInterval({ start: weekStart, end: weekEnd }).map((date) => ({
    date,
    isCurrentMonth: true,
    isToday: isToday(date),
    events: eventsForDay(date, events),
  }));
}

export function navigateMonth(
  year: number,
  month: number,
  direction: 'prev' | 'next',
): { year: number; month: number } {
  const d =
    direction === 'next'
      ? addMonths(new Date(year, month), 1)
      : subMonths(new Date(year, month), 1);
  return { year: d.getFullYear(), month: d.getMonth() };
}

export function navigateWeek(date: Date, direction: 'prev' | 'next'): Date {
  return direction === 'next' ? addWeeks(date, 1) : subWeeks(date, 1);
}

export function getWeekdayHeaders(locale?: string): ReadonlyArray<string> {
  const weekStart = startOfWeek(new Date(), { weekStartsOn: 1 });
  return eachDayOfInterval({
    start: weekStart,
    end: addDays(weekStart, 6),
  }).map((d) => d.toLocaleDateString(locale, { weekday: 'short' }));
}
