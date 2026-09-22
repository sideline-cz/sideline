import { describe, expect, it } from '@effect/vitest';
import { rsvpResponseRequiresMessage } from '~/models/EventRsvp.js';

describe('EventRsvp.rsvpResponseRequiresMessage', () => {
  // Truth table — `coming_later` and `maybe` both mandate a non-empty note (they open the
  // comment modal and never render a "clear message" button); `yes`/`no` never require one.
  it.each([
    ['yes', false],
    ['coming_later', true],
    ['maybe', true],
    ['no', false],
  ] as const)('%s → %s', (response, expected) => {
    expect(rsvpResponseRequiresMessage(response)).toBe(expected);
  });
});
