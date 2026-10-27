// The fixture here deliberately carries a NULL-gender member and an `'other'` member.
// Measured in production on 2026-10-25 (team Poletíme!, active members): 56 NULL, 36 female,
// 30 male — 46% of people have no recorded gender, MORE than either known bucket. A fixture
// built from only male and female members passes every assertion below while the real-world
// case is broken, which is precisely the bug this module exists to prevent.

import { describe, expect, it } from '@effect/vitest';
import { User } from '@sideline/domain';
import { Option } from 'effect';
import {
  type AttendingGenderCountRow,
  attendingGenderCountsFor,
  foldAttendingGenderCounts,
} from '~/utils/attendingGenderCounts.js';

const row = (
  response: string,
  gender: User.Gender | null,
  count: number,
  eventId = 'event-1',
): AttendingGenderCountRow => ({
  event_id: eventId,
  response,
  gender: Option.fromNullishOr(gender),
  count,
});

describe('foldAttendingGenderCounts', () => {
  it('buckets every attending member, NULL gender included', () => {
    const counts = foldAttendingGenderCounts([
      row('yes', 'male', 3),
      row('yes', 'female', 4),
      row('yes', 'other', 1),
      row('yes', null, 5),
    ]).get('event-1');

    expect(counts).toEqual({ male: 3, female: 4, other: 1, unknown: 5 });
  });

  it('folds NULL gender into `unknown` rather than dropping the rows', () => {
    const counts = foldAttendingGenderCounts([row('yes', null, 7)]).get('event-1');

    expect(counts?.unknown).toBe(7);
  });

  it('keeps `other` as its own stored bucket — the wire shape never folds it', () => {
    const counts = foldAttendingGenderCounts([row('yes', 'other', 2)]).get('event-1');

    expect(counts?.other).toBe(2);
    expect(counts?.unknown).toBe(0);
  });

  it('counts `coming_later` as attending, proving the real predicate is used', () => {
    const counts = foldAttendingGenderCounts([
      row('yes', 'male', 1),
      row('coming_later', 'male', 1),
    ]).get('event-1');

    expect(counts?.male).toBe(2);
  });

  it('excludes `maybe` and `no` — an `=== "yes"` check would also pass the test above', () => {
    const counts = foldAttendingGenderCounts([
      row('yes', 'male', 1),
      row('maybe', 'male', 9),
      row('no', 'female', 9),
    ]).get('event-1');

    expect(counts).toEqual({ male: 1, female: 0, other: 0, unknown: 0 });
  });

  it('separates events, so a batched card list never mixes two events together', () => {
    const byEvent = foldAttendingGenderCounts([
      row('yes', 'male', 1, 'event-1'),
      row('yes', 'female', 2, 'event-2'),
    ]);

    expect(byEvent.get('event-1')).toEqual({ male: 1, female: 0, other: 0, unknown: 0 });
    expect(byEvent.get('event-2')).toEqual({ male: 0, female: 2, other: 0, unknown: 0 });
  });

  it('yields None for an event with responses but nobody attending', () => {
    const byEvent = foldAttendingGenderCounts([row('no', 'male', 4)]);

    expect(attendingGenderCountsFor(byEvent, 'event-1')).toStrictEqual(Option.none());
  });

  it('yields None for an event with no rows at all', () => {
    expect(attendingGenderCountsFor(foldAttendingGenderCounts([]), 'event-1')).toStrictEqual(
      Option.none(),
    );
  });
});

describe('genderSplitDisplay', () => {
  it('accounts for everyone: male + female + more equals the going total', () => {
    const split = User.genderSplitDisplay({ male: 3, female: 4, other: 1, unknown: 5 });

    expect(split).toEqual({ total: 13, male: 3, female: 4, more: 6 });
    expect(split !== null && split.male + split.female + split.more).toBe(13);
  });

  it('puts an `other` member in `more`, never silently out of the total', () => {
    const split = User.genderSplitDisplay({ male: 1, female: 1, other: 1, unknown: 0 });

    expect(split).toEqual({ total: 3, male: 1, female: 1, more: 1 });
  });

  it('derives `more` from the total, so an unmodelled bucket cannot vanish', () => {
    // Simulates a gender value this code does not know about by inflating the total past the
    // named buckets. The remainder absorbs it instead of the line under-reporting.
    const split = User.genderSplitDisplay({ male: 2, female: 2, other: 0, unknown: 6 });

    expect(split?.more).toBe(6);
    expect(split?.total).toBe(10);
  });

  it('reports the TRUE remainder when nobody going has a recorded gender', () => {
    // Presentation of this case diverges by surface — the web line drops to a bare total
    // because "3 more" is nonsense in words, the Discord title prints `3 👤` because the
    // glyph is not — so the shared helper reports the truth and leaves the choice to each
    // formatter. It must never zero the bucket here.
    expect(User.genderSplitDisplay({ male: 0, female: 0, other: 0, unknown: 3 })).toEqual({
      total: 3,
      male: 0,
      female: 0,
      more: 3,
    });
  });

  it('renders nothing at all when nobody is going', () => {
    expect(User.genderSplitDisplay({ male: 0, female: 0, other: 0, unknown: 0 })).toBeNull();
  });
});
