import type { RoleRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { isUnknownRoleError } from '~/rest/discordErrors.js';
import { hasDangerousPermissions } from '~/rest/roles/dangerousPermissions.js';
import { ensureMapping } from '~/rest/roles/ensureMapping.js';
import { retryPolicy } from '~/rest/utils.js';
import { GuildRolesCache } from '~/services/GuildRolesCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Blocker 3: `ensureMapping` (and adoption in particular) validate a role's permissions only at
 * mapping time. Nothing re-checks afterwards, so a guild role that was `permissions: '0'` when
 * adopted/created and is later granted e.g. `ADMINISTRATOR` (an entirely ordinary thing to do to a
 * role named "Captain") would silently hand guild admin to everyone assigned that role from then
 * on. Re-validate against a fresh `listGuildRoles` read (via the per-tick `GuildRolesCache`)
 * immediately before `addGuildMemberRole` — the only point where an assignment can actually take
 * effect. A role missing from that fresh read is treated the same as dangerous: never assign on
 * incomplete information. */
const isUnsafeToAssign = (
  guildRoles: ReadonlyArray<{ readonly id: string; readonly permissions: string }>,
  discordRoleId: string,
): boolean => {
  const target = guildRoles.find((role) => role.id === discordRoleId);
  return target === undefined || hasDangerousPermissions(target.permissions);
};

/** Deletes the stale `discord_role_mappings` row on Unknown Role (10011) — e.g. a captain
 * deleted the mapped role directly in Discord — so the next `role_assigned`/`role_created` event
 * for this Sideline role re-resolves via `ensureMapping` (adopt or create) instead of retrying
 * the same dead id forever. Best-effort: never fails the caller. */
const clearStaleMappingOnUnknownRole = (event: RoleRpcEvents.RoleAssignedEvent, error: unknown) =>
  isUnknownRoleError(error)
    ? SyncRpc.asEffect().pipe(
        Effect.flatMap((rpc) =>
          rpc['Role/DeleteMapping']({ team_id: event.team_id, role_id: event.role_id }),
        ),
        Effect.tap(() =>
          Effect.logWarning(
            `Discord role for role ${event.role_id} in guild ${event.guild_id} no longer exists (Unknown Role); deleted the stale mapping so the next event re-resolves it`,
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning('Failed to clear stale role mapping after Unknown Role', cause),
        ),
      )
    : Effect.void;

export const handleMemberAdded = (event: RoleRpcEvents.RoleAssignedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rolesCache', () => GuildRolesCache.asEffect()),
    Effect.bind('roleId', () =>
      ensureMapping(event.team_id, event.role_id, event.guild_id, event.role_name),
    ),
    Effect.bind('guildRoles', ({ rolesCache }) => rolesCache.get(event.guild_id)),
    Effect.let('unsafe', ({ guildRoles, roleId }) => isUnsafeToAssign(guildRoles, roleId)),
    Effect.flatMap(({ rest, roleId, unsafe }) =>
      unsafe
        ? Effect.logWarning(
            `Refusing to assign Discord role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}: the role now carries dangerous permissions, or its permissions could not be verified. Not failing the event — an operator should review the role's permissions in Discord and re-run role sync once fixed.`,
          )
        : rest.addGuildMemberRole(event.guild_id, event.discord_user_id, roleId).pipe(
            Effect.retry(retryPolicy),
            Effect.tapError((error) => clearStaleMappingOnUnknownRole(event, error)),
            Effect.tap(() =>
              Effect.logInfo(
                `Assigned role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}`,
              ),
            ),
          ),
    ),
    Effect.asVoid,
  );
