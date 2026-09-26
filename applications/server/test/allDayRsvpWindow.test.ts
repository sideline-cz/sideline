// T1 — the RSVP lock gate, in isolation.
//
// `eventAcceptsRsvp` had no unit test before this file (grep found it only in
// comments), so this is net-new coverage, not a regression suite. What it pins:
//
//   * `eventRsvpOpen` is `eventAcceptsRsvp && <not past the lock>` — strictly
//     narrower, never wider, on either branch (case 13).
//   * `rsvpClosesAtOf` is the ONE place `start_at - hours` is computed. Four
//     surfaces render it and the gate enforces it; case 16 pins that they can
//     never disagree.
//   * The three reachable lock states: `none` (no lock at all, today's
//     behaviour byte for byte), `some(0)` (lock exactly at start), and any
//     `some(n)`. On all-day events `none` and `some(0)` are DAYS apart, not
//     an instant apart — cases 7 and 10.
//
// Everything here is pure: `now` is a parameter, never `DateTime.nowUnsafe()`,
// so the date literals below have no expiry date.

import { describe, expect, it } from '@effect/vitest';
import type { Event } from '@sideline/domain';
import { DateTime, Option } from 'effect';
import { eventAcceptsRsvp, eventRsvpOpen, rsvpClosesAtOf } from '~/utils/allDayRsvpWindow.js';

const utc = (iso: string): DateTime.Utc => DateTime.toUtc(DateTime.makeUnsafe(iso));

const PRAGUE = 'Europe/Prague';

type Fixture = {
  readonly all_day: boolean;
  readonly status: Event.EventStatus;
  readonly start_at: DateTime.Utc;
  readonly end_at: Option.Option<DateTime.Utc>;
  readonly rsvp_lock_hours_before?: Option.Option<number>;
};

// A plain timed event, far enough out that nothing here is clock-sensitive.
const T = utc('2029-06-15T18:00:00.000Z');

const timed = (lock?: Option.Option<number>, status: Event.EventStatus = 'active'): Fixture => ({
  all_day: false,
  status,
  start_at: T,
  end_at: Option.none(),
  ...(lock === undefined ? {} : { rsvp_lock_hours_before: lock }),
});

// Prague is UTC+1 in January, so no DST hides inside these numbers.
// Sat 2029-01-06 00:00 local .. through the end of Sun 2029-01-07 local.
const ALL_DAY_START = utc('2029-01-05T23:00:00.000Z'); // Sat 00:00 Prague — the anchor
const ALL_DAY_END = utc('2029-01-06T23:00:00.000Z'); // Sun 00:00 Prague
const THU_2300 = utc('2029-01-04T22:00:00.000Z');
const FRI_0000 = utc('2029-01-04T23:00:00.000Z'); // == ALL_DAY_START - 24h
const FRI_0100 = utc('2029-01-05T00:00:00.000Z');
const SAT_1200 = utc('2029-01-06T11:00:00.000Z');
const MON_0000 = utc('2029-01-07T23:00:00.000Z'); // endOfLastLocalDay

const allDay = (lock?: Option.Option<number>, status: Event.EventStatus = 'started'): Fixture => ({
  all_day: true,
  status,
  start_at: ALL_DAY_START,
  end_at: Option.some(ALL_DAY_END),
  ...(lock === undefined ? {} : { rsvp_lock_hours_before: lock }),
});

const minus = (at: DateTime.Utc, ms: number): DateTime.Utc =>
  DateTime.toUtc(DateTime.makeUnsafe(DateTime.toEpochMillis(at) - ms));

describe('eventRsvpOpen — no lock configured', () => {
  it('case 1: timed, `none` is byte-for-byte `eventAcceptsRsvp`', () => {
    for (const now of [minus(T, 60_000), T, DateTime.add(T, { minutes: 1 })]) {
      expect(eventRsvpOpen(timed(Option.none()), PRAGUE, now)).toBe(
        eventAcceptsRsvp(timed(Option.none()), PRAGUE, now),
      );
    }
    // Non-vacuity: the three instants must not all agree, or the equality
    // above proves nothing.
    expect(eventRsvpOpen(timed(Option.none()), PRAGUE, minus(T, 60_000))).toBe(true);
    expect(eventRsvpOpen(timed(Option.none()), PRAGUE, T)).toBe(true);
    expect(eventRsvpOpen(timed(Option.none()), PRAGUE, DateTime.add(T, { minutes: 1 }))).toBe(
      false,
    );
  });

  it('case 2: all-day `started` on its own local day, `none` keeps the end-of-day grace', () => {
    const e = allDay(Option.none());
    expect(eventRsvpOpen(e, PRAGUE, SAT_1200)).toBe(eventAcceptsRsvp(e, PRAGUE, SAT_1200));
    expect(eventRsvpOpen(e, PRAGUE, SAT_1200)).toBe(true);
    expect(eventRsvpOpen(e, PRAGUE, MON_0000)).toBe(false);
  });

  it('case 3: an ABSENT `rsvp_lock_hours_before` reads as no lock and must not throw', () => {
    // `EventRsvp.test.ts` mocks the repository `as any` over hand-built event
    // objects, so this field is `undefined` there. `Option.match(undefined)`
    // throws — the coalesce in `rsvpClosesAtOf` is load-bearing, not styling.
    const e = timed(undefined);
    expect(() => eventRsvpOpen(e, PRAGUE, minus(T, 60_000))).not.toThrow();
    expect(eventRsvpOpen(e, PRAGUE, minus(T, 60_000))).toBe(
      eventAcceptsRsvp(e, PRAGUE, minus(T, 60_000)),
    );
    expect(eventRsvpOpen(e, PRAGUE, T)).toBe(eventAcceptsRsvp(e, PRAGUE, T));
    expect(rsvpClosesAtOf(e)).toStrictEqual(Option.none());
  });
});

