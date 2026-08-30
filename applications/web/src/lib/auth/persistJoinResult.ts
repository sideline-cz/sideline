import { Effect } from 'effect';
// Nit (third review of PR-4): use the `~/lib/auth` barrel, matching every other call site
// (e.g. `routes/invite.$code.tsx`), rather than reaching into `~/lib/token.js` directly.
import { setLastTeamId, setPendingDiscordJoin } from '~/lib/auth';

/**
 * The subset of `Invite.JoinResult` that persisting a join needs. Kept narrow (rather than
 * importing the full domain class) so this stays trivially unit-testable.
 *
 * BLOCKER 1 (third review of PR-4): `acceptanceId` is no longer `Option` — the server always
 * returns a real acceptance now that `resolveOrCreateAcceptance`'s rate limit is scoped to the
 * (user, invite) pair (see `applications/server/src/utils/resolveOrCreateAcceptance.ts`).
 */
export interface JoinResultForPersistence {
  readonly teamId: string;
  readonly acceptanceId: string;
}

/**
 * Persists a successful join to localStorage — `last-team-id` and `pending-discord-join`,
 * unconditionally.
 *
 * Extracted from `routes/invite.$code.tsx` (BLOCKER 4, review of PR-4) so it is unit-testable:
 * `applications/web/src/routes/` has no test harness for mounting a full route component, and
 * this is the exact behaviour that must run for the `requiresReauth: true` cohort — the original
 * bug this PR fixes was this call being skipped for that cohort.
 */
export const persistJoinResult = (result: JoinResultForPersistence) =>
  Effect.Do.pipe(
    Effect.tap(() => setLastTeamId(result.teamId)),
    Effect.tap(() =>
      setPendingDiscordJoin({
        acceptanceId: result.acceptanceId,
        teamId: result.teamId,
        ts: Date.now(),
      }),
    ),
    Effect.asVoid,
  );
