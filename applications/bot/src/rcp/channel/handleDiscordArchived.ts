import type { ChannelRpcEvents, Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';

// Asymmetry: NO delete-fallback (we must never delete a channel the admin didn't create through
// Sideline), and NO RPC ack (there is no team_channels row to update for discord-managed channels).

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
        `Moved Discord-managed channel ${discordChannelId} to archive category ${archiveCategoryId}`,
      ),
    ),
    Effect.asVoid,
  );

export const handleDiscordArchived = (event: ChannelRpcEvents.DiscordChannelArchivedEvent) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          moveToArchive(channelId, event.archive_category_id).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Failed to move discord-managed channel ${channelId} to archive category ${event.archive_category_id}`,
                error,
              ),
            ),
          ),
      }),
    ),
    Effect.asVoid,
  );
