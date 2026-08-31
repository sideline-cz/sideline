// TDD for BLOCKER 4 (review of PR-4) — the regression test for the bug this PR exists to fix.
//
// `applications/web/src/routes/` has zero test files, and `InvitePage.test.tsx`'s header
// explicitly says persistence is "tested at the route level, not here". Nothing anywhere
// actually asserted that `setLastTeamId` runs for the `requiresReauth: true` cohort — which is
// exactly the bug root cause C described (the callback used to be skipped entirely when
// `requiresReauth` was true).
//
// `persistJoinResult` is the extracted, directly-testable unit that
// `routes/invite.$code.tsx`'s join-result handler calls unconditionally, regardless of
// `requiresReauth`. This test exercises it standalone (no router, no component tree) and
// asserts the `last-team-id` localStorage write actually happens.
//
// Blocker (whole-series review, fix/discord-onboarding-webapp): this used to also assert a
// `pending-discord-join` write. That key's only reader (`PendingDiscordJoinBanner`) was deleted
// by the Discord-connect-enforcement work, leaving the write a dead, unscoped device-global key
// holding user data (`acceptanceId`) that nothing ever cleared — see `persistJoinResult.ts`'s
// doc comment. `persistJoinResult` now only persists `last-team-id`.
import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { persistJoinResult } from '~/lib/auth/persistJoinResult.js';

const LAST_TEAM_KEY = 'last-team-id';
const PENDING_DISCORD_JOIN_KEY = 'pending-discord-join';

beforeEach(() => {
  localStorage.clear();
});

describe('persistJoinResult', () => {
  it('writes last-team-id for a result that requires re-auth', () => {
    Effect.runSync(persistJoinResult({ teamId: 'team-1' }));

    expect(localStorage.getItem(LAST_TEAM_KEY)).toBe('team-1');
  });

  it('writes last-team-id unconditionally for a second, distinct join', () => {
    Effect.runSync(persistJoinResult({ teamId: 'team-2' }));

    expect(localStorage.getItem(LAST_TEAM_KEY)).toBe('team-2');
  });

  it('never writes the retired pending-discord-join key', () => {
    Effect.runSync(persistJoinResult({ teamId: 'team-3' }));

    expect(localStorage.getItem(PENDING_DISCORD_JOIN_KEY)).toBeNull();
  });
});
