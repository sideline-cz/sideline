import { Auth, type EventType, EventTypeApi, type Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Array, Effect, Layer, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { hasPermission, requireMembership, requirePermission } from '~/api/permissions.js';
import { EventTypesRepository } from '~/repositories/EventTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

type EventTypeRowLike = {
  readonly id: EventType.EventTypeId;
  readonly team_id: Team.TeamId;
  readonly name: Option.Option<string>;
  readonly kind: EventType.EventTypeKind;
  readonly color: EventType.EventTypeColor;
  readonly position: number;
};

// Handlers must construct `EventTypeApi.EventTypeInfo` explicitly (never return a repo row
// directly) — `scripts/check-rpc-encoding.mjs` fails the lint otherwise, and a repo row
// type-checks fine here but dies at encode.
export const toEventTypeInfo = (
  row: EventTypeRowLike,
  usageCount: number,
): EventTypeApi.EventTypeInfo =>
  new EventTypeApi.EventTypeInfo({
    eventTypeId: row.id,
    teamId: row.team_id,
    name: row.name,
    kind: row.kind,
    color: row.color,
    position: row.position,
    usageCount,
  });

const forbidden = new EventTypeApi.Forbidden();
const notFound = new EventTypeApi.EventTypeNotFound();

export const EventTypeApiLive = HttpApiBuilder.group(
  Api,
  'eventType',
  (handlers) =>
    Effect.Do.pipe(
      Effect.bind('members', () => TeamMembersRepository.asEffect()),
      Effect.bind('eventTypes', () => EventTypesRepository.asEffect()),
      Effect.map(({ members, eventTypes }) =>
        handlers
          .handle('listEventTypes', ({ params: { teamId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.let('canAdmin', ({ membership }) => hasPermission(membership, 'team:manage')),
              Effect.bind('list', () => eventTypes.findEventTypesByTeamId(teamId)),
              Effect.map(
                ({ list, canAdmin }) =>
                  new EventTypeApi.EventTypeListResponse({
                    canAdmin,
                    eventTypes: Array.map(list, (t) => toEventTypeInfo(t, t.usageCount)),
                  }),
              ),
            ),
          )
          .handle('createEventType', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('eventType', () =>
                eventTypes.insertEventType(teamId, payload.name, payload.kind, payload.color),
              ),
              Effect.map(({ eventType }) => toEventTypeInfo(eventType, 0)),
              Effect.catchTag('EventTypeNameAlreadyTakenError', () =>
                Effect.fail(new EventTypeApi.EventTypeNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed creating event type — no row returned'),
              ),
            ),
          )
          .handle('updateEventType', ({ params: { teamId, eventTypeId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                eventTypes.findEventTypeByIdScoped(eventTypeId, teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(notFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('updated', ({ existing }) =>
                eventTypes.updateEventType(
                  eventTypeId,
                  teamId,
                  Option.orElse(payload.name, () => existing.name),
                  Option.getOrElse(payload.color, () => existing.color),
                ),
              ),
              Effect.bind('usageCount', () => eventTypes.findEventTypesByTeamId(teamId)),
              Effect.map(({ updated, usageCount }) =>
                toEventTypeInfo(
                  updated,
                  Option.match(
                    Array.findFirst(usageCount, (t) => t.id === eventTypeId),
                    { onNone: () => 0, onSome: (t) => t.usageCount },
                  ),
                ),
              ),
              Effect.catchTag('EventTypeNameAlreadyTakenError', () =>
                Effect.fail(new EventTypeApi.EventTypeNameAlreadyTaken()),
              ),
              Effect.catchTag(
                'NoSuchElementError',
                LogicError.withMessage(() => 'Failed updating event type — no row returned'),
              ),
            ),
          )
          .handle('deleteEventType', ({ params: { teamId, eventTypeId } }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('existing', () =>
                eventTypes.findEventTypeByIdScoped(eventTypeId, teamId).pipe(
                  Effect.flatMap(
                    Option.match({
                      onNone: () => Effect.fail(notFound),
                      onSome: Effect.succeed,
                    }),
                  ),
                ),
              ),
              Effect.bind('activeCount', () => eventTypes.countActiveByTeamId(teamId)),
              // Archiving the team's last active type would make event creation impossible —
              // checked BEFORE archiving, never after.
              Effect.tap(({ activeCount }) =>
                activeCount <= 1
                  ? Effect.fail(new EventTypeApi.EventTypeLastRemaining())
                  : Effect.void,
              ),
              Effect.tap(() => eventTypes.archiveEventType(eventTypeId, teamId)),
              Effect.asVoid,
            ),
          )
          .handle('reorderEventTypes', ({ params: { teamId }, payload }) =>
            Effect.Do.pipe(
              Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
              Effect.bind('membership', ({ currentUser }) =>
                requireMembership(members, teamId, currentUser.id, forbidden),
              ),
              Effect.tap(({ membership }) =>
                requirePermission(membership, 'team:manage', forbidden),
              ),
              Effect.bind('active', () => eventTypes.findEventTypesByTeamId(teamId)),
              Effect.tap(({ active }) => {
                const activeIds = new Set(Array.map(active, (t) => t.id));
                const givenIds = new Set(payload.eventTypeIds);
                const noDuplicates = givenIds.size === payload.eventTypeIds.length;
                const sameLength = payload.eventTypeIds.length === active.length;
                const sameMembership = payload.eventTypeIds.every((id) => activeIds.has(id));
                return noDuplicates && sameLength && sameMembership
                  ? Effect.void
                  : Effect.fail(new EventTypeApi.EventTypeReorderInvalid());
              }),
              Effect.tap(() => eventTypes.reorderEventTypes(teamId, payload.eventTypeIds)),
              Effect.asVoid,
            ),
          ),
      ),
    ),
  // Provided internally (never listed as an external `AppLive` dependency of this group) so
  // every pre-existing test that composes its own custom API layer doesn't need a new
  // `EventTypesRepository` mock just because this group exists.
).pipe(Layer.provide(EventTypesRepository.Default));
