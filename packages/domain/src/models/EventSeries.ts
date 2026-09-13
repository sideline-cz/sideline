import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

export const EventSeriesId = Schema.String.pipe(Schema.brand('EventSeriesId'));
export type EventSeriesId = typeof EventSeriesId.Type;

export const RecurrenceFrequency = Schema.Literals(['weekly', 'biweekly']);
export type RecurrenceFrequency = typeof RecurrenceFrequency.Type;

export const DayOfWeek = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 6 })),
  Schema.brand('DayOfWeek'),
);
export type DayOfWeek = typeof DayOfWeek.Type;

export const DaysOfWeek = Schema.Array(DayOfWeek).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(7)),
);
export type DaysOfWeek = typeof DaysOfWeek.Type;

export const EventSeriesStatus = Schema.Literals(['active', 'cancelled']);
export type EventSeriesStatus = typeof EventSeriesStatus.Type;

export class EventSeries extends Model.Class<EventSeries>('EventSeries')({
  id: Model.Generated(EventSeriesId),
  team_id: TeamId,
  training_type_id: Schema.OptionFromNullOr(TrainingTypeId),
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  start_time: Schema.String,
  /** `HH:MM` wall clock in the team's `team_settings.timezone`, resolved to an instant per occurrence. NOT UTC. */
  end_time: Schema.OptionFromNullOr(Schema.String),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  frequency: RecurrenceFrequency,
  days_of_week: DaysOfWeek,
  start_date: Schema.instanceOf(Date),
  end_date: Schema.OptionFromNullOr(Schema.instanceOf(Date)),
  owner_group_id: Schema.OptionFromNullOr(GroupId),
  member_group_id: Schema.OptionFromNullOr(GroupId),
  /** `TRUE` = `start_time`/`end_time` are wall clock in the team's timezone; `FALSE` = UTC time-of-day (the pre-#650 semantics). */
  times_are_team_local: Schema.Boolean,
  status: Model.FieldExcept(['update'])(EventSeriesStatus),
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
