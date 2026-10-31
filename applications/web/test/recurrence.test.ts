import { Option, Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  recurrenceCheck,
  recurrenceFields,
  recurrenceFormDefaults,
  recurrenceFormFields,
  recurrenceLabel,
} from '~/lib/recurrence.js';

// Built per call: `recurrenceFormFields()` runs `tr`, which needs the localStorage polyfill that
// test/setup.ts installs in `beforeAll` — after this module's top level has already run.
const decode = (input: unknown) => {
  const Fields = Schema.Struct(recurrenceFormFields());
  return Schema.decodeUnknownExit(Fields.pipe(Schema.check(recurrenceCheck<typeof Fields.Type>())))(
    input,
  );
};

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

describe('recurrenceFields', () => {
  const values = (input: unknown) =>
    Schema.decodeUnknownSync(Schema.Struct(recurrenceFormFields()))(input);

  it('sends only the fields the frequency uses and drops the hidden weekly days', () => {
    const hidden = { ...recurrenceFormDefaults, daysOfWeek: [1, 3], dayOfMonth: 15, dayOfWeek: 2 };
    expect(recurrenceFields(values({ ...hidden, frequency: 'monthly_by_weekday' }))).toEqual({
      daysOfWeek: [2],
      dayOfMonth: Option.none(),
      weekOfMonth: Option.some(1),
    });
    expect(recurrenceFields(values({ ...hidden, frequency: 'monthly_by_date' }))).toEqual({
      daysOfWeek: [],
      dayOfMonth: Option.some(15),
      weekOfMonth: Option.none(),
    });
    expect(recurrenceFields(values({ ...hidden, frequency: 'weekly' }))).toEqual({
      daysOfWeek: [1, 3],
      dayOfMonth: Option.none(),
      weekOfMonth: Option.none(),
    });
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
