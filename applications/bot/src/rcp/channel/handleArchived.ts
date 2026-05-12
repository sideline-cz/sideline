import type { ChannelRpcEvents, Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { deleteChannelAndRole, deleteRole } from './channelUtils.js';

const deletePermissionOverwrite = (
  discordChannelId: Discord.Snowflake,
  discordRoleId: Option.Option<Discord.Snowflake>,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roleId', () => Effect.fromOption(discordRoleId)),
    Effect.tap(({ rest, roleId }) =>
      rest
        .deleteChannelPermissionOverwrite(discordChannelId, roleId)
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Deleted permission overwrite for role ${roleId} on channel ${discordChannelId}`,
      ),
    ),
    Effect.catchTag('NoSuchElementError', () => Effect.void),
  );

const moveToArchive = (discordChannelId: Discord.Snowflake, archiveCategoryId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) =>
      rest
        .updateChannel(discordChannelId, { parent_id: archiveCategoryId })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Moved Discord channel ${discordChannelId} to archive category ${archiveCategoryId}`,
      ),
    ),
    Effect.asVoid,
  );

export const handleGroupArchived = (event: ChannelRpcEvents.GroupChannelArchivedEvent) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          moveToArchive(channelId, event.archive_category_id).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Failed to move group channel ${channelId} to archive, falling back to deletion`,
                error,
              ).pipe(
                Effect.tap(() => deleteChannelAndRole(event.guild_id, channelId, Option.none())),
              ),
            ),
            Effect.tap(() => deletePermissionOverwrite(channelId, event.discord_role_id)),
          ),
      }),
    ),
    Effect.asVoid,
  );

export const handleRosterArchived = (event: ChannelRpcEvents.RosterChannelArchivedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.tap(() =>
      moveToArchive(event.discord_channel_id, event.archive_category_id).pipe(
        Effect.catch((error) =>
          Effect.logWarning(
            `Failed to move roster channel ${event.discord_channel_id} to archive, falling back to deletion`,
            error,
          ).pipe(
            Effect.tap(() =>
              deleteChannelAndRole(event.guild_id, event.discord_channel_id, event.discord_role_id),
            ),
          ),
        ),
        Effect.tap(() =>
          deletePermissionOverwrite(event.discord_channel_id, event.discord_role_id),
        ),
        Effect.tap(() => deleteRole(event.guild_id, event.discord_role_id)),
      ),
    ),
    Effect.tap(({ rpc }) =>
      rpc['Channel/DeleteRosterMapping']({ team_id: event.team_id, roster_id: event.roster_id }),
    ),
    Effect.tap(({ rpc }) =>
      rpc['Channel/UpdateRosterChannel']({
        roster_id: event.roster_id,
        discord_channel_id: Option.none(),
      }),
    ),
    Effect.asVoid,
  );
