import type { Discord, Role, RoleRpcEvents, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Data, Effect } from 'effect';
import { isUnknownRoleError } from '~/rest/discordErrors.js';
import { hasDangerousPermissions } from '~/rest/roles/dangerousPermissions.js';
import { ensureMapping } from '~/rest/roles/ensureMapping.js';
import { retryPolicy } from '~/rest/utils.js';
import { GuildRolesCache } from '~/services/GuildRolesCache.js';
import { SyncRpc } from '~/services/SyncRpc.js';

/** Refusing to assign a role whose live permissions are dangerous — see `isDangerous` below.
 * Failed with this tag rather than swallowed (whole-series review, "also fix" item) so
 * `errorClassifier.ts`'s `classifyRoleSyncError` can turn it into `captain_action`, which
 * `Role/MarkEventFailed` records on `team_members.last_role_sync_*` — the UI already has copy for
 * that code. The level-based diff re-derives the missing assignment on the next reconcile pass
 * regardless, so failing the event loses nothing.
 *
 * Should-fix 2 (whole-series review of commit 46806427): this tag is now reserved for an
 * ACTUALLY-DANGEROUS role only. A role missing from the fresh read entirely is a different
 * problem (a stale mapping) with a different remedy — see `StaleRoleMappingError`. Conflating the
 * two under one boolean routed "the mapped Discord role no longer exists" through the
 * "a captain must fix permissions" copy, which is both wrong and unactionable — there is no
 * permission to fix on a role that isn't there. */
export class UnsafeRoleAssignmentError extends Data.TaggedError('UnsafeRoleAssignmentError')<{
  readonly discordRoleId: string;
  readonly guildId: string;
  readonly discordUserId: string;
}> {}

/** Should-fix 2 (whole-series review of commit 46806427): the mapped Discord role is absent from
 * the fresh `listGuildRoles` read — i.e. it was deleted directly in Discord since the mapping was
 * created/adopted. This needs the stale `discord_role_mappings` row cleared so the next event
 * re-resolves it via `ensureMapping` (adopt or create); it needs no captain action on a role's
 * permissions, because there is no such role to act on. Classified `retryable` by
 * `errorClassifier.ts` (non-terminal): `team_members.last_role_sync_*` is left untouched and
 * `syncEventsFailedTotal` does not record a captain-visible failure, matching CC-0's treatment of
 * every other transient condition the diff can self-heal from on the next reconcile pass. Before
 * this fix, a missing role was folded into `UnsafeRoleAssignmentError` (`captain_action`,
 * terminal), which never cleared the mapping — so the SAME stale id failed the SAME way on every
 * future reconcile pass forever, and `clearStaleMappingOnUnknownRole`'s REST-level 10011 path
 * below became unreachable (it only fires from an actual `addGuildMemberRole` call, which the
 * pre-flight "missing" branch never makes). */
export class StaleRoleMappingError extends Data.TaggedError('StaleRoleMappingError')<{
  readonly discordRoleId: string;
  readonly guildId: string;
}> {}

/** Blocker 3: `ensureMapping` (and adoption in particular) validate a role's permissions only at
 * mapping time. Nothing re-checks afterwards, so a guild role that was `permissions: '0'` when
 * adopted/created and is later granted e.g. `ADMINISTRATOR` (an entirely ordinary thing to do to a
 * role named "Captain") would silently hand guild admin to everyone assigned that role from then
 * on. Re-validate against a fresh `listGuildRoles` read (via the per-tick `GuildRolesCache`)
 * immediately before `addGuildMemberRole` — the only point where an assignment can actually take
 * effect.
 *
 * Should-fix 2 (whole-series review of commit 46806427): this only answers "is the role, which we
 * know still exists, dangerous" — a role absent from `guildRoles` entirely is handled by a
 * SEPARATE branch in `handleMemberAdded` (`StaleRoleMappingError`), not folded into this check.
 * The two are different failure modes with different remedies and must not share one boolean. */
