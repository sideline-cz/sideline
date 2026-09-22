import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { EventId } from '~/models/Event.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const EventRsvpId = Schema.String.pipe(Schema.brand('EventRsvpId'));
export type EventRsvpId = typeof EventRsvpId.Type;

export const RsvpResponse = Schema.Literals(['yes', 'no', 'maybe', 'coming_later']);
export type RsvpResponse = typeof RsvpResponse.Type;

// Responses that REQUIRE a non-empty note. `coming_later` needs one so teammates know when to
// expect the player; `maybe` ("Nevím") needs one so an undecided answer says what it depends on.
// Both therefore open the comment modal instead of instant-submitting, and neither may have its
// note cleared. Single source of truth — the server guard, the bot's modal builder and the web
// panel all read this, so a fourth response never picks up a different rule by accident.
export const rsvpResponseRequiresMessage = (response: RsvpResponse): boolean =>
  response === 'coming_later' || response === 'maybe';

export class EventRsvp extends Model.Class<EventRsvp>('EventRsvp')({
  id: Model.Generated(EventRsvpId),
  event_id: EventId,
  team_member_id: TeamMemberId,
  response: RsvpResponse,
  message: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
