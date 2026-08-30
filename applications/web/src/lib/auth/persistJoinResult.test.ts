// TDD for BLOCKER 4 (review of PR-4) — the regression test for the bug this PR exists to fix.
//
// `applications/web/src/routes/` has zero test files, and `InvitePage.test.tsx`'s header
// explicitly says persistence is "tested at the route level, not here". Nothing anywhere
// actually asserted that `setPendingDiscordJoin` runs for the `requiresReauth: true` cohort —
// which is exactly the bug root cause C described (the callback used to be skipped entirely
// when `requiresReauth` was true).
//
// `persistJoinResult` is the extracted, directly-testable unit that
// `routes/invite.$code.tsx`'s join-result handler calls unconditionally, regardless of
// `requiresReauth`. This test exercises it standalone (no router, no component tree) and
// asserts the `pending-discord-join` localStorage write actually happens.
import { Effect } from 'effect';
import { beforeEach, describe, expect, it } from 'vitest';
import { persistJoinResult } from '~/lib/auth/persistJoinResult.js';

const PENDING_DISCORD_JOIN_KEY = 'pending-discord-join';
const LAST_TEAM_KEY = 'last-team-id';

beforeEach(() => {
  localStorage.clear();
});

describe('persistJoinResult', () => {
  it('writes pending-discord-join and last-team-id for a result that requires re-auth', () => {
    Effect.runSync(
      persistJoinResult({
        teamId: 'team-1',
        acceptanceId: 'acceptance-1',
      }),
    );

    expect(localStorage.getItem(LAST_TEAM_KEY)).toBe('team-1');
    const raw = localStorage.getItem(PENDING_DISCORD_JOIN_KEY);
    expect(raw).not.toBeNull();
    const parsed = raw === null ? null : JSON.parse(raw);
    expect(parsed?.acceptanceId).toBe('acceptance-1');
    expect(parsed?.teamId).toBe('team-1');
    expect(typeof parsed?.ts).toBe('number');
  });

  // BLOCKER 1 (third review of PR-4): `acceptanceId` is no longer `Option` — the server always
  // returns a real acceptance now that the rate limit is scoped to the (user, invite) pair, so
  // there is no "skip pending-discord-join" case left to pin.
  it('writes both keys unconditionally for a second, distinct join', () => {
    Effect.runSync(
      persistJoinResult({
        teamId: 'team-2',
        acceptanceId: 'acceptance-2',
      }),
    );

    expect(localStorage.getItem(LAST_TEAM_KEY)).toBe('team-2');
    const raw = localStorage.getItem(PENDING_DISCORD_JOIN_KEY);
    expect(raw).not.toBeNull();
    const parsed = raw === null ? null : JSON.parse(raw);
    expect(parsed?.acceptanceId).toBe('acceptance-2');
  });
});
