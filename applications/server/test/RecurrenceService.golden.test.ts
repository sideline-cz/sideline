// Frozen output of the weekly/biweekly expansion, recorded at 5b008641 before monthly
// recurrence was added. NEVER regenerate this fixture to make a red test green: a diff here
// means weekly or biweekly behaviour changed. It deliberately freezes the biweekly parity
// anchor quirk too; fixing that is its own change and must update the fixture on purpose.
import { DateTime } from 'effect';
import { describe, expect, it } from 'vitest';
import { generateOccurrenceDates } from '~/services/RecurrenceService.js';
import golden from './fixtures/recurrence-golden.json' with { type: 'json' };

describe('generateOccurrenceDates golden weekly/biweekly output', () => {
  it.each(
    golden.map((c) => [`${c.frequency} ${c.daysOfWeek.join(',')} ${c.startDate}→${c.endDate}`, c]),
  )('%s', (_, c) => {
    const dates = generateOccurrenceDates({
      frequency: c.frequency as 'weekly' | 'biweekly',
      daysOfWeek: c.daysOfWeek,
      startDate: DateTime.makeUnsafe(c.startDate),
      endDate: DateTime.makeUnsafe(c.endDate),
    });
    expect(dates.map(DateTime.formatIsoDateUtc)).toEqual(c.expected);
  });
});
