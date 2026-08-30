import { Effect } from 'effect';
import { SqlClient } from 'effect/unstable/sql';

// Should-fix 6 (review of PR-4): pulled forward from PR-3. `countRecentByUserAndInvite` runs on
// every join (CC-14's rate limit) and currently sequential-scans `invite_acceptances` for it —
// PR-3 was supposed to ship this index but is now sequenced after PR-4.
//
// Should-fix 3 / should-fix (fourth review of PR-4): ships `(user_id, team_invite_id,
// created_at DESC)`, matching the actual predicate of all three hot-path reads in
// `InviteAcceptancesRepository` — `findOpenByUserAndInvite`, `findNewestByUserAndInvite`, and
// `countRecentByUserAndInvite` all filter on `user_id AND team_invite_id` together (the first
// two also `ORDER BY created_at DESC`). A 2-column `(user_id, created_at DESC)` index would
// only satisfy the `user_id` half of that predicate, forcing a recheck filter (or a bitmap-AND
// against the separate `idx_invite_acceptances_team_invite_id`) for `team_invite_id` on every
// call; the 3-column shape lets a single index scan serve the filter and the sort directly.
//
// The plan's PR-3 step 2 (`.work-plans/discord-onboarding-fix-plan.md`) shipped the same index
// NAME with a different shape and no `IF NOT EXISTS`; since `Migrator.js` runs a whole pending
// batch inside one transaction, that `relation already exists` would have rolled back every
// migration in that release. That PR-3 step is deleted, not just guarded — see the plan file's
// changelog note.
export default Effect.flatMap(
  Effect.service(SqlClient.SqlClient),
  (sql) => sql`
    CREATE INDEX IF NOT EXISTS idx_invite_acceptances_user_id
      ON invite_acceptances(user_id, team_invite_id, created_at DESC)
  `,
);
