import { Auth, type Event, EventApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { checkCoachScoping, checkGroupAccess, checkTrainingTypeOwnerGroup } from '~/api/scoping.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';
import { eventAcceptsRsvp } from '~/utils/allDayRsvpWindow.js';

const markPersonalMessagesDirtyBestEffort = (
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

const forbidden = new EventApi.Forbidden();
const notFound = new EventApi.EventNotFound();
const notActive = new EventApi.EventNotActive();

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
const anchorAllDay = (dt: DateTime.Utc, timezone: string): DateTime.Utc => {
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
const mergeAllDayInstant = (
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
const mergeAllDayEndAt = (
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
    Effect.map(({ members, events, groups, trainingTypes, teamSettings }) =>
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
            Effect.map(
              ({ filteredList, canCreate, canViewAll }) =>
                new EventApi.EventListResponse({
                  canCreate,
                  canViewAll,
                  events: Array.map(
                    filteredList,
                    (e) =>
                      new EventApi.EventInfo({
                        eventId: e.id,
                        teamId: e.team_id,
                        title: e.title,
                        eventType: e.event_type,
                        trainingTypeName: e.training_type_name,
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
                      }),
                  ),
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
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'event:create', forbidden),
            ),
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
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.tap(({ membership, isAdmin }) =>
              checkCoachScoping(events, membership.id, payload.trainingTypeId, isAdmin, forbidden),
            ),
            Effect.tap(({ membership, isAdmin }) =>
              checkTrainingTypeOwnerGroup(
                trainingTypes,
                groups,
                membership.id,
                payload.trainingTypeId,
                isAdmin,
                forbidden,
                teamId,
              ),
            ),
            // Inherit groups from training type if not provided
            Effect.bind('resolvedGroups', () => {
              const hasOwner = Option.isSome(payload.ownerGroupId);
              const hasMember = Option.isSome(payload.memberGroupId);
              if (hasOwner || hasMember || Option.isNone(payload.trainingTypeId)) {
                return Effect.succeed({
                  ownerGroupId: payload.ownerGroupId,
                  memberGroupId: payload.memberGroupId,
                });
              }
              return trainingTypes.findTrainingTypeById(payload.trainingTypeId.value).pipe(
                Effect.map(
                  Option.match({
                    onNone: () => ({
                      ownerGroupId: payload.ownerGroupId,
                      memberGroupId: payload.memberGroupId,
                    }),
                    onSome: (tt) => ({
                      ownerGroupId: tt.owner_group_id,
                      memberGroupId: tt.member_group_id,
                    }),
                  }),
                ),
              );
            }),
            Effect.bind('event', ({ membership, resolvedGroups, teamZone }) =>
              events.insertEvent({
                teamId,
                trainingTypeId: payload.trainingTypeId,
                eventType: payload.eventType,
                title: payload.title,
                description: payload.description,
                imageUrl: payload.imageUrl,
                startAt: payload.allDay ? anchorAllDay(payload.startAt, teamZone) : payload.startAt,
                endAt: payload.allDay
                  ? Option.map(payload.endAt, (v) => anchorAllDay(v, teamZone))
                  : payload.endAt,
                location: payload.location,
                locationUrl: payload.locationUrl,
                createdBy: membership.id,
                ownerGroupId: resolvedGroups.ownerGroupId,
                memberGroupId: resolvedGroups.memberGroupId,
                allDay: payload.allDay,
              }),
            ),
            Effect.tap(({ event }) =>
              emitTrainingClaimRequestIfApplicable({
                teamId,
                eventId: event.id,
                eventType: event.event_type,
                ownerGroupId: event.owner_group_id,
                title: event.title,
                description: event.description,
                startAt: event.start_at,
                endAt: event.end_at,
                location: event.location,
                locationUrl: event.location_url,
                allDay: event.all_day,
              }),
            ),
            Effect.tap(({ event }) => markPersonalMessagesDirtyBestEffort(events, event.id)),
            Effect.map(
              ({ event }) =>
                new EventApi.EventInfo({
                  eventId: event.id,
                  teamId: event.team_id,
                  title: event.title,
                  eventType: event.event_type,
                  trainingTypeName: Option.none(),
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
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed creating event — no row returned'),
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
            Effect.tap(({ membership }) => requirePermission(membership, 'event:edit', forbidden)),
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
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('existing', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              !eventAcceptsRsvp(existing, existing.timezone, DateTime.nowUnsafe())
                ? Effect.fail(notActive)
                : Effect.void,
            ),
            // Check owner group access
            Effect.tap(({ existing, membership, isAdmin }) =>
              isAdmin
                ? Effect.void
                : checkGroupAccess(groups, membership.id, existing.owner_group_id).pipe(
                    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(forbidden))),
                  ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkCoachScoping(
                events,
                membership.id,
                Option.match(payload.trainingTypeId, {
                  onNone: () => existing.training_type_id,
                  onSome: (v) => v,
                }),
                isAdmin,
                forbidden,
              ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkTrainingTypeOwnerGroup(
                trainingTypes,
                groups,
                membership.id,
                Option.match(payload.trainingTypeId, {
                  onNone: () => existing.training_type_id,
                  onSome: (v) => v,
                }),
                isAdmin,
                forbidden,
                teamId,
              ),
            ),
            Effect.let('mergedLocation', ({ existing }) =>
              Option.getOrElse(payload.location, () => existing.location),
            ),
            Effect.let('mergedLocationUrl', ({ existing }) =>
              Option.getOrElse(payload.locationUrl, () => existing.location_url),
            ),
            Effect.tap(({ mergedLocation, mergedLocationUrl }) =>
              Option.isSome(mergedLocationUrl) && Option.isNone(mergedLocation)
                ? Effect.fail(forbidden)
                : Effect.void,
            ),
            Effect.bind('updated', ({ existing, mergedLocation, mergedLocationUrl, teamZone }) => {
              const mergedAllDay = Option.getOrElse(payload.allDay, () => existing.all_day);
              return events.updateEvent({
                id: eventId,
                title: Option.getOrElse(payload.title, () => existing.title),
                eventType: Option.getOrElse(payload.eventType, () => existing.event_type),
                trainingTypeId: Option.match(payload.trainingTypeId, {
                  onNone: () => existing.training_type_id,
                  onSome: (v) => v,
                }),
                description: Option.match(payload.description, {
                  onNone: () => existing.description,
                  onSome: (v) => v,
                }),
                imageUrl: Option.match(payload.imageUrl, {
                  onNone: () => existing.image_url,
                  onSome: (v) => v,
                }),
                // Five-row merge, plan §12 step 4 — branches on what the wire
                // supplied, never on the merged `allDay` value. See the
                // `mergeAllDayInstant`/`mergeAllDayEndAt` doc comments.
                startAt: mergeAllDayInstant(
                  payload.startAt,
                  existing.start_at,
                  mergedAllDay,
                  existing.all_day,
                  teamZone,
                ),
                endAt: mergeAllDayEndAt(
                  payload.endAt,
                  existing.end_at,
                  mergedAllDay,
                  existing.all_day,
                  teamZone,
                ),
                location: mergedLocation,
                locationUrl: mergedLocationUrl,
                ownerGroupId: Option.match(payload.ownerGroupId, {
                  onNone: () => existing.owner_group_id,
                  onSome: (v) => v,
                }),
                memberGroupId: Option.match(payload.memberGroupId, {
                  onNone: () => existing.member_group_id,
                  onSome: (v) => v,
                }),
                allDay: mergedAllDay,
              });
            }),
            Effect.tap(({ existing }) =>
              Option.isSome(existing.series_id)
                ? events.markEventSeriesModified(eventId)
                : Effect.void,
            ),
            Effect.bind('detail', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
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
                }),
            ),
            Effect.catchTag(
              'NoSuchElementError',
              LogicError.withMessage(() => 'Failed updating event — no row returned'),
            ),
          ),
        )
        .handle('cancelEvent', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.tap(({ membership }) =>
              requirePermission(membership, 'event:cancel', forbidden),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
            Effect.bind('existing', () =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(notFound),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            Effect.tap(({ existing }) =>
              existing.team_id !== teamId ? Effect.fail(notFound) : Effect.void,
            ),
            Effect.tap(({ existing }) =>
              !eventAcceptsRsvp(existing, existing.timezone, DateTime.nowUnsafe())
                ? Effect.fail(notActive)
                : Effect.void,
            ),
            // Check owner group access
            Effect.tap(({ existing, membership, isAdmin }) =>
              isAdmin
                ? Effect.void
                : checkGroupAccess(groups, membership.id, existing.owner_group_id).pipe(
                    Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(forbidden))),
                  ),
            ),
            Effect.tap(({ existing, isAdmin, membership }) =>
              checkCoachScoping(
                events,
                membership.id,
                existing.training_type_id,
                isAdmin,
                forbidden,
              ),
            ),
            Effect.tap(() => events.cancelEvent(eventId)),
            Effect.tap(({ existing }) => markPersonalMessagesDirtyBestEffort(events, existing.id)),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
