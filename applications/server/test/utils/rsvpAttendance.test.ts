// `isAttendingRsvpResponse` is the single predicate every attendance write path
// reads (roster provisioning, the training auto-log cron, the team generator's
// player pool, and the game-result `notRsvpYes` guard — see
// `docs/plans/rsvp-maybe-restore.md`, "Why the attendance change matters").
// After this change `maybe` ("Nevím") no longer counts as attending — only
// `yes` and `coming_later` do.

import { describe, expect, it } from '@effect/vitest';
import { isAttendingRsvpResponse } from '~/utils/rsvpAttendance.js';

describe('isAttendingRsvpResponse', () => {
  it('yes → true', () => {
    expect(isAttendingRsvpResponse('yes')).toBe(true);
  });

  it('coming_later → true', () => {
    expect(isAttendingRsvpResponse('coming_later')).toBe(true);
  });

  it('maybe → false (narrowed: "Nevím" is not attendance)', () => {
    expect(isAttendingRsvpResponse('maybe')).toBe(false);
  });

  it('no → false', () => {
    expect(isAttendingRsvpResponse('no')).toBe(false);
  });
});
