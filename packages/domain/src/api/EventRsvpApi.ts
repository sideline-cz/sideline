import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventId } from '~/models/Event.js';
import { RsvpResponse } from '~/models/EventRsvp.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class RsvpEntry extends Schema.Class<RsvpEntry>('RsvpEntry')({
  teamMemberId: TeamMemberId,
  memberName: Schema.OptionFromNullOr(Schema.String),
  username: Schema.OptionFromNullOr(Schema.String),
  response: RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
  /** Resolved display name (profile name → Discord nickname → Discord display name → username). */
  displayName: Schema.String,
}) {}

export class EventRsvpDetail extends Schema.Class<EventRsvpDetail>('EventRsvpDetail')({
  myResponse: Schema.OptionFromNullOr(RsvpResponse),
  myMessage: Schema.OptionFromNullOr(Schema.String),
  rsvps: Schema.Array(RsvpEntry),
  yesCount: Schema.Number,
  noCount: Schema.Number,
  maybeCount: Schema.Number,
  comingLaterCount: Schema.Number.pipe(Schema.withDecodingDefaultKey(() => 0)),
  canRsvp: Schema.Boolean,
  // The instant RSVPs close, when a lock applies AND this member is actually invited. `None`
  // both when no lock applies and when the viewer is outside the event's `member_group` — a
  // member who is simply not invited must never be told "RSVPs closed at 18:00" while they are
  // wide open for everyone else. `OptionFromOptionalKey`, matching `startDate`/`timezone` on
  // `EventApi`, so an older server's payload degrades to today's UI rather than a decode
  // failure: web bundles a FROZEN copy of this schema.
  rsvpClosesAt: Schema.OptionFromOptionalKey(Schemas.DateTimeFromIsoString),
  minPlayersThreshold: Schema.Number,
}) {}

export const SubmitRsvpRequest = Schema.Struct({
  response: RsvpResponse,
  // The note. `null` leaves whatever note is already stored untouched (so an idempotent
  // re-submit of the same response keeps it); a blank string clears it. This surface has no
  // separate `clearMessage` flag like the RPC one — blank *is* the clear signal, and a clear
  // on a `coming_later` RSVP is rejected with `RsvpMessageRequired`. A line comment, not JSDoc:
  // the barrel codegen hoists a file's first doc block onto its `export * as` re-export.
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

// The request is well-formed; the actor just hasn't finished onboarding yet. 403, matching the
// `Forbidden` family (AGENTS.md → "HTTP API Error Tags"), not 400.
export class RsvpProfileIncomplete extends Schema.TaggedErrorClass<RsvpProfileIncomplete>()(
  'EventRsvpProfileIncomplete',
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
        RsvpProfileIncomplete.pipe(HttpApiSchema.status(403)),
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
