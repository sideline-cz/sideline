import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  recurrenceCheck,
  recurrenceFormDefaults,
  recurrenceFormFields,
  recurrenceLabel,
} from '~/lib/recurrence.js';

const Fields = Schema.Struct(recurrenceFormFields);
const FormSchema = Fields.pipe(Schema.check(recurrenceCheck<typeof Fields.Type>()));
const decode = Schema.decodeUnknownExit(FormSchema);

describe('recurrence form schema', () => {
  it('rejects weekly with no days and accepts it with one', () => {
    expect(decode(recurrenceFormDefaults)._tag).toBe('Failure');
    expect(decode({ ...recurrenceFormDefaults, daysOfWeek: [1] })._tag).toBe('Success');
  });

  it('accepts monthly by date and by weekday whatever the hidden weekly days are', () => {
    expect(
      decode({ ...recurrenceFormDefaults, frequency: 'monthly_by_date', dayOfMonth: 31 })._tag,
    ).toBe('Success');
    expect(
      decode({
        ...recurrenceFormDefaults,
        frequency: 'monthly_by_weekday',
        daysOfWeek: [1, 3],
        weekOfMonth: -1,
        dayOfWeek: 2,
      })._tag,
    ).toBe('Success');
  });

  it('rejects an out-of-range day of month', () => {
    expect(
      decode({ ...recurrenceFormDefaults, frequency: 'monthly_by_date', dayOfMonth: 32 })._tag,
    ).toBe('Failure');
  });
});

describe('recurrenceLabel', () => {
  const base = { daysOfWeek: [], dayOfMonth: Option.none(), weekOfMonth: Option.none() };

  it('labels all four frequencies', () => {
    expect(recurrenceLabel({ ...base, frequency: 'weekly', daysOfWeek: [1] })).toBe('Weekly');
    expect(recurrenceLabel({ ...base, frequency: 'biweekly', daysOfWeek: [1] })).toBe(
      'Every 2 weeks',
    );
    expect(
      recurrenceLabel({ ...base, frequency: 'monthly_by_date', dayOfMonth: Option.some(15) }),
    ).toBe('Monthly on day 15');
    expect(
      recurrenceLabel({
        ...base,
        frequency: 'monthly_by_weekday',
        daysOfWeek: [2],
        weekOfMonth: Option.some(-1),
      }),
    ).toBe('Monthly on the last Tuesday');
  });
});
