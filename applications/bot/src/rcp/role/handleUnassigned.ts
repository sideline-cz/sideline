import type { RoleRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** This handler executes `role_unassigned` unconditionally: whatever mapping's `discord_role_id`
 * comes back from `Role/GetMapping`, it calls `deleteGuildMemberRole` for it, with no provenance
 * check of its own. That is deliberate, not an oversight — see below for why it does not need
 * one, and should-fix 8 (whole-series review of commit 46806427) for why the invariant this
 * comment used to claim was overstated.
 *
 * `role_unassigned` has two different emitters with two different guarantees:
 *
 * - The diff functions (`reconcileMemberDiscordRoles.ts` `unassignCandidates`,
 *   `syncMemberDiscordRoles.ts` `removedCandidates`) now emit it only when `member_role_grants`
 *   records that SIDELINE ITSELF gave *this* member the role (the blocker fix, whole-series
 *   review of commit 46806427) — a member holding a hand-granted Discord role, adopted mapping or
 *   not, is excluded from those diffs entirely. See those files' doc comments for the full
 *   rationale.
 * - The direct, captain-initiated path (`api/role.ts`'s `unassignRole`, `role.ts:322-329`) emits
 *   it unconditionally whenever a captain revokes a role through Sideline's own UI, with no
 *   provenance check and no rowcount check on its `member_roles` DELETE — it emits even if that
 *   DELETE matched zero rows (a stale roster page, a double submit, or a direct API call can all
 *   reach this with the member already role-less in Sideline). That is intentional: a captain
 *   explicitly acting through Sideline's UI should always be able to ask Discord to remove a role
 *   Sideline manages, regardless of how the member came to hold it.
 *
 * So this handler cannot rely on "every `role_unassigned` event implies Sideline granted the
 * role" — the direct path is a standing counter-example, not a bug to guard against. What makes
 * the unconditional `deleteGuildMemberRole` call below safe is different: removing a role the
 * member does not currently hold is a Discord no-op (`deleteGuildMemberRole` on an absent role
 * neither errors nor changes anything), so a spurious emission from either path costs nothing.
 * Re-adding a provenance check here would only reject the direct path's legitimate, deliberate
 * unconditional case — the diff functions already own the provenance decision where the full
 * context (desired vs. actual vs. granted) is visible; this handler only ever sees one event. */
export const handleMemberRemoved = (event: RoleRpcEvents.RoleUnassignedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('cached', ({ rpc }) =>
      rpc['Role/GetMapping']({
        team_id: event.team_id,
        role_id: event.role_id,
      }),
    ),
    Effect.bind('mapping', ({ cached }) => Effect.fromOption(cached)),
    Effect.tap(({ rest, mapping }) =>
      rest
        .deleteGuildMemberRole(event.guild_id, event.discord_user_id, mapping.discord_role_id)
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ mapping }) =>
      Effect.logInfo(
        `Removed Discord role ${mapping.discord_role_id} from user ${event.discord_user_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
    Effect.catchTag('NoSuchElementError', () =>
      Effect.logWarning(`No mapping found for role ${event.role_id}, skipping role_unassigned`),
    ),
  );
