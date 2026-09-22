import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';

export const EventTypeId = Schema.String.pipe(Schema.brand('EventTypeId'));
export type EventTypeId = typeof EventTypeId.Type;

// The six behaviours a type can bucket to. Immutable once a type is created — see
// AGENTS.md's ownership statement for events.event_type_id / events.event_type.
export const EventTypeKind = Schema.Literals([
  'training',
  'match',
  'tournament',
  'meeting',
  'social',
  'other',
]);
export type EventTypeKind = typeof EventTypeKind.Type;

// Character-identical to the `color` CHECK in 1792400000_create_event_types.ts. An unknown
// value renders no Tailwind class, i.e. an invisible badge — keep the two lists in lockstep.
export const EventTypeColor = Schema.Literals([
  'blue',
  'emerald',
  'purple',
  'amber',
  'cyan',
  'rose',
  'indigo',
  'teal',
  'red',
  'orange',
  'slate',
  'pink',
  'gray',
]);
export type EventTypeColor = typeof EventTypeColor.Type;

export const EventTypeName = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(50)));
export type EventTypeName = typeof EventTypeName.Type;

// Tailwind-500 hex, for Discord embed colours (which take a 24-bit int, not a class name).
export const eventTypeColorHex: Record<EventTypeColor, number> = {
  blue: 0x3b82f6,
  emerald: 0x10b981,
  purple: 0xa855f7,
  amber: 0xf59e0b,
  cyan: 0x06b6d4,
  rose: 0xf43f5e,
  indigo: 0x6366f1,
  teal: 0x14b8a6,
  red: 0xef4444,
  orange: 0xf97316,
  slate: 0x64748b,
  pink: 0xec4899,
  gray: 0x6b7280,
};

// Seed map (migration Step 2/3) and rolling-deploy fallback — reproduces
// event-colors.ts:62-99 exactly.
export const defaultColorForKind: Record<EventTypeKind, EventTypeColor> = {
  training: 'blue',
  match: 'red',
  tournament: 'orange',
  meeting: 'slate',
  social: 'pink',
  other: 'gray',
};

export class EventType extends Model.Class<EventType>('EventType')({
  id: Model.Generated(EventTypeId),
  team_id: TeamId,
  // NULL = render the built-in translated label for `kind`. Set = team free text.
  name: Schema.OptionFromNullOr(EventTypeName),
  kind: EventTypeKind,
  color: EventTypeColor,
  // Presentation ONLY. Never read by a kind-to-id resolution query.
  position: Schema.Number,
  archived_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
