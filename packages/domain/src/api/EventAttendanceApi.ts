import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventId } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

// One row per candidate member for the event — `present` is the resolved pre-tick: the stored
// value when a captain has already confirmed, the live RSVP otherwise. See the server repository
// header for the exact candidate population and the two OR escape hatches.
export class EventAttendanceEntry extends Schema.Class<EventAttendanceEntry>(
  'EventAttendanceEntry',
)({
  teamMemberId: TeamMemberId,
  displayName: Schema.String,
  rsvpResponse: Schema.OptionFromNullOr(RsvpResponse),
  present: Schema.Boolean,
}) {}

export class EventAttendanceResponse extends Schema.Class<EventAttendanceResponse>(
  'EventAttendanceResponse',
)({
  // Whether the caller may PUT a confirmation — the write gate's own result, computed once on
  // the server so the client never re-derives permission logic.
  canConfirm: Schema.Boolean,
  // Set the moment ANY row for this event has been confirmed — confirmation is all-or-nothing
  // (a PUT is a full replace of the confirmed set), so "this event is confirmed" is unambiguous.
  confirmedAt: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  entries: Schema.Array(EventAttendanceEntry),
}) {}

// Payload is a Schema.Struct, never Schema.Class — a Schema.Class payload fails client-side
// encode with a generic toast and an empty Network tab.
export const ConfirmAttendanceRequest = Schema.Struct({
  entries: Schema.Array(
    Schema.Struct({
      teamMemberId: TeamMemberId,
      present: Schema.Boolean,
    }),
  ),
});
export type ConfirmAttendanceRequest = Schema.Schema.Type<typeof ConfirmAttendanceRequest>;

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()(
  'EventAttendanceForbidden',
  {},
) {}

export class EventNotFound extends Schema.TaggedErrorClass<EventNotFound>()(
  'EventAttendanceEventNotFound',
  {},
) {}

// The confirming write's own event guards refused: not a training, cancelled, or not started yet.
export class AttendanceNotConfirmable extends Schema.TaggedErrorClass<AttendanceNotConfirmable>()(
  'EventAttendanceNotConfirmable',
  {},
) {}

export class EventAttendanceApiGroup extends HttpApiGroup.make('eventAttendance')
  .add(
    HttpApiEndpoint.get('getEventAttendance', '/teams/:teamId/events/:eventId/attendance', {
      success: EventAttendanceResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('confirmEventAttendance', '/teams/:teamId/events/:eventId/attendance', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        AttendanceNotConfirmable.pipe(HttpApiSchema.status(409)),
      ],
      payload: ConfirmAttendanceRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  ) {}
