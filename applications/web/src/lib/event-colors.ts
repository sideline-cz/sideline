import type { Event } from '@sideline/domain';
import { EventType } from '@sideline/domain';
import { Option } from 'effect';

export interface EventColorSet {
  bg: string;
  text: string;
  dot: string;
  border: string;
}

// Character-identical color set for every `EventType.EventTypeColor` literal (13 hues). Every
// class string below is written out literally — Tailwind's scanner cannot see an interpolated
// class (`bg-${color}-100`), and that silently renders an invisible badge instead of a compile
// error. Each set carries its own `dark:` variant in all four strings (event-colors.test.ts
// asserts this).
export const EVENT_COLOR_SETS: Record<EventType.EventTypeColor, EventColorSet> = {
  blue: {
    bg: 'bg-blue-100 dark:bg-blue-900/30',
    text: 'text-blue-800 dark:text-blue-200',
    dot: 'bg-blue-500 dark:bg-blue-400',
    border: 'border-blue-300 dark:border-blue-700',
  },
  emerald: {
    bg: 'bg-emerald-100 dark:bg-emerald-900/30',
    text: 'text-emerald-800 dark:text-emerald-200',
    dot: 'bg-emerald-500 dark:bg-emerald-400',
    border: 'border-emerald-300 dark:border-emerald-700',
  },
  purple: {
    bg: 'bg-purple-100 dark:bg-purple-900/30',
    text: 'text-purple-800 dark:text-purple-200',
    dot: 'bg-purple-500 dark:bg-purple-400',
    border: 'border-purple-300 dark:border-purple-700',
  },
  amber: {
    bg: 'bg-amber-100 dark:bg-amber-900/30',
    text: 'text-amber-800 dark:text-amber-200',
    dot: 'bg-amber-500 dark:bg-amber-400',
    border: 'border-amber-300 dark:border-amber-700',
  },
  cyan: {
    bg: 'bg-cyan-100 dark:bg-cyan-900/30',
    text: 'text-cyan-800 dark:text-cyan-200',
    dot: 'bg-cyan-500 dark:bg-cyan-400',
    border: 'border-cyan-300 dark:border-cyan-700',
  },
  rose: {
    bg: 'bg-rose-100 dark:bg-rose-900/30',
    text: 'text-rose-800 dark:text-rose-200',
    dot: 'bg-rose-500 dark:bg-rose-400',
    border: 'border-rose-300 dark:border-rose-700',
  },
  indigo: {
    bg: 'bg-indigo-100 dark:bg-indigo-900/30',
    text: 'text-indigo-800 dark:text-indigo-200',
    dot: 'bg-indigo-500 dark:bg-indigo-400',
    border: 'border-indigo-300 dark:border-indigo-700',
  },
  teal: {
    bg: 'bg-teal-100 dark:bg-teal-900/30',
    text: 'text-teal-800 dark:text-teal-200',
    dot: 'bg-teal-500 dark:bg-teal-400',
    border: 'border-teal-300 dark:border-teal-700',
  },
  red: {
    bg: 'bg-red-100 dark:bg-red-900/30',
    text: 'text-red-800 dark:text-red-200',
    dot: 'bg-red-500 dark:bg-red-400',
    border: 'border-red-300 dark:border-red-700',
  },
  orange: {
    bg: 'bg-orange-100 dark:bg-orange-900/30',
    text: 'text-orange-800 dark:text-orange-200',
    dot: 'bg-orange-500 dark:bg-orange-400',
    border: 'border-orange-300 dark:border-orange-700',
  },
  slate: {
    bg: 'bg-slate-100 dark:bg-slate-900/30',
    text: 'text-slate-800 dark:text-slate-200',
    dot: 'bg-slate-500 dark:bg-slate-400',
    border: 'border-slate-300 dark:border-slate-700',
  },
  pink: {
    bg: 'bg-pink-100 dark:bg-pink-900/30',
    text: 'text-pink-800 dark:text-pink-200',
    dot: 'bg-pink-500 dark:bg-pink-400',
    border: 'border-pink-300 dark:border-pink-700',
  },
  gray: {
    bg: 'bg-gray-100 dark:bg-gray-900/30',
    text: 'text-gray-800 dark:text-gray-200',
    dot: 'bg-gray-500 dark:bg-gray-400',
    border: 'border-gray-300 dark:border-gray-700',
  },
};

/**
 * `color` is the resolved `EventTypeInfo.color` (or `EventInfo`/`EventDetail`'s
 * `eventTypeColor`) for the event's type — `Option.none()` only during a rolling deploy
 * against an old server, or for an event whose type was deleted before this feature existed.
 * Falls back to `EventType.defaultColorForKind[kind]`, i.e. "today's colour" for each kind,
 * unchanged behaviour from before event types were customizable.
 */
export function getEventColor(
  color: Option.Option<EventType.EventTypeColor>,
  kind: Event.EventType,
): EventColorSet {
  return EVENT_COLOR_SETS[Option.getOrElse(color, () => EventType.defaultColorForKind[kind])];
}
