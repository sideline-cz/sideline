import type { Discord, GroupModel, Team } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, type Option } from 'effect';
import { isDiscordNotFoundError, isUnknownRoleError } from '~/rest/discordErrors.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const deleteRole = (guildId: Discord.Snowflake, roleId: Option.Option<Discord.Snowflake>) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roleId', () => Effect.fromOption(roleId)),
    Effect.tap(({ rest, roleId }) =>
      rest.deleteGuildRole(guildId, roleId).pipe(
        // A role already gone from Discord (a captain deleted it by hand, or this event is a
        // redelivery) is the desired end state, not a failure. Caught INSIDE the retry so a
        // permanent 404 resolves immediately instead of burning the whole backoff first.
        // Without this, `deleteChannelAndRole` fails at the role step and never deletes the
        // channel — the fallback path's one job.
        Effect.catchIf(isDiscordNotFoundError, () => Effect.void),
        Effect.retry(retryPolicy),
      ),
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
    Effect.tap(({ rest }) =>
      rest.deleteChannel(discordChannelId).pipe(
        // Already-deleted channel is the desired end state — same reasoning as `deleteRole`
        // above. Without this a redelivered event burns the backoff and then fails, so the
        // handler reports permanent failure for work that is in fact complete.
        Effect.catchIf(isDiscordNotFoundError, () => Effect.void),
        Effect.retry(retryPolicy),
      ),
    ),
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
