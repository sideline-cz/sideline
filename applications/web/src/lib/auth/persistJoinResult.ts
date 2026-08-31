// Nit (third review of PR-4): use the `~/lib/auth` barrel, matching every other call site
// (e.g. `routes/invite.$code.tsx`), rather than reaching into `~/lib/token.js` directly.
import { setLastTeamId } from '~/lib/auth';

/**
 * The subset of `Invite.JoinResult` that persisting a join needs. Kept narrow (rather than
 * importing the full domain class) so this stays trivially unit-testable.
 */
export interface JoinResultForPersistence {
  readonly teamId: string;
}

/**
 * Persists a successful join to localStorage — `last-team-id`, unconditionally.
 *
 * Extracted from `routes/invite.$code.tsx` (BLOCKER 4, review of PR-4) so it is unit-testable:
 * `applications/web/src/routes/` has no test harness for mounting a full route component, and
 * this is the exact behaviour that must run for the `requiresReauth: true` cohort — the original
 * bug this PR fixes was this call being skipped for that cohort.
 *
 * BLOCKER (whole-series review, fix/discord-onboarding-webapp): this used to also write
 * `pending-discord-join` (`acceptanceId` + a timestamp) to localStorage. That key's only reader,
 * `PendingDiscordJoinBanner`, was deleted by the Discord-connect-enforcement work — the write
 * became a bare, unscoped device-global key (`acceptanceId` is user data, not device data) that
 * nothing ever read or cleared. Dropped along with its readers in `~/lib/token.ts` / `~/lib/auth`.
 */
export const persistJoinResult = (result: JoinResultForPersistence) => setLastTeamId(result.teamId);
