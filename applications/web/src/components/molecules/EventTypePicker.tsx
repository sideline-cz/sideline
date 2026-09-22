import type { Event, EventType, EventTypeApi } from '@sideline/domain';
import { Option } from 'effect';
import React from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '~/components/ui/select';
import { getEventColor } from '~/lib/event-colors.js';
import { eventTypeLabels, eventTypeName } from '~/lib/event-labels.js';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

/** The event's own persisted snapshot — used only to resolve a default when `value` is
 *  `None`, and to render a synthetic option when the persisted id points at a type no longer
 *  in `eventTypes` (archived). See `EventInfo`/`EventDetail` for the real shape this mirrors. */
export interface EventTypePickerEvent {
  eventType: Event.EventType;
  eventTypeId: Option.Option<EventType.EventTypeId>;
  eventTypeName: Option.Option<Option.Option<string>>;
  eventTypeColor: Option.Option<EventType.EventTypeColor>;
}

interface EventTypePickerProps {
  /** Active types from `GET /teams/:teamId/event-types`, in position order. */
  eventTypes: ReadonlyArray<EventTypeApi.EventTypeInfo>;
  event: EventTypePickerEvent;
  /** Controlled current selection. */
  value: Option.Option<EventType.EventTypeId>;
  onChange: (next: { eventTypeId: EventType.EventTypeId; kind: Event.EventType }) => void;
}

/**
 * The shared picker `EventsListPage.tsx` and `EventDetailPage.tsx` factor out to keep the
 * archived-current-type / no-id-preselect logic (plan B3/B4) in one place instead of
 * duplicating it per page. A shadcn `Select`, deliberately NOT `SearchableSelect` — that
 * component sorts its options alphabetically (would destroy the team's `position` order) and
 * types `label: string` (cannot carry a colour dot).
 *
 * B4, archived: when the current id (`value`, falling back to `event.eventTypeId`) points at
 * an id absent from `eventTypes`, a DISABLED option built from the event's own
 * name/colour is prepended and rendered as the current selection — a title-only edit must
 * never silently re-type the event onto the placeholder/first item.
 *
 * B4, no id at all (old server): when there is no known id anywhere, the first ACTIVE type OF
 * THE EVENT'S OWN KIND is preselected and reported via `onChange` — never simply the first
 * type in the list — so the parent's form state carries a concrete id from the first render.
 */
export function EventTypePicker({ eventTypes, event, value, onChange }: EventTypePickerProps) {
  const currentId = Option.orElse(value, () => event.eventTypeId);
  const activeType = Option.flatMap(currentId, (id) =>
    Option.fromNullishOr(eventTypes.find((t) => t.eventTypeId === id)),
  );
  const archivedCurrent =
    Option.isSome(currentId) && Option.isNone(activeType) ? currentId : Option.none();

  React.useEffect(() => {
    if (Option.isSome(currentId)) return;
    const fallback = eventTypes.find((t) => t.kind === event.eventType) ?? eventTypes[0];
    if (fallback === undefined) return;
    onChange({ eventTypeId: fallback.eventTypeId, kind: fallback.kind });
  }, [currentId, eventTypes, event.eventType, onChange]);

  const handleValueChange = (next: string) => {
    const match = eventTypes.find((t) => t.eventTypeId === next);
    if (match !== undefined) onChange({ eventTypeId: match.eventTypeId, kind: match.kind });
  };

  return (
    <div className='flex flex-col gap-1'>
      <Select value={Option.getOrElse(currentId, () => '')} onValueChange={handleValueChange}>
        <SelectTrigger>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {Option.isSome(archivedCurrent) && (
            <SelectItem value={archivedCurrent.value} disabled>
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  getEventColor(event.eventTypeColor, event.eventType).dot,
                )}
                aria-hidden='true'
              />
              {eventTypeName(event.eventTypeName, event.eventType)}
            </SelectItem>
          )}
          {eventTypes.map((type) => (
            <SelectItem key={type.eventTypeId} value={type.eventTypeId}>
              <span
                className={cn(
                  'size-2 shrink-0 rounded-full',
                  getEventColor(Option.some(type.color), type.kind).dot,
                )}
                aria-hidden='true'
              />
              {Option.getOrElse(type.name, () => eventTypeLabels[type.kind]())}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {/* Archived-but-referenced type: not a validation error — the current selection stays
          usable for this event, it just can't be re-picked for a new one (plan B4). Rendered
          OUTSIDE the SelectItem so it never pollutes that option's accessible name. */}
      {Option.isSome(archivedCurrent) && (
        <p className='text-xs text-muted-foreground'>{tr('eventType_archivedCurrentHint')}</p>
      )}
    </div>
  );
}
