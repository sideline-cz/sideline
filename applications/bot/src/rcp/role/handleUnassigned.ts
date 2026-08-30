import type { RoleRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Blocker 2 asked us to consider `mapping.adopted` here too, the way `handleDeleted` does.
 * Decision: do NOT special-case it. `handleDeleted` destroys the shared Discord *resource* for
 * every one of its (possibly untracked) members; this handler only ever touches ONE member's
 * membership in that role, and only fires because a captain used Sideline's own role UI to revoke
 * this specific member's Sideline role — the same authority that granted it via `role_assigned` in
 * the first place (`handleAssigned.ts`). A member Sideline never assigned this role to has no
 * `member_roles` row to delete, so no `role_unassigned` event is ever emitted for them regardless
 * of whether the mapping is adopted — this handler's blast radius is inherently limited to members
 * Sideline itself put in this role. Symmetric with assignment: adopting a role means Sideline can
 * manage membership in it, in both directions. */
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
