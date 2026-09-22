import type { Event } from '@sideline/domain';
import { Option } from 'effect';
import { tr } from '~/lib/translations.js';

export const eventTypeLabels: Record<Event.EventType, () => string> = {
  training: () => tr('event_type_training'),
  match: () => tr('event_type_match'),
  tournament: () => tr('event_type_tournament'),
  meeting: () => tr('event_type_meeting'),
  social: () => tr('event_type_social'),
  other: () => tr('event_type_other'),
};

/**
 * Collapses `EventInfo`/`EventDetail`'s `eventTypeName: Option<Option<string>>` (the outer
 * Option is a rolling-deploy `OptionFromOptionalKey` — an old server omits the key entirely;
 * the inner Option is the real "seeded row, no custom name" signal) down to a single
 * renderable string: the team's custom name when set, otherwise the translated label for the
 * event's `kind`. Never returns a blank cell.
 */
export const eventTypeName = (
  name: Option.Option<Option.Option<string>>,
  kind: Event.EventType,
): string => Option.getOrElse(Option.flatten(name), () => eventTypeLabels[kind]());

export const eventStatusLabels: Record<Event.EventStatus, () => string> = {
  active: () => tr('event_status_active'),
  cancelled: () => tr('event_status_cancelled'),
  started: () => tr('event_status_started'),
};

export const eventStatusClasses: Record<Event.EventStatus, string> = {
  active: 'text-green-700 dark:text-green-400 font-medium',
  cancelled: 'text-muted-foreground line-through',
  started: 'text-amber-700 dark:text-amber-400 font-medium',
};

export const dayShortLabels: Record<number, () => string> = {
  0: () => tr('event_day_short_0'),
  1: () => tr('event_day_short_1'),
  2: () => tr('event_day_short_2'),
  3: () => tr('event_day_short_3'),
  4: () => tr('event_day_short_4'),
  5: () => tr('event_day_short_5'),
  6: () => tr('event_day_short_6'),
};

export const dayFullLabels: Record<number, () => string> = {
  0: () => tr('event_day_0'),
  1: () => tr('event_day_1'),
  2: () => tr('event_day_2'),
  3: () => tr('event_day_3'),
  4: () => tr('event_day_4'),
  5: () => tr('event_day_5'),
  6: () => tr('event_day_6'),
};

export const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0];

export const sortDays = (days: number[]): number[] =>
  [...days].sort((a, b) => DAY_ORDER.indexOf(a) - DAY_ORDER.indexOf(b));
