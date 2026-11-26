import { Auth, type Event, EventApi, type EventType } from '@sideline/domain';
import { Array, DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership } from '~/api/permissions.js';
import { checkGroupAccess } from '~/api/scoping.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository, type EventWithDetails } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { NotificationsRepository } from '~/repositories/NotificationsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { createEventForMember } from '~/services/EventCreation.js';
import {
  cancelEventForMemberTx,
  emitEventCancelledSideEffects,
  updateEventForMemberTx,
} from '~/services/EventWrites.js';
import { eventAcceptsRsvp } from '~/utils/allDayRsvpWindow.js';

export const markPersonalMessagesDirtyBestEffort = (
  events: ServiceMap.Service.Shape<typeof EventsRepository>,
  eventId: Event.EventId,
) =>
  events
    .markEventPersonalMessagesDirty(eventId)
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('Failed to mark personal messages dirty', cause),
      ),
    );

/**
 * Derives the wire's `eventTypeId`/`eventTypeName`/`eventTypeColor` triple from a joined row's
 * raw, single-level `event_type_id`/`event_type_name`/`event_type_color` columns (see the
 * comment on `EventWithDetails` in `EventsRepository.ts`). `eventTypeName`'s outer `Option`
 * means "a type resolved at all" — `None` only when `event_type_id` itself is `None` — and its
 * inner `Option` carries the real "seeded row, no custom name" signal.
 */
const deriveEventTypeFields = (row: {
  event_type_id: Option.Option<EventType.EventTypeId>;
  event_type_name: Option.Option<string>;
  event_type_color: Option.Option<EventType.EventTypeColor>;
}) => ({
  eventTypeId: row.event_type_id,
  eventTypeName: Option.map(row.event_type_id, () => row.event_type_name),
  eventTypeColor: row.event_type_color,
});

/**
 * Pure row -> DTO map for `EventApi.EventInfo`. `EventWithDetails` is the
 * `Result` of BOTH `EventsRepository.findByTeamId` and `findByIdWithDetails`
 * (see the comment on `EventWithDetails` in `EventsRepository.ts`), so this
 * one function serves both.
 */
export const toEventInfo = (e: EventWithDetails): EventApi.EventInfo =>
  new EventApi.EventInfo({
    eventId: e.id,
    teamId: e.team_id,
    title: e.title,
    eventType: e.event_type,
    trainingTypeName: e.training_type_name,
    ...deriveEventTypeFields(e),
    description: e.description,
    imageUrl: e.image_url,
    locationUrl: e.location_url,
    startAt: e.start_at,
    endAt: e.end_at,
    location: e.location,
    status: e.status,
    seriesId: e.series_id,
    allDay: e.all_day,
    startDate: Option.some(e.start_date),
    endDate: Option.some(e.end_date),
  });

const forbidden = new EventApi.Forbidden();
const notFound = new EventApi.EventNotFound();

/** All-day events are stored at 00:00 in the team's timezone (plan §10). This
 * resolves an IANA zone by name, falling back to `Europe/Prague` rather than
 * throwing — `setZoneNamed` returns `None` for an invalid zone id, and the
 * column has no CHECK constraint, so a migration/seed/operator write can
 * still leave a bad id on `team_settings.timezone`. */
const resolveZoned = (dt: DateTime.Utc, timezone: string): DateTime.Zoned =>
  Option.getOrElse(DateTime.setZoneNamed(dt, timezone), () =>
    DateTime.setZoneNamedUnsafe(dt, 'Europe/Prague'),
  );

/**
 * Anchors the WIRE convention: the web sends all-day instants as
 * `<date>T12:00:00Z`, so the intended date is the instant's **UTC** calendar
 * date — read it with `toPartsUtc` on purpose, then re-anchor those parts to
 * 00:00 in `timezone`. Recipe precedent: `WeeklySummary.ts:92-121`
 * (`weekRangeFor`).
 */
