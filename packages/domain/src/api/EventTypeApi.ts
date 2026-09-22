import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventTypeColor, EventTypeId, EventTypeKind, EventTypeName } from '~/models/EventType.js';
import { TeamId } from '~/models/Team.js';

export class EventTypeInfo extends Schema.Class<EventTypeInfo>('EventTypeInfo')({
  eventTypeId: EventTypeId,
  teamId: TeamId,
  // None = render the built-in translated label for `kind`.
  name: Schema.OptionFromNullOr(EventTypeName),
  kind: EventTypeKind,
  color: EventTypeColor,
  position: Schema.Number,
  usageCount: Schema.Number,
}) {}

export class EventTypeListResponse extends Schema.Class<EventTypeListResponse>(
  'EventTypeListResponse',
)({
  canAdmin: Schema.Boolean,
  // Active types only — an archived-but-referenced type is handled client-side, not returned
  // here.
  eventTypes: Schema.Array(EventTypeInfo),
}) {}

// Payloads are Schema.Struct, never Schema.Class — a Schema.Class payload fails client-side
// encode with a generic toast and an empty Network tab (commit d72fa1be).
export const CreateEventTypeRequest = Schema.Struct({
  name: EventTypeName,
  kind: EventTypeKind,
  color: EventTypeColor,
});
export type CreateEventTypeRequest = Schema.Schema.Type<typeof CreateEventTypeRequest>;

// No `kind` field — kind is immutable once a type exists (see AGENTS.md ownership statement).
export const UpdateEventTypeRequest = Schema.Struct({
  name: Schema.OptionFromOptional(EventTypeName),
  color: Schema.OptionFromOptional(EventTypeColor),
});
export type UpdateEventTypeRequest = Schema.Schema.Type<typeof UpdateEventTypeRequest>;

export const ReorderEventTypesRequest = Schema.Struct({
  eventTypeIds: Schema.Array(EventTypeId),
});
export type ReorderEventTypesRequest = Schema.Schema.Type<typeof ReorderEventTypesRequest>;

export class EventTypeNotFound extends Schema.TaggedErrorClass<EventTypeNotFound>()(
  'EventTypeNotFound',
  {},
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('EventTypeForbidden', {}) {}

export class EventTypeNameAlreadyTaken extends Schema.TaggedErrorClass<EventTypeNameAlreadyTaken>()(
  'EventTypeNameAlreadyTaken',
  {},
) {}

// The team's last active type — archiving it would make event creation impossible.
export class EventTypeLastRemaining extends Schema.TaggedErrorClass<EventTypeLastRemaining>()(
  'EventTypeLastRemaining',
  {},
) {}

export class EventTypeReorderInvalid extends Schema.TaggedErrorClass<EventTypeReorderInvalid>()(
  'EventTypeReorderInvalid',
  {},
) {}

export class EventTypeApiGroup extends HttpApiGroup.make('eventType')
  .add(
    // Membership-only — the event pickers can load it without a team:manage-gated second call.
    HttpApiEndpoint.get('listEventTypes', '/teams/:teamId/event-types', {
      success: EventTypeListResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createEventType', '/teams/:teamId/event-types', {
      success: EventTypeInfo.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventTypeNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateEventTypeRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('updateEventType', '/teams/:teamId/event-types/:eventTypeId', {
      success: EventTypeInfo,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventTypeNotFound.pipe(HttpApiSchema.status(404)),
        EventTypeNameAlreadyTaken.pipe(HttpApiSchema.status(409)),
      ],
      payload: UpdateEventTypeRequest,
      params: { teamId: TeamId, eventTypeId: EventTypeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    // Archives, never hard-deletes — see AGENTS.md ownership statement.
    HttpApiEndpoint.delete('deleteEventType', '/teams/:teamId/event-types/:eventTypeId', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventTypeNotFound.pipe(HttpApiSchema.status(404)),
        EventTypeLastRemaining.pipe(HttpApiSchema.status(409)),
      ],
      params: { teamId: TeamId, eventTypeId: EventTypeId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('reorderEventTypes', '/teams/:teamId/event-types/reorder', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventTypeReorderInvalid.pipe(HttpApiSchema.status(400)),
      ],
      payload: ReorderEventTypesRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  ) {}
