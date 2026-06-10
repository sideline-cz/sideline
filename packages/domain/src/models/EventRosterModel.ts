import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { Snowflake } from '~/models/Discord.js';
import { EventId } from '~/models/Event.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const EventRosterId = Schema.String.pipe(Schema.brand('EventRosterId'));
export type EventRosterId = typeof EventRosterId.Type;

export class EventRoster extends Model.Class<EventRoster>('EventRoster')({
  id: Model.Generated(EventRosterId),
  event_id: EventId,
  roster_id: RosterId,
  auto_approve: Schema.Boolean,
  owners_thread_id: Schema.OptionFromNullOr(Snowflake),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export const EventRosterRequestId = Schema.String.pipe(Schema.brand('EventRosterRequestId'));
export type EventRosterRequestId = typeof EventRosterRequestId.Type;

export const EventRosterRequestStatus = Schema.Literals([
  'pending',
  'approved',
  'declined',
  'cancelled',
]);
export type EventRosterRequestStatus = typeof EventRosterRequestStatus.Type;

export const EventRosterRequestSource = Schema.Literals(['auto', 'approval']);
export type EventRosterRequestSource = typeof EventRosterRequestSource.Type;

export class EventRosterRequest extends Model.Class<EventRosterRequest>('EventRosterRequest')({
  id: Model.Generated(EventRosterRequestId),
  event_id: EventId,
  roster_id: RosterId,
  team_member_id: TeamMemberId,
  status: EventRosterRequestStatus,
  source: EventRosterRequestSource,
  was_member_before: Schema.Boolean,
  discord_message_id: Schema.OptionFromNullOr(Snowflake),
  decided_by: Schema.OptionFromNullOr(TeamMemberId),
  decided_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
