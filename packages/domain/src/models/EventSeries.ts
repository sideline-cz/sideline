import { Option, Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingTypeId } from '~/models/TrainingType.js';

export const EventSeriesId = Schema.String.pipe(Schema.brand('EventSeriesId'));
export type EventSeriesId = typeof EventSeriesId.Type;

export const RecurrenceFrequency = Schema.Literals([
  'weekly',
  'biweekly',
  'monthly_by_date',
  'monthly_by_weekday',
]);
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

export const DayOfMonth = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 1, maximum: 31 })),
  Schema.brand('DayOfMonth'),
);
export type DayOfMonth = typeof DayOfMonth.Type;

// -1 = last; distinct from 4 in five-weekday months
export const WeekOfMonth = Schema.Literals([1, 2, 3, 4, -1]);
export type WeekOfMonth = typeof WeekOfMonth.Type;

export type Recurrence =
  | { readonly frequency: 'weekly' | 'biweekly'; readonly daysOfWeek: ReadonlyArray<number> }
  | { readonly frequency: 'monthly_by_date'; readonly dayOfMonth: number }
  | {
      readonly frequency: 'monthly_by_weekday';
      readonly dayOfWeek: number;
      readonly weekOfMonth: WeekOfMonth;
    };

const isDaysOfWeek = Schema.is(DaysOfWeek);
const isDayOfWeek = Schema.is(DayOfWeek);
const isDayOfMonth = Schema.is(DayOfMonth);
const isWeekOfMonth = Schema.is(WeekOfMonth);

// The single place a flat (row or request) shape becomes the `Recurrence` union. Mirrors the
// per-frequency DB CHECK `chk_event_series_recurrence`; anything else is None.
export const toRecurrence = (flat: {
  readonly frequency: string;
  readonly daysOfWeek: ReadonlyArray<number>;
  readonly dayOfMonth: Option.Option<number>;
  readonly weekOfMonth: Option.Option<number>;
}): Option.Option<Recurrence> => {
  const { frequency, daysOfWeek, dayOfMonth, weekOfMonth } = flat;
  switch (frequency) {
    case 'weekly':
    case 'biweekly':
      return isDaysOfWeek(daysOfWeek) && Option.isNone(dayOfMonth) && Option.isNone(weekOfMonth)
        ? Option.some({ frequency, daysOfWeek })
        : Option.none();
    case 'monthly_by_date':
      return daysOfWeek.length === 0 &&
        Option.isSome(dayOfMonth) &&
        isDayOfMonth(dayOfMonth.value) &&
        Option.isNone(weekOfMonth)
        ? Option.some({ frequency, dayOfMonth: dayOfMonth.value })
        : Option.none();
    case 'monthly_by_weekday': {
      const [dayOfWeek] = daysOfWeek;
      return daysOfWeek.length === 1 &&
        isDayOfWeek(dayOfWeek) &&
        Option.isSome(weekOfMonth) &&
        isWeekOfMonth(weekOfMonth.value) &&
        Option.isNone(dayOfMonth)
        ? Option.some({ frequency, dayOfWeek, weekOfMonth: weekOfMonth.value })
        : Option.none();
    }
    default:
      return Option.none();
  }
};

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
  // per-frequency shape enforced by chk_event_series_recurrence + toRecurrence
  days_of_week: Schema.Array(DayOfWeek),
  day_of_month: Schema.OptionFromNullOr(DayOfMonth),
  week_of_month: Schema.OptionFromNullOr(WeekOfMonth),
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
