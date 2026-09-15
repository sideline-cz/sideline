import type { Discord, GroupModel, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, type Option } from 'effect';
import { isUnknownRoleError } from '~/rest/discordErrors.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const deleteRole = (guildId: Discord.Snowflake, roleId: Option.Option<Discord.Snowflake>) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roleId', () => Effect.fromOption(roleId)),
    Effect.tap(({ rest, roleId }) =>
      rest.deleteGuildRole(guildId, roleId).pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(`Deleted Discord role ${roleId} in guild ${guildId}`),
    ),
    Effect.catchTag('NoSuchElementError', () => Effect.void),
  );

export const deleteChannelAndRole = (
  guildId: Discord.Snowflake,
  discordChannelId: Discord.Snowflake,
  discordRoleId: Option.Option<Discord.Snowflake>,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(() => deleteRole(guildId, discordRoleId)),
    Effect.tap(({ rest }) => rest.deleteChannel(discordChannelId).pipe(Effect.retry(retryPolicy))),
    Effect.tap(() =>
      Effect.logInfo(`Deleted Discord channel ${discordChannelId} in guild ${guildId}`),
    ),
    Effect.asVoid,
  );

/** Clears the stale `discord_channel_mappings.discord_role_id` on Unknown Role (10011) — e.g. a
 * captain deleted the group's mapped Discord role directly in Discord. Best-effort: never fails
 * the caller, so it is safe to run per member in a backfill loop. Mirrors the role-axis precedent
 * `clearStaleMappingOnUnknownRole` (`~/rcp/role/handleAssigned.ts:93-95`/`:80-89`) — clear, don't
 * delete, handing the group back to `findGroupsMissingRole`'s next sweep instead of retrying the
 * same dead role id forever. */
export const clearStaleRoleOnUnknownRole = (
  event: {
    readonly team_id: Team.TeamId;
    readonly group_id: GroupModel.GroupId;
    readonly guild_id: Discord.Snowflake;
  },
  error: unknown,
) =>
  isUnknownRoleError(error)
    ? SyncRpc.asEffect().pipe(
        Effect.flatMap((rpc) =>
          rpc['Channel/ClearMappingRole']({ team_id: event.team_id, group_id: event.group_id }),
        ),
        Effect.tap(() =>
          Effect.logWarning(
            `Discord role for group ${event.group_id} in guild ${event.guild_id} no longer exists (Unknown Role); cleared the stale mapping so the next sweep re-provisions it`,
          ),
        ),
        Effect.catchCause((cause) =>
          Effect.logWarning('Failed to clear stale group role mapping', cause),
        ),
      )
    : Effect.void;
