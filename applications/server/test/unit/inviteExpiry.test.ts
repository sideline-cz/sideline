// PR-3 (Discord onboarding fix), CC-4 — pins the anti-flapping rule between the sweep (authoritative,
// daily cron) and the derived guard (defensive, PR-5, runs on every 2-second poll). If the two windows
// were equal, a row could cross the derived boundary up to 24h before the sweep closes it, and a user
// reloading the page could see `state: 'expired'` flip back to `'preparing'`. The derived window must
// therefore be strictly larger than the sweep window.

import { describe, expect, it } from '@effect/vitest';
import {
  INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS,
  INVITE_ACCEPTANCE_SWEEP_DAYS,
} from '~/utils/inviteExpiry.js';

describe('inviteExpiry window constants', () => {
  it('the derived expiry window is strictly larger than the sweep window', () => {
    expect(INVITE_ACCEPTANCE_DERIVED_EXPIRY_DAYS).toBeGreaterThan(INVITE_ACCEPTANCE_SWEEP_DAYS);
  });

  it('the sweep window is a positive number of days', () => {
    expect(INVITE_ACCEPTANCE_SWEEP_DAYS).toBeGreaterThan(0);
  });
});
