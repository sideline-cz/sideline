import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { EventSeriesId } from '~/models/EventSeries.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

export const EventId = Schema.String.pipe(Schema.brand('EventId'));
export type EventId = typeof EventId.Type;

export const EventType = Schema.Literals([
  'training',
  'match',
  'tournament',
  'meeting',
  'social',
  'other',
]);
export type EventType = typeof EventType.Type;

export const EventStatus = Schema.Literals(['active', 'cancelled', 'started']);
export type EventStatus = typeof EventStatus.Type;

export class Event extends Model.Class<Event>('Event')({
  id: Model.Generated(EventId),
  team_id: TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingTypeId),
  event_type: EventType,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromDate,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromDate),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  owner_group_id: Schema.OptionFromNullOr(GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupId),
  series_id: Schema.OptionFromNullOr(EventSeriesId),
  series_modified: Schema.Boolean,
  status: Model.FieldExcept(['update'])(EventStatus),
  all_day: Schema.Boolean,
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
