import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { HexColor } from '~/api/GroupApi.js';
import { EventId } from '~/models/Event.js';
import { EventRosterId, EventRosterRequestId } from '~/models/EventRosterModel.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export { HexColor };

export class EventRosterLink extends Schema.Class<EventRosterLink>('EventRosterLink')({
  eventRosterId: EventRosterId,
  eventId: EventId,
  rosterId: RosterId,
  rosterName: Schema.String,
  autoApprove: Schema.Boolean,
  hasOwnerGroup: Schema.Boolean,
  memberCount: Schema.Number,
  /** Present on PATCH response when a backfill was triggered (auto_approve toggled ON). */
  backfillAdded: Schema.OptionFromNullOr(Schema.Number),
  /** Present on PATCH response when a backfill was triggered (auto_approve toggled ON). */
  backfillCancelled: Schema.OptionFromNullOr(Schema.Number),
}) {}

export const LinkEventRosterRequest = Schema.Struct({
  rosterId: RosterId,
  autoApprove: Schema.Boolean,
});
export type LinkEventRosterRequest = Schema.Schema.Type<typeof LinkEventRosterRequest>;

export const CreateAndLinkRosterRequest = Schema.Struct({
  name: Schema.String,
  color: Schema.OptionFromNullOr(HexColor),
  emoji: Schema.OptionFromNullOr(Schema.String),
  autoApprove: Schema.Boolean,
});
export type CreateAndLinkRosterRequest = Schema.Schema.Type<typeof CreateAndLinkRosterRequest>;

export const PatchEventRosterRequest = Schema.Struct({
  autoApprove: Schema.Boolean,
});
export type PatchEventRosterRequest = Schema.Schema.Type<typeof PatchEventRosterRequest>;

export class PendingRequestView extends Schema.Class<PendingRequestView>('PendingRequestView')({
  requestId: EventRosterRequestId,
  eventId: EventId,
  eventTitle: Schema.String,
  candidateMemberId: TeamMemberId,
  candidateName: Schema.OptionFromNullOr(Schema.String),
  requestedAt: Schema.String,
}) {}

export class ApproveDeclineResult extends Schema.Class<ApproveDeclineResult>(
  'ApproveDeclineResult',
)({
  outcome: Schema.Literals(['approved', 'declined', 'already_member', 'already_handled']),
  memberDisplayName: Schema.OptionFromNullOr(Schema.String),
}) {}

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('EventRosterForbidden', {}) {}

export class EventNotFound extends Schema.TaggedErrorClass<EventNotFound>()(
  'EventRosterEventNotFound',
  {},
) {}

export class RosterNotFound extends Schema.TaggedErrorClass<RosterNotFound>()(
  'EventRosterRosterNotFound',
  {},
) {}

export class AlreadyLinked extends Schema.TaggedErrorClass<AlreadyLinked>()(
  'EventRosterAlreadyLinked',
  {},
) {}

export class RequestNotFound extends Schema.TaggedErrorClass<RequestNotFound>()(
  'EventRosterRequestNotFound',
  {},
) {}

export class RequestAlreadyHandled extends Schema.TaggedErrorClass<RequestAlreadyHandled>()(
  'EventRosterRequestAlreadyHandled',
  {},
) {}

export class EventRosterApiGroup extends HttpApiGroup.make('eventRoster')
  .add(
    HttpApiEndpoint.get('getEventRosterLink', '/teams/:teamId/events/:eventId/roster', {
      success: Schema.OptionFromNullOr(EventRosterLink),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('linkEventRoster', '/teams/:teamId/events/:eventId/roster', {
      success: EventRosterLink.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
        AlreadyLinked.pipe(HttpApiSchema.status(409)),
      ],
      payload: LinkEventRosterRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('createAndLinkRoster', '/teams/:teamId/events/:eventId/roster/create', {
      success: EventRosterLink.pipe(HttpApiSchema.status(201)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        AlreadyLinked.pipe(HttpApiSchema.status(409)),
      ],
      payload: CreateAndLinkRosterRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.patch('patchEventRosterLink', '/teams/:teamId/events/:eventId/roster', {
      success: EventRosterLink,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: PatchEventRosterRequest,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.delete('unlinkEventRoster', '/teams/:teamId/events/:eventId/roster', {
      success: Schema.Void.pipe(HttpApiSchema.status(204)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('listRosterRequests', '/teams/:teamId/rosters/:rosterId/requests', {
      success: Schema.Array(PendingRequestView),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        RosterNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, rosterId: RosterId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'approveRosterRequest',
      '/teams/:teamId/rosters/:rosterId/requests/:requestId/approve',
      {
        success: ApproveDeclineResult,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          RosterNotFound.pipe(HttpApiSchema.status(404)),
          RequestNotFound.pipe(HttpApiSchema.status(404)),
          RequestAlreadyHandled.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, rosterId: RosterId, requestId: EventRosterRequestId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'declineRosterRequest',
      '/teams/:teamId/rosters/:rosterId/requests/:requestId/decline',
      {
        success: ApproveDeclineResult,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          RosterNotFound.pipe(HttpApiSchema.status(404)),
          RequestNotFound.pipe(HttpApiSchema.status(404)),
          RequestAlreadyHandled.pipe(HttpApiSchema.status(409)),
        ],
        params: { teamId: TeamId, rosterId: RosterId, requestId: EventRosterRequestId },
      },
    ).middleware(AuthMiddleware),
  ) {}
