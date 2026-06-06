import { Auth, EventApi } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { checkCoachScoping, checkGroupAccess, checkTrainingTypeOwnerGroup } from '~/api/scoping.js';
import { EventSyncEventsRepository } from '~/repositories/EventSyncEventsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TrainingTypesRepository } from '~/repositories/TrainingTypesRepository.js';
import { resolveChannel } from '~/services/EventChannelResolver.js';
import { emitTrainingClaimRequestIfApplicable } from '~/services/TrainingClaimEmitter.js';

const forbidden = new EventApi.Forbidden();
const notFound = new EventApi.EventNotFound();
const notActive = new EventApi.EventNotActive();

export const EventApiLive = HttpApiBuilder.group(Api, 'event', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('events', () => EventsRepository.asEffect()),
    Effect.bind('syncEvents', () => EventSyncEventsRepository.asEffect()),
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('trainingTypes', () => TrainingTypesRepository.asEffect()),
    Effect.map(({ members, events, syncEvents, groups, trainingTypes }) =>
      handlers
        .handle('listEvents', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.bind('membership', ({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, forbidden),
            ),
            Effect.let('canCreate', ({ membership }) => hasPermission(membership, 'event:create')),
            Effect.bind('list', () => events.findEventsByTeamId(teamId)),
            Effect.bind('filteredList', ({ list, membership }) =>
              Effect.filter(list, (e) =>
                checkGroupAccess(groups, membership.id, e.member_group_id),
              ),
            ),
            Effect.map(
              ({ filteredList, canCreate }) =>
                new EventApi.EventListResponse({
                  canCreate,
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
            Effect.bind('event', ({ membership, resolvedGroups }) =>
              events.insertEvent({
                teamId,
                trainingTypeId: payload.trainingTypeId,
                eventType: payload.eventType,
                title: payload.title,
                description: payload.description,
                imageUrl: payload.imageUrl,
                startAt: payload.startAt,
                endAt: payload.endAt,
                location: payload.location,
                locationUrl: payload.locationUrl,
                createdBy: membership.id,
                discordTargetChannelId: payload.discordChannelId,
                ownerGroupId: resolvedGroups.ownerGroupId,
                memberGroupId: resolvedGroups.memberGroupId,
                allDay: payload.allDay,
              }),
            ),
            Effect.bind('resolvedChannel', ({ event }) => resolveChannel(teamId, event.id)),
            Effect.tap(({ event, resolvedChannel }) =>
              syncEvents.emitEventCreated(
                teamId,
                event.id,
                event.title,
                event.description,
                event.start_at,
                event.end_at,
                event.location,
                event.event_type,
                resolvedChannel,
                Option.none(),
                Option.none(),
                event.image_url,
                event.location_url,
                event.all_day,
              ),
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
              }),
            ),
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
            // Check member group access
            Effect.tap(({ event, membership }) =>
              checkGroupAccess(groups, membership.id, event.member_group_id).pipe(
                Effect.flatMap((ok) => (ok ? Effect.void : Effect.fail(notFound))),
              ),
            ),
            Effect.let('isAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
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
                  canEdit: canEdit && event.status === 'active',
                  canCancel: canCancel && event.status === 'active',
                  seriesId: event.series_id,
                  seriesModified: event.series_modified,
                  discordChannelId: event.discord_target_channel_id,
                  ownerGroupId: event.owner_group_id,
                  ownerGroupName: event.owner_group_name,
                  memberGroupId: event.member_group_id,
                  memberGroupName: event.member_group_name,
                  allDay: event.all_day,
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
              existing.status !== 'active' ? Effect.fail(notActive) : Effect.void,
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
            Effect.bind('updated', ({ existing, mergedLocation, mergedLocationUrl }) =>
              events.updateEvent({
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
                startAt: Option.getOrElse(payload.startAt, () => existing.start_at),
                endAt: Option.match(payload.endAt, {
                  onNone: () => existing.end_at,
                  onSome: (v) => v,
                }),
                location: mergedLocation,
                locationUrl: mergedLocationUrl,
                discordTargetChannelId: Option.match(payload.discordChannelId, {
                  onNone: () => existing.discord_target_channel_id,
                  onSome: (v) => v,
                }),
                ownerGroupId: Option.match(payload.ownerGroupId, {
                  onNone: () => existing.owner_group_id,
                  onSome: (v) => v,
                }),
                memberGroupId: Option.match(payload.memberGroupId, {
                  onNone: () => existing.member_group_id,
                  onSome: (v) => v,
                }),
                allDay: Option.getOrElse(payload.allDay, () => existing.all_day),
              }),
            ),
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
            Effect.bind('resolvedChannelForUpdate', ({ detail }) =>
              resolveChannel(teamId, detail.id),
            ),
            Effect.tap(({ detail, resolvedChannelForUpdate }) =>
              syncEvents.emitEventUpdated(
                teamId,
                detail.id,
                detail.title,
                detail.description,
                detail.start_at,
                detail.end_at,
                detail.location,
                detail.event_type,
                resolvedChannelForUpdate,
                Option.none(),
                Option.none(),
                detail.image_url,
                detail.location_url,
                detail.all_day,
              ),
            ),
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
                  canEdit: hasPermission(membership, 'event:edit') && detail.status === 'active',
                  canCancel:
                    hasPermission(membership, 'event:cancel') && detail.status === 'active',
                  seriesId: detail.series_id,
                  seriesModified: detail.series_modified,
                  discordChannelId: detail.discord_target_channel_id,
                  ownerGroupId: detail.owner_group_id,
                  ownerGroupName: detail.owner_group_name,
                  memberGroupId: detail.member_group_id,
                  memberGroupName: detail.member_group_name,
                  allDay: detail.all_day,
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
              existing.status !== 'active' ? Effect.fail(notActive) : Effect.void,
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
            Effect.tap(({ existing }) =>
              syncEvents.emitEventCancelled(
                teamId,
                existing.id,
                existing.title,
                existing.description,
                existing.start_at,
                existing.end_at,
                existing.location,
                existing.event_type,
                Option.none(),
                Option.none(),
                Option.none(),
                existing.location_url,
              ),
            ),
            Effect.asVoid,
          ),
        ),
    ),
  ),
);
