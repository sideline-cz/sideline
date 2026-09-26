import type { EventApi } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { Calendar, Dumbbell, MapPin } from 'lucide-react';
import { EventLocation } from '~/components/atoms/EventLocation.js';
import { useFormatDate } from '~/hooks/useFormatDate.js';
import { formatEventDateRange } from '~/lib/datetime.js';
import { tr } from '~/lib/translations.js';

interface EventFactBarProps {
  eventDetail: EventApi.EventDetail;
}

const todayLocalDate = (): string => {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
};

// Calendar-day delta between two YYYY-MM-DD strings — pure calendar-date subtraction, not an
// instant-based diff. Anchoring both at UTC midnight is just a stable epoch to subtract from;
// no timezone claim is being made about either date.
const calendarDayDelta = (fromIsoDate: string, toIsoDate: string): number => {
  const toUtcMidnight = (iso: string) => {
    const [y, mo, d] = iso.split('-').map(Number);
    return Date.UTC(y, mo - 1, d);
  };
  return Math.round((toUtcMidnight(fromIsoDate) - toUtcMidnight(toIsoDate)) / 86_400_000);
};

/**
 * Compact, full-width fact strip shown between the title and the hero image (plan: event detail
 * redesign). Deliberately does NOT show an RSVP deadline, even though `EventRsvpDetail` now
 * carries `rsvpClosesAt`: a second timestamp up here reads as a second event time, which is the
 * single most likely misread of the lock feature. The deadline lives in `EventRsvpPanel`, next to
 * the buttons it governs.
 *
 * Never parses `formatEventDateRange`'s output — that helper returns four different shapes for
 * `end` depending on `sameDay`/`allDay` (`None`, same-day `HH:mm`, cross-day timed
 * `YYYY-MM-DD HH:mm`, cross-day all-day `YYYY-MM-DD`); this renders those strings verbatim and
 * branches on the flags instead. Parsing them (splitting on a space to recover the date half)
 * throws `RangeError: Invalid time value` on the same-day timed shape — the most common one.
 */
export function EventFactBar({ eventDetail }: EventFactBarProps) {
  const { formatRelative, formatRelativeDays } = useFormatDate();
  const { startDate, startTime, end, sameDay } = formatEventDateRange(
    eventDetail.startAt,
    eventDetail.endAt,
    eventDetail.allDay,
    eventDetail.startDate,
    eventDetail.endDate,
  );
  const start = eventDetail.allDay ? startDate : `${startDate} ${startTime}`;
  const range = sameDay
    ? `${start}${Option.match(end, { onNone: () => '', onSome: (v) => ` – ${v}` })}`
    : `${start}${Option.isSome(end) ? ` → ${end.value}` : ''}`;

  // Only shown for `active` events: a cancelled event must not show a confident countdown, and
  // a `started` event's status chip already says so.
  const relative =
    eventDetail.status === 'active'
      ? eventDetail.allDay
        ? formatRelativeDays(calendarDayDelta(startDate, todayLocalDate()))
        : formatRelative(new Date(Number(DateTime.toEpochMillis(eventDetail.startAt))))
      : null;

  return (
    <div className='rounded-xl border bg-card p-4 text-card-foreground shadow-sm'>
      <div className='flex flex-wrap items-center gap-x-4 gap-y-2 text-sm'>
        <span className='flex items-center gap-1.5'>
          <Calendar className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
          <span className='sr-only'>{tr('event_eventDate')}: </span>
          {range}
          {eventDetail.allDay && (
            <span className='rounded bg-muted px-1 py-0.5 text-[10px]'>
              {tr('event_allDayLabel')}
            </span>
          )}
        </span>

        {relative !== null && (
          <span className='rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground'>
            {relative}
          </span>
        )}

        {Option.isSome(eventDetail.location) && (
          <span className='flex items-center gap-1.5'>
            <MapPin className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
            <span className='sr-only'>{tr('event_location')}: </span>
            <EventLocation text={eventDetail.location.value} url={eventDetail.locationUrl} />
          </span>
        )}

        {eventDetail.eventType === 'training' && Option.isSome(eventDetail.trainingTypeName) && (
          <span className='flex items-center gap-1.5'>
            <Dumbbell className='size-4 shrink-0 text-muted-foreground' aria-hidden='true' />
            <span className='sr-only'>{tr('event_trainingType')}: </span>
            {eventDetail.trainingTypeName.value}
          </span>
        )}
      </div>
    </div>
  );
}