const isDangerous = (
  guildRoles: ReadonlyArray<{ readonly id: string; readonly permissions: string }>,
  discordRoleId: string,
): boolean => {
  const target = guildRoles.find((role) => role.id === discordRoleId);
  return target !== undefined && hasDangerousPermissions(target.permissions);
};

/** Deletes the stale `discord_role_mappings` row so the next `role_assigned`/`role_created` event
 * for this Sideline role re-resolves via `ensureMapping` (adopt or create) instead of retrying the
 * same dead id forever. Best-effort: never fails the caller. Shared by both the pre-flight
 * "missing from the fresh `listGuildRoles` read" branch below and `clearStaleMappingOnUnknownRole`
 * (the REST-level Unknown Role / 10011 path) — same remedy either way, just discovered at two
 * different points. */
const clearStaleMapping = (
  teamId: Team.TeamId,
  roleId: Role.RoleId,
  guildId: Discord.Snowflake,
  reason: string,
) =>
  SyncRpc.asEffect().pipe(
    Effect.flatMap((rpc) => rpc['Role/DeleteMapping']({ team_id: teamId, role_id: roleId })),
    Effect.tap(() =>
      Effect.logWarning(
        `Discord role for role ${roleId} in guild ${guildId} no longer exists (${reason}); deleted the stale mapping so the next event re-resolves it`,
      ),
    ),
    Effect.catchCause((cause) => Effect.logWarning('Failed to clear stale role mapping', cause)),
  );

/** Deletes the stale `discord_role_mappings` row on Unknown Role (10011) — e.g. a captain
 * deleted the mapped role directly in Discord AFTER `handleMemberAdded`'s fresh-read check ran but
 * BEFORE this REST call landed. Best-effort: never fails the caller. */
const clearStaleMappingOnUnknownRole = (event: RoleRpcEvents.RoleAssignedEvent, error: unknown) =>
  isUnknownRoleError(error)
    ? clearStaleMapping(event.team_id, event.role_id, event.guild_id, 'Unknown Role')
    : Effect.void;

export const handleMemberAdded = (event: RoleRpcEvents.RoleAssignedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rolesCache', () => GuildRolesCache.asEffect()),
    Effect.bind('roleId', () =>
      ensureMapping(event.team_id, event.role_id, event.guild_id, event.role_name),
    ),
    Effect.bind('guildRoles', ({ rolesCache }) => rolesCache.get(event.guild_id)),
    Effect.let(
      'missing',
      ({ guildRoles, roleId }) => !guildRoles.some((role) => role.id === roleId),
    ),
    Effect.let('dangerous', ({ guildRoles, roleId }) => isDangerous(guildRoles, roleId)),
    Effect.flatMap(
      ({ rest, roleId, missing, dangerous }): Effect.Effect<void, unknown, SyncRpc> => {
        if (missing) {
          return clearStaleMapping(
            event.team_id,
            event.role_id,
            event.guild_id,
            'missing from fresh read',
          ).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new StaleRoleMappingError({ discordRoleId: roleId, guildId: event.guild_id }),
              ),
            ),
          );
        }
        if (dangerous) {
          return Effect.logWarning(
            `Refusing to assign Discord role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}: the role now carries dangerous permissions. Failing the event (captain_action) — an operator should review the role's permissions in Discord and re-run role sync once fixed.`,
          ).pipe(
            Effect.flatMap(() =>
              Effect.fail(
                new UnsafeRoleAssignmentError({
                  discordRoleId: roleId,
                  guildId: event.guild_id,
                  discordUserId: event.discord_user_id,
                }),
              ),
            ),
          );
        }
        return rest.addGuildMemberRole(event.guild_id, event.discord_user_id, roleId).pipe(
          Effect.retry(retryPolicy),
          Effect.tapError((error) => clearStaleMappingOnUnknownRole(event, error)),
          Effect.tap(() =>
            Effect.logInfo(
              `Assigned role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}`,
            ),
          ),
        );
      },
    ),
    Effect.asVoid,
  );
