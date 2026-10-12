// The offset is DERIVED from two instants rather than sent as a field, so the arithmetic is the
// thing that can break — and it breaks silently, as a plausible-looking wrong number on a card
// nobody re-reads. These cases pin the three branches and the day/hour boundary between them.

import { DateTime } from 'effect';
import { describe, expect, it } from 'vitest';
import { formatRsvpLockOffset } from '~/rest/events/rsvpLockOffset.js';

const START = DateTime.makeUnsafe('2026-07-15T16:00:00Z');
const minus = (hours: number) => DateTime.subtract(START, { hours });

describe('formatRsvpLockOffset', () => {
  it('reports a sub-day offset in hours', () => {
    expect(formatRsvpLockOffset(START, minus(3), 'en')).toBe('(3 h before start)');
    expect(formatRsvpLockOffset(START, minus(3), 'cs')).toBe('(3 h před začátkem)');
  });

  it('switches to days on an exact multiple of 24', () => {
    expect(formatRsvpLockOffset(START, minus(24), 'en')).toBe('(1 d before start)');
    // 168 h is the value this branch exists for — "one week", not "168 h".
    expect(formatRsvpLockOffset(START, minus(168), 'en')).toBe('(7 d before start)');
    expect(formatRsvpLockOffset(START, minus(336), 'cs')).toBe('(14 d před začátkem)');
  });

  it('keeps a non-multiple of 24 in hours rather than rounding to days', () => {
    // 36 h must not become "1 d" (understates) or "2 d" (overstates) — a wrong deadline is
    // worse than a long-winded one.
    expect(formatRsvpLockOffset(START, minus(36), 'en')).toBe('(36 h before start)');
    expect(formatRsvpLockOffset(START, minus(25), 'en')).toBe('(25 h before start)');
  });

  it('says "at start" when the lock offset is zero', () => {
    // `rsvp_lock_hours_before = 0` is a real, authorable value — lock exactly at kickoff.
    expect(formatRsvpLockOffset(START, START, 'en')).toBe('(at start)');
    expect(formatRsvpLockOffset(START, START, 'cs')).toBe('(při začátku)');
  });

  it('does not emit a negative lead time if the deadline somehow sits after the start', () => {
    expect(formatRsvpLockOffset(START, DateTime.add(START, { hours: 2 }), 'en')).toBe('(at start)');
  });
});