export const anchorAllDay = (dt: DateTime.Utc, timezone: string): DateTime.Utc => {
  const { year, month, day } = DateTime.toPartsUtc(dt);
  const midnight = DateTime.setParts(resolveZoned(dt, timezone), {
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return DateTime.makeUnsafe(midnight.epochMilliseconds);
};

/**
 * Re-anchors a row that is being CONVERTED from timed to all-day. Its stored
 * `start_at`/`end_at` is a real instant, so the intended date is its LOCAL
 * date in `timezone`, not its UTC date — reading the UTC date here would
 * silently move an early-morning-local event (e.g. 23:00Z the previous day in
 * Prague) a day back. Contrast `anchorAllDay`, which decodes the WIRE
 * convention and must read UTC on purpose.
 */
const reanchorFromLocal = (dt: DateTime.Utc, timezone: string): DateTime.Utc => {
  const zoned = resolveZoned(dt, timezone);
  const { year, month, day } = DateTime.toParts(zoned);
  const midnight = DateTime.setParts(zoned, {
    year,
    month,
    day,
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  return DateTime.makeUnsafe(midnight.epochMilliseconds);
};

/**
 * The five-row merge (plan §12 step 4) for `startAt` on `updateEvent`.
 * Branches on what the wire SUPPLIED, never on the merged value — merging
 * `allDay` first and then anchoring the merged `startAt` is non-idempotent
 * and moves an already-anchored row backwards on every partial PATCH that
 * omits `startAt`.
 */
export const mergeAllDayInstant = (
  payloadValue: Option.Option<DateTime.Utc>,
  existingValue: DateTime.Utc,
  mergedAllDay: boolean,
  existingAllDay: boolean,
  timezone: string,
): DateTime.Utc =>
  Option.match(payloadValue, {
    onSome: (v) => (mergedAllDay ? anchorAllDay(v, timezone) : v),
    onNone: () => {
      if (!mergedAllDay) return existingValue;
      // Already anchored — pass through byte-identical, never re-derive it.
      if (existingAllDay) return existingValue;
      // Timed -> all-day transition with no new startAt supplied.
      return reanchorFromLocal(existingValue, timezone);
    },
  });

/** Same three-way split as `mergeAllDayInstant`, for `endAt` — preserves the
 * `Option`-of-`Option` shape: "absent" (outer `None`) and "explicitly cleared
 * to `null`" (outer `Some(None)`) must stay distinct. */
export const mergeAllDayEndAt = (
  payloadValue: Option.Option<Option.Option<DateTime.Utc>>,
  existingValue: Option.Option<DateTime.Utc>,
  mergedAllDay: boolean,
  existingAllDay: boolean,
  timezone: string,
): Option.Option<DateTime.Utc> =>
  Option.match(payloadValue, {
    onSome: (cleared) => Option.map(cleared, (v) => (mergedAllDay ? anchorAllDay(v, timezone) : v)),
    onNone: () => {
      if (!mergedAllDay) return existingValue;
      if (existingAllDay) return existingValue;
      return Option.map(existingValue, (v) => reanchorFromLocal(v, timezone));
    },
  });

export const EventApiLive = HttpApiBuilder.group(Api, 'event', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.bind('teamSettings', () => TeamSettingsRepository.asEffect()),
    Effect.bind('rsvps', () => EventRsvpsRepository.asEffect()),
    Effect.bind('notifications', () => NotificationsRepository.asEffect()),
    Effect.map(({ members, events, groups, trainingTypes, teamSettings, rsvps, notifications }) =>
      handlers
        .handle('listEvents', ({ params: { teamId }, query: { all } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('canCreate', ({ membership }) => hasPermission(membership, 'event:create')),
            Effect.let('canViewAll', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('list', () => events.findEventsByTeamId(teamId)),
            Effect.bind('filteredList', ({ list, membership, canViewAll }) => {
              const wantsAll = Option.getOrElse(all, () => false);
              return wantsAll && canViewAll
                ? Effect.succeed(list)
                : Effect.filter(list, (e) =>
                    checkGroupAccess(groups, membership.id, e.member_group_id),
                  );
            }),
            // Only membership is required here (unlike `getTeamSettings`, gated on
            // `team:manage`) — this is a direct repository read, not the HTTP endpoint, so
            // the majority of captains who can create events but cannot manage settings
            // still get a real zone to label their time inputs with.
            Effect.bind('teamZone', () =>
              teamSettings.findByTeamId(teamId).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => 'Europe/Prague',
                    onSome: (s) => s.timezone,
                  }),
                ),
              ),
            ),
            Effect.map(
              ({ filteredList, canCreate, canViewAll, teamZone }) =>
                new EventApi.EventListResponse({
                  canCreate,
                  canViewAll,
                  timezone: Option.some(teamZone),
                  events: Array.map(filteredList, toEventInfo),
                }),
            ),
          ),
        )
        .handle('createEvent', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('event', ({ membership }) =>
              createEventForMember({ teamId, membership, payload }),
            ),
            Effect.map(
              ({ event }) =>
                new EventApi.EventInfo({
                  eventId: event.id,
                  teamId: event.team_id,
                  title: event.title,
                  eventType: event.event_type,
                  trainingTypeName: Option.none(),
                  // `insert` doesn't join `event_types` (not one of the six render-feeding
                  // queries) — the id is trigger-resolved and returned, but name/color are
                  // left `None` here, same treatment as `trainingTypeName` above.
                  eventTypeId: event.event_type_id,
                  eventTypeName: Option.none(),
                  eventTypeColor: Option.none(),
                  description: event.description,
                  imageUrl: event.image_url,
                  locationUrl: event.location_url,
                  startAt: event.start_at,
                  endAt: event.end_at,
                  location: event.location,
                  status: event.status,
                  seriesId: event.series_id,
                  allDay: event.all_day,
                  startDate: Option.some(event.start_date),
                  endDate: Option.some(event.end_date),
                }),
            ),
          ),
        )
        .handle('getEvent', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('event', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ event }) =>
              event.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            // Check member group access — admins managing the team can view any group's events
            Effect.tap(({ event, membership, isAdmin }) =>
              isAdmin
                ? Effect.void
                : checkGroupAccess(groups, membership.id, event.member_group_id).pipe(
                    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(notFound))),
                  ),
            ),
            // canEdit/canCancel: respect owner group
            Effect.bind('isOwnerGroupMember', ({ event, membership }) =>
              checkGroupAccess(groups, membership.id, event.owner_group_id),
            ),
            Effect.let(
              'canEdit',
              ({ membership, isAdmin, isOwnerGroupMember }) =>
                hasPermission(membership, 'event:edit') && (isAdmin || isOwnerGroupMember),
            ),
            Effect.let(
              'canCancel',
              ({ membership, isAdmin, isOwnerGroupMember }) =>
                hasPermission(membership, 'event:cancel') && (isAdmin || isOwnerGroupMember),
            ),
            Effect.map(
              ({ event, canEdit, canCancel }) =>
                new EventApi.EventDetail({
                  eventId: event.id,
                  teamId: event.team_id,
                  title: event.title,
                  eventType: event.event_type,
                  trainingTypeId: event.training_type_id,
                  trainingTypeName: event.training_type_name,
                  ...deriveEventTypeFields(event),
                  description: event.description,
                  imageUrl: event.image_url,
                  locationUrl: event.location_url,
                  startAt: event.start_at,
                  endAt: event.end_at,
                  location: event.location,
                  status: event.status,
                  createdByName: event.created_by_name,
                  canEdit: canEdit && eventAcceptsRsvp(event, event.timezone, DateTime.nowUnsafe()),
                  canCancel:
                    canCancel && eventAcceptsRsvp(event, event.timezone, DateTime.nowUnsafe()),
                  seriesId: event.series_id,
                  seriesModified: event.series_modified,
                  ownerGroupId: event.owner_group_id,
                  ownerGroupName: event.owner_group_name,
                  memberGroupId: event.member_group_id,
                  memberGroupName: event.member_group_name,
                  allDay: event.all_day,
                  startDate: Option.some(event.start_date),
                  endDate: Option.some(event.end_date),
                  timezone: Option.some(event.timezone),
                }),
            ),
          ),
        )
        .handle('updateEvent', ({ params: { teamId, eventId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('detail', ({ membership }) =>
              updateEventForMemberTx({ teamId, membership, eventId, payload }),
            ),
            Effect.tap(({ detail }) => markPersonalMessagesDirtyBestEffort(events, detail.id)),
            Effect.map(
              ({ detail, membership }) =>
                new EventApi.EventDetail({
                  eventId: detail.id,
                  teamId: detail.team_id,
                  title: detail.title,
                  eventType: detail.event_type,
                  trainingTypeId: detail.training_type_id,
                  trainingTypeName: detail.training_type_name,
                  ...deriveEventTypeFields(detail),
                  description: detail.description,
                  imageUrl: detail.image_url,
                  locationUrl: detail.location_url,
                  startAt: detail.start_at,
                  endAt: detail.end_at,
                  location: detail.location,
                  status: detail.status,
                  createdByName: detail.created_by_name,
                  canEdit:
                    hasPermission(membership, 'event:edit') &&
                    eventAcceptsRsvp(detail, detail.timezone, DateTime.nowUnsafe()),
                  canCancel:
                    hasPermission(membership, 'event:cancel') &&
                    eventAcceptsRsvp(detail, detail.timezone, DateTime.nowUnsafe()),
                  seriesId: detail.series_id,
                  seriesModified: detail.series_modified,
                  ownerGroupId: detail.owner_group_id,
                  ownerGroupName: detail.owner_group_name,
                  memberGroupId: detail.member_group_id,
                  memberGroupName: detail.member_group_name,
                  allDay: detail.all_day,
                  startDate: Option.some(detail.start_date),
                  endDate: Option.some(detail.end_date),
                  timezone: Option.some(detail.timezone),
                }),
            ),
          ),
        )
        .handle('cancelEvent', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.bind('existing', ({ membership }) =>
              cancelEventForMemberTx({ teamId, membership, eventId }),
            ),
            Effect.tap(({ existing }) => emitEventCancelledSideEffects(teamId, existing)),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
