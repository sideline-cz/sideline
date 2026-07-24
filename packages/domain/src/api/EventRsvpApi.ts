import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventId } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

// This HTTP surface (used by the web app's HTTP client) is intentionally still
// restricted to the legacy 3-value wire vocabulary (`'yes' | 'no' | 'maybe'`) —
// mirrors `RsvpAttendeeEntry.response` / `UpcomingEventForUserEntry.my_response`
// on the RPC side. `coming_later` is projected down to `'maybe'` by the server
// (see `applications/server/src/utils/rsvpWireProjection.ts`) before it reaches
// here, so already-deployed clients never decode an unrecognized value.
const LegacyRsvpResponse = Schema.Literals(['yes', 'no', 'maybe']);

export class RsvpEntry extends Schema.Class<RsvpEntry>('RsvpEntry')({
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  response: LegacyRsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
}) {}

export class EventRsvpDetail extends Schema.Class<EventRsvpDetail>('EventRsvpDetail')({
  myResponse: Schema.OptionFromNullOr(LegacyRsvpResponse),
  myMessage: Schema.OptionFromNullOr(Schema.String),
  rsvps: Schema.Array(RsvpEntry),
  yesCount: Schema.Number,
  noCount: Schema.Number,
  maybeCount: Schema.Number,
  canRsvp: Schema.Boolean,
  minPlayersThreshold: Schema.Number,
}) {}

export const SubmitRsvpRequest = Schema.Struct({
  response: RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
});
export type SubmitRsvpRequest = Schema.Schema.Type<typeof SubmitRsvpRequest>;

export class EventNotFound extends Schema.TaggedErrorClass<EventNotFound>()(
  'EventRsvpEventNotFound',
  {},
) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('EventRsvpForbidden', {}) {}

export class RsvpDeadlinePassed extends Schema.TaggedErrorClass<RsvpDeadlinePassed>()(
  'RsvpDeadlinePassed',
  {},
) {}

export class RsvpMessageRequired extends Schema.TaggedErrorClass<RsvpMessageRequired>()(
  'EventRsvpMessageRequired',
  {},
) {}

export class NonResponderEntry extends Schema.Class<NonResponderEntry>('NonResponderEntry')({
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
}) {}

export class NonRespondersResponse extends Schema.Class<NonRespondersResponse>(
  'NonRespondersResponse',
)({
  nonResponders: Schema.Array(NonResponderEntry),
}) {}

export class EventRsvpApiGroup extends HttpApiGroup.make('eventRsvp')
  .add(
    HttpApiEndpoint.get('getRsvps', '/teams/:teamId/events/:eventId/rsvps', {
      success: EventRsvpDetail,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.put('submitRsvp', '/teams/:teamId/events/:eventId/rsvp', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        RsvpDeadlinePassed.pipe(HttpApiSchema.status(400)),
        RsvpMessageRequired.pipe(HttpApiSchema.status(400)),
      ],
      payload: SubmitRsvpRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getNonResponders', '/teams/:teamId/events/:eventId/rsvps/non-responders', {
      success: NonRespondersResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  ) {}
