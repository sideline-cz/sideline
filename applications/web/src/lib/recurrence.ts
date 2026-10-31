import { EventSeries } from '@sideline/domain';
import { Option, Schema } from 'effect';
import { tr } from '~/lib/translations.js';

// Form-side recurrence fields shared by the two series forms. `dayOfMonth`, `weekOfMonth` and
// `dayOfWeek` always hold a value; `recurrenceFields` picks the ones the frequency uses.
export const recurrenceFormFields = {
  frequency: EventSeries.RecurrenceFrequency.annotate({ message: tr('validation_invalidOption') }),
  daysOfWeek: Schema.Array(EventSeries.DayOfWeek),
  dayOfMonth: EventSeries.DayOfMonth,
  weekOfMonth: EventSeries.WeekOfMonth,
  dayOfWeek: EventSeries.DayOfWeek,
};

const RecurrenceFormValues = Schema.Struct(recurrenceFormFields);
type RecurrenceFormValues = typeof RecurrenceFormValues.Type;
export type RecurrenceFormInput = typeof RecurrenceFormValues.Encoded;

export const recurrenceFormDefaults: RecurrenceFormInput = {
  frequency: 'weekly',
  daysOfWeek: [],
  dayOfMonth: 1,
  weekOfMonth: 1,
  dayOfWeek: 1,
};

// The flat request shape: `daysOfWeek` is `[]` for by-date and `[dow]` for by-weekday.
export const recurrenceFields = (v: RecurrenceFormValues) => {
  switch (v.frequency) {
    case 'monthly_by_date':
      return {
        daysOfWeek: [],
        dayOfMonth: Option.some(v.dayOfMonth),
        weekOfMonth: Option.none(),
      };
    case 'monthly_by_weekday':
      return {
        daysOfWeek: [v.dayOfWeek],
        dayOfMonth: Option.none(),
        weekOfMonth: Option.some(v.weekOfMonth),
      };
    default:
      return { daysOfWeek: v.daysOfWeek, dayOfMonth: Option.none(), weekOfMonth: Option.none() };
  }
};

export const recurrenceCheck = <T extends RecurrenceFormValues>() =>
  Schema.makeFilter<T>((v) =>
    Option.isSome(EventSeries.toRecurrence({ frequency: v.frequency, ...recurrenceFields(v) }))
      ? true
      : // The monthly fields always hold valid values, so only the weekly days can fail here.
        { path: ['daysOfWeek'], message: tr('validation_required') },
  );

export const DAYS_OF_MONTH = Array.from({ length: 31 }, (_, i) => i + 1);

export const weekOfMonthLabels: Record<EventSeries.WeekOfMonth, () => string> = {
  1: () => tr('event_weekOfMonth_1'),
  2: () => tr('event_weekOfMonth_2'),
  3: () => tr('event_weekOfMonth_3'),
  4: () => tr('event_weekOfMonth_4'),
  [-1]: () => tr('event_weekOfMonth_last'),
};

export const WEEK_OF_MONTH_ORDER: ReadonlyArray<EventSeries.WeekOfMonth> = [1, 2, 3, 4, -1];

const dayInSentenceLabels: Record<number, () => string> = {
  0: () => tr('event_day_inSentence_0'),
  1: () => tr('event_day_inSentence_1'),
  2: () => tr('event_day_inSentence_2'),
  3: () => tr('event_day_inSentence_3'),
  4: () => tr('event_day_inSentence_4'),
  5: () => tr('event_day_inSentence_5'),
  6: () => tr('event_day_inSentence_6'),
};

const frequencyLabels: Record<EventSeries.RecurrenceFrequency, () => string> = {
  weekly: () => tr('event_frequency_weekly'),
  biweekly: () => tr('event_frequency_biweekly'),
  monthly_by_date: () => tr('event_frequency_monthly_by_date'),
  monthly_by_weekday: () => tr('event_frequency_monthly_by_weekday'),
};

export const frequencyLabel = (frequency: EventSeries.RecurrenceFrequency): string =>
  frequencyLabels[frequency]();

export const FREQUENCY_ORDER = EventSeries.RecurrenceFrequency.literals;

interface SeriesRecurrence {
  readonly frequency: EventSeries.RecurrenceFrequency;
  readonly daysOfWeek: ReadonlyArray<number>;
  readonly dayOfMonth: Option.Option<number>;
  readonly weekOfMonth: Option.Option<number>;
}

// "Weekly" / "Every 2 weeks" / "Monthly on day 15" / "Monthly on the last Tuesday".
// A row that fails `toRecurrence` falls back to the bare frequency label.
export const recurrenceLabel = (s: SeriesRecurrence): string =>
  Option.match(EventSeries.toRecurrence(s), {
    onNone: () => frequencyLabel(s.frequency),
    onSome: (r) => {
      switch (r.frequency) {
        case 'monthly_by_date':
          return tr('event_series_monthly_by_date_label', { day: r.dayOfMonth });
        case 'monthly_by_weekday':
          return tr('event_series_monthly_by_weekday_label', {
            ordinal: weekOfMonthLabels[r.weekOfMonth](),
            weekday: dayInSentenceLabels[r.dayOfWeek](),
          });
        default:
          return frequencyLabel(r.frequency);
      }
    },
  });