describe('eventRsvpOpen — timed events with a lock', () => {
  it('case 4: 24h lock, an hour before the window opens → still open', () => {
    expect(eventRsvpOpen(timed(Option.some(24)), PRAGUE, DateTime.subtract(T, { hours: 25 }))).toBe(
      true,
    );
  });

  it('case 5: 24h lock, at exactly T-24h → CLOSED (strict)', () => {
    expect(eventRsvpOpen(timed(Option.some(24)), PRAGUE, DateTime.subtract(T, { hours: 24 }))).toBe(
      false,
    );
  });

  it('case 6: 24h lock, inside the window → closed', () => {
    expect(eventRsvpOpen(timed(Option.some(24)), PRAGUE, DateTime.subtract(T, { hours: 23 }))).toBe(
      false,
    );
  });

  it('case 7: `some(0)` differs from `none` at exactly `now == start_at`', () => {
    const instants = [minus(T, 1_000), T, DateTime.add(T, { seconds: 1 })] as const;
    const withNone = instants.map((now) => eventRsvpOpen(timed(Option.none()), PRAGUE, now));
    const withZero = instants.map((now) => eventRsvpOpen(timed(Option.some(0)), PRAGUE, now));

    // `none` mirrors the SQL `start_at >= now()` — inclusive at the instant.
    expect(withNone).toStrictEqual([true, true, false]);
    // `0` means "before the deadline", and the deadline IS the start — strict.
    expect(withZero).toStrictEqual([true, false, false]);
  });
});

describe('eventRsvpOpen — all-day events', () => {
  it('case 8: Sat–Sun all-day, 24h lock, Thursday 23:00 local → still open', () => {
    expect(eventRsvpOpen(allDay(Option.some(24), 'active'), PRAGUE, THU_2300)).toBe(true);
  });

  it('case 9: the §1d surprise — the same event is LOCKED at Friday 01:00 local', () => {
    // A 24h lock on a Saturday all-day event closes RSVPs at Friday 00:00
    // local — ~2 days before anyone plays — because an all-day `start_at` is
    // local midnight of day 1. This is deliberate and must be pinned.
    expect(eventRsvpOpen(allDay(Option.some(24), 'active'), PRAGUE, FRI_0100)).toBe(false);
    expect(rsvpClosesAtOf(allDay(Option.some(24)))).toStrictEqual(Option.some(FRI_0000));
  });

  it('case 10: `some(0)` vs `none` on all-day are DAYS apart, not an instant', () => {
    // `none` keeps the end-of-last-local-day grace; `0` anchors on local
    // midnight of day 1 and drops it.
    expect(eventRsvpOpen(allDay(Option.none()), PRAGUE, SAT_1200)).toBe(true);
    expect(eventRsvpOpen(allDay(Option.some(0)), PRAGUE, SAT_1200)).toBe(false);
  });

  it('case 11: 24h lock, mid-event → closed', () => {
    expect(eventRsvpOpen(allDay(Option.some(24)), PRAGUE, SAT_1200)).toBe(false);
  });

  it('case 15: an invalid IANA timezone falls back to Europe/Prague rather than throwing', () => {
    for (const lock of [Option.none(), Option.some(24)] as const) {
      expect(() => eventRsvpOpen(allDay(lock), 'Not/AZone', SAT_1200)).not.toThrow();
      expect(eventRsvpOpen(allDay(lock), 'Not/AZone', SAT_1200)).toBe(
        eventRsvpOpen(allDay(lock), PRAGUE, SAT_1200),
      );
    }
  });
});

