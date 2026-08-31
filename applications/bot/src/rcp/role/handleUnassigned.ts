import type { RoleRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** This handler executes `role_unassigned` unconditionally: whatever mapping's `discord_role_id`
 * comes back from `Role/GetMapping`, it calls `deleteGuildMemberRole` for it, with no
 * `mapping.adopted` check of its own.
 *
 * That is safe ONLY because the emission side now guarantees it never has to be: this event used
 * to be edge-triggered purely from a captain revoking a role through Sideline's own UI
 * (`role.ts`'s `unassignRole`), which is what the now-stale version of this comment (removed by
 * blocker A, whole-series review of `fix/discord-onboarding-webapp`) relied on. PR-8's
 * `reconcileMemberDiscordRoles.ts` broke that premise: it emits `role_unassigned` for every
 * managed mapping present in a member's *actual* Discord roles and absent from their *desired*
 * Sideline roles — including `adopted: true` mappings, which have no `member_roles` row and so
 * never appear in `desired`. Left unguarded, that meant a member holding a hand-made, adopted
 * Discord role Sideline never assigned them got it silently deleted on the next
 * `Guild/ReconcileMembers`.
 *
 * The fix lives upstream, not here: `reconcileMemberDiscordRoles.ts` (`unassignCandidates`) and
 * `syncMemberDiscordRoles.ts` (`removedCandidates`) both now exclude `adopted` mappings from the
 * diff, so `role_unassigned` for an adopted mapping is no longer emitted for a member Sideline
 * didn't itself put in that role. Keep the decision there, where the full diff (desired vs.
 * actual) is visible — this handler only ever sees one event with no way to reconstruct that
 * context, so re-adding a check here would be duplicated, harder-to-verify policy, not defense
 * in depth. */
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
