import type { Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { backfillGroupRoleMembers } from '~/utils/backfillGroupRoleMembers.js';

// One team per invocation, on purpose — do NOT raise this without evidence, and
// never ship a single all-teams action. `backfillGroupRoleMembers` re-emits a
// `channel_created` event per already-provisioned group, which the bot expands into
// `Channel/GetGroupMembers` (direct + descendant, uncapped) followed by one
// sequential `addGuildMemberRole` per member at `concurrency: 1` on the single
// global channel queue. A 1 000-member group is one row that blocks every other
// channel event (new group channels, roster provisioning, managed access) for
// minutes. The real bound of one invocation is `Σ (direct + descendant members)
// over every eligible group across the page's teams` — an all-teams-at-once action
// would enqueue the install base's entire group membership from a single click.
export const TEAMS_PER_INVOCATION = 1;

export type GroupRoleBackfillPage = {
  readonly processedCount: number;
  readonly remainingCount: number;
  readonly remainingTeams: number;
  readonly nextAfter: Option.Option<Team.TeamId>;
};

// One page of the install-base-wide group-role member backfill sweep, shared by
// the `POST /auth/global-admins/group-role-member-backfill` HTTP handler
// (`src/api/global-admin.ts`) and the `backfillGroupRoleMembersCli.ts` operator
// script, so the two never drift on cursor/termination semantics.
//
// `nextAfter` is the single source of truth for "is the walk done": it is
// `Option.none()` exactly when `remainingTeams` is 0, so a caller can loop on
// either field and get the same answer.
export const runGroupRoleBackfillPage = (after: Option.Option<Team.TeamId>) =>
  Effect.Do.pipe(
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('teamIds', ({ teams }) => teams.findTeamIdsAfter(after, TEAMS_PER_INVOCATION)),
    Effect.bind('results', ({ teamIds }) =>
      Effect.forEach(teamIds, backfillGroupRoleMembers, { concurrency: 1 }),
    ),
    Effect.let('processedCount', ({ results }) =>
      results.reduce((sum, result) => sum + result.processedCount, 0),
    ),
    Effect.let('remainingCount', ({ results }) =>
      results.reduce((sum, result) => sum + result.remainingCount, 0),
    ),
    // The provisional cursor is the last team visited THIS page, in the same
    // stable order — so a page of 0 (nothing left) leaves the cursor as-is
    // rather than rewinding.
    Effect.let('cursorAfterPage', ({ teamIds }) =>
      teamIds.length > 0 ? Option.some(teamIds[teamIds.length - 1]) : after,
    ),
    Effect.bind('remainingTeams', ({ teams, cursorAfterPage }) =>
      teams.countTeamsAfter(cursorAfterPage),
    ),
    Effect.let('nextAfter', ({ cursorAfterPage, remainingTeams }) =>
      remainingTeams > 0 ? cursorAfterPage : Option.none(),
    ),
    Effect.tap(({ processedCount, remainingCount, remainingTeams }) =>
      Effect.logInfo('global_admin.group_role_backfill', {
        processedCount,
        remainingCount,
        remainingTeams,
      }),
    ),
    Effect.map(({ processedCount, remainingCount, remainingTeams, nextAfter }) => ({
      processedCount,
      remainingCount,
      remainingTeams,
      nextAfter,
    })),
  );
