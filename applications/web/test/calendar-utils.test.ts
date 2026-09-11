import { describe, expect, it } from '@effect/vitest';
import type { EventApi } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { buildWeekDays, getWeekdayHeaders } from '~/lib/calendar-utils.js';

describe('getWeekdayHeaders', () => {
  it('returns 7 items', () => {
    const headers = getWeekdayHeaders('en');
    expect(headers).toHaveLength(7);
  });

  it('starts from Monday when locale is "en"', () => {
    const headers = getWeekdayHeaders('en');
    // The first day should be Monday — check it contains "Mon" in English short form
    expect(headers[0].toLowerCase()).toMatch(/^mon/);
  });

  it('returns English weekday names for "en" locale', () => {
    const headers = getWeekdayHeaders('en');
    // English short weekday names starting from Monday
    const expected = ['Mon', 'Tue', 'Wed', 'Thu', 'fri', 'Sat', 'Sun'].map((d) => d.toLowerCase());
    headers.forEach((h) => {
      expect(expected.some((e) => h.toLowerCase().startsWith(e.slice(0, 2)))).toBe(true);
    });
  });

  it('returns Czech weekday names for "cs" locale', () => {
    const headers = getWeekdayHeaders('cs');
    // Czech short weekday names starting from Monday: po, út, st, čt, pá, so, ne
    // Czech short weekday prefixes: po, út, st, čt, pá, so, ne
    // At least verify the first header starts with "po" (pondělí = Monday in Czech)
    expect(headers[0].toLowerCase().startsWith('po')).toBe(true);
    expect(headers).toHaveLength(7);
  });

  it('returns 7 items starting from Monday with "cs" locale', () => {
    const headers = getWeekdayHeaders('cs');
    expect(headers).toHaveLength(7);
    // Monday in Czech short form is "po"
    expect(headers[0].toLowerCase().startsWith('po')).toBe(true);
  });

  it('returns 7 items when no locale is provided', () => {
    const headers = getWeekdayHeaders();
    expect(headers).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// PR 3b — day bucketing (W5, §11.1) reads the derived `startDate`/`endDate`
// projection instead of computing `formatUtcDate(e.startAt)` itself.
//
// `EventInfo.startDate`/`endDate` don't exist yet, so `eventsForDay`'s all-day
// branch still reads `formatUtcDate(e.startAt)` today — these tests reference
// fields that aren't wired through the grid bucketing logic yet and are
// expected to fail until W5 is implemented per the plan.
// ---------------------------------------------------------------------------

const makeAllDayEvent = (overrides: Record<string, unknown>): EventApi.EventInfo =>
  ({
    eventId: 'evt-1',
    teamId: 'team-1',
    title: 'All-day event',
    eventType: 'training',
    trainingTypeName: Option.none(),
    description: Option.none(),
    imageUrl: Option.none(),
    startAt: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
    endAt: Option.none(),
    location: Option.none(),
    locationUrl: Option.none(),
    status: 'active',
    allDay: true,
    seriesId: Option.none(),
    startDate: Option.none(),
    endDate: Option.none(),
    ...overrides,
  }) as unknown as EventApi.EventInfo;

describe('buildWeekDays — all-day event bucketing (PR 3b, W5)', () => {
  // The week of 2026-07-13 (Mon) .. 2026-07-19 (Sun) contains 2026-07-15.
  const REFERENCE = new Date(2026, 6, 15);

  it('places the chip using the derived startDate when present, even for a viewer far from the team', () => {
    // Auckland (+12/+13) is the documented non-neutral case (§17): with the
    // sentinel still noon UTC, the derived team-local date is D+1 relative to
    // the UTC date — the grid must follow `startDate`, not `formatUtcDate`.
    const event = makeAllDayEvent({
      startAt: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
      startDate: Option.some('2026-07-16'),
      endDate: Option.some('2026-07-16'),
    });
    const days = buildWeekDays(REFERENCE, [event]);
    const day15 = days.find((d) => d.date.getDate() === 15);
    const day16 = days.find((d) => d.date.getDate() === 16);
    expect(day15?.events).not.toContainEqual(event);
    expect(day16?.events).toContainEqual(event);
  });

  // The S2 guard (§18 §7.8): an absent `startDate` (rolling-deploy skew, old
  // server) must NOT make the event vanish from the grid. It must fall back to
  // `formatUtcDate(startAt)` — never to a `''` sentinel, which would make
  // `key >= '' && key <= ''` false for every real key and silently drop the
  // event with no error anywhere.
  it('falls back to formatUtcDate(startAt) and still places the chip when startDate is Option.none() (skew guard)', () => {
    const event = makeAllDayEvent({
      startAt: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
      startDate: Option.none(),
      endDate: Option.none(),
    });
    const days = buildWeekDays(REFERENCE, [event]);
    const day15 = days.find((d) => d.date.getDate() === 15);
    // Assert PRESENCE, not absence — a missing-event assertion here is the bug,
    // not the guard (per the plan's explicit warning).
    expect(day15?.events).toContainEqual(event);
  });

  it('anchor-neutral: when startDate equals the UTC date of the noon sentinel, bucketing is unchanged from today', () => {
    const event = makeAllDayEvent({
      startAt: DateTime.makeUnsafe('2026-07-15T12:00:00Z'),
      startDate: Option.some('2026-07-15'),
      endDate: Option.some('2026-07-15'),
    });
    const days = buildWeekDays(REFERENCE, [event]);
    const day15 = days.find((d) => d.date.getDate() === 15);
    expect(day15?.events).toContainEqual(event);
  });
});