describe('eventRsvpOpen — status', () => {
  it('case 12: a cancelled event is never open, with or without a lock', () => {
    const before = DateTime.subtract(T, { hours: 48 });
    expect(eventRsvpOpen(timed(Option.none(), 'cancelled'), PRAGUE, before)).toBe(false);
    expect(eventRsvpOpen(timed(Option.some(24), 'cancelled'), PRAGUE, before)).toBe(false);
    expect(eventRsvpOpen(allDay(Option.none(), 'cancelled'), PRAGUE, THU_2300)).toBe(false);
    expect(eventRsvpOpen(allDay(Option.some(24), 'cancelled'), PRAGUE, THU_2300)).toBe(false);
  });
});

describe('eventRsvpOpen is strictly narrower than eventAcceptsRsvp', () => {
  it('case 13: over a grid of statuses × all_day × offsets × locks, never open where the base gate is shut', () => {
    const statuses: ReadonlyArray<Event.EventStatus> = ['active', 'cancelled', 'started'];
    const locks = [
      Option.none(),
      Option.some(0),
      Option.some(1),
      Option.some(336),
    ] as ReadonlyArray<Option.Option<number>>;
    const offsetsHours = [-400, -337, -336, -48, -24, -1, 0, 1, 24, 400];

    let sawOpen = false;
    let sawNarrowed = false;

    for (const status of statuses) {
      for (const all_day of [false, true]) {
        for (const lock of locks) {
          const event: Fixture = all_day ? { ...allDay(lock, status) } : { ...timed(lock, status) };
          for (const offset of offsetsHours) {
            const now = DateTime.add(event.start_at, { hours: offset });
            const base = eventAcceptsRsvp(event, PRAGUE, now);
            const narrowed = eventRsvpOpen(event, PRAGUE, now);
            if (narrowed) sawOpen = true;
            if (base && !narrowed) sawNarrowed = true;
            expect(
              narrowed && !base,
              `eventRsvpOpen widened the gate: status=${status} all_day=${all_day} lock=${JSON.stringify(lock)} offset=${offset}h`,
            ).toBe(false);
          }
        }
      }
    }

    // Non-vacuity in both directions: the grid must contain rows that are open
    // and rows the lock actually narrows, or the implication above is trivial.
    expect(sawOpen).toBe(true);
    expect(sawNarrowed).toBe(true);
  });
});

describe('rsvpClosesAtOf', () => {
  it('case 14: DST-crossing — the offset is 24 ABSOLUTE hours, not "same wall clock yesterday"', () => {
    // Prague springs forward on 2029-03-25; `start_at - 24h` crosses it.
    const start = utc('2029-03-25T12:00:00.000Z');
    const closes = rsvpClosesAtOf({ start_at: start, rsvp_lock_hours_before: Option.some(24) });
    expect(Option.isSome(closes)).toBe(true);
    expect(DateTime.toEpochMillis(Option.getOrThrow(closes))).toBe(
      DateTime.toEpochMillis(start) - 24 * 60 * 60 * 1000,
    );
    expect(DateTime.formatIso(Option.getOrThrow(closes))).toBe('2029-03-24T12:00:00.000Z');
  });

  it('case 16: `None` iff the lock is `none`, and the gate flips at exactly that instant', () => {
    const rows: ReadonlyArray<{ readonly name: string; readonly event: Fixture }> = [
      { name: 'timed, no lock', event: timed(Option.none()) },
      { name: 'timed, field absent', event: timed(undefined) },
      { name: 'timed, lock 0', event: timed(Option.some(0)) },
      { name: 'timed, lock 24', event: timed(Option.some(24)) },
      { name: 'timed, lock 336', event: timed(Option.some(336)) },
      { name: 'all-day, no lock', event: allDay(Option.none(), 'active') },
      { name: 'all-day, lock 0', event: allDay(Option.some(0), 'active') },
      { name: 'all-day, lock 24', event: allDay(Option.some(24), 'active') },
    ];

    for (const { name, event } of rows) {
      const closes = rsvpClosesAtOf(event);
      const hasLock = Option.isSome(event.rsvp_lock_hours_before ?? Option.none());
      expect(Option.isSome(closes), `${name}: closesAt presence must track the lock`).toBe(hasLock);
      if (!hasLock) continue;

      const at = Option.getOrThrow(closes);
      expect(DateTime.toEpochMillis(at), `${name}: closesAt is start_at - hours`).toBe(
        DateTime.toEpochMillis(event.start_at) -
          Option.getOrThrow(event.rsvp_lock_hours_before ?? Option.none()) * 60 * 60 * 1000,
      );
      expect(eventRsvpOpen(event, PRAGUE, at), `${name}: shut AT the advertised instant`).toBe(
        false,
      );
      expect(
        eventRsvpOpen(event, PRAGUE, minus(at, 1)),
        `${name}: open one millisecond earlier`,
      ).toBe(true);
    }
  });
});
