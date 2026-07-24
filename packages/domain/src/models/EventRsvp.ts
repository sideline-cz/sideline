import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { EventId } from '~/models/Event.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const EventRsvpId = Schema.String.pipe(Schema.brand('EventRsvpId'));
export type EventRsvpId = typeof EventRsvpId.Type;

export const RsvpResponse = Schema.Literals(['yes', 'no', 'maybe', 'coming_later']);
export type RsvpResponse = typeof RsvpResponse.Type;

export class EventRsvp extends Model.Class<EventRsvp>('EventRsvp')({
  id: Model.Generated(EventRsvpId),
  event_id: EventId,
  team_member_id: TeamMemberId,
  response: RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
