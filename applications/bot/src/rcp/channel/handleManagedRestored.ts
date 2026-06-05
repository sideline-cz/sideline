import type { ChannelRpcEvents, Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';

// Asymmetry: NO delete-fallback and NO RPC ack (discord_channel_id stays linked on the row).

const moveToRoot = (discordChannelId: Discord.Snowflake) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rest }) =>
      rest.updateChannel(discordChannelId, { parent_id: null }).pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(`Moved managed Discord channel ${discordChannelId} out of archive category`),
    ),
    Effect.asVoid,
  );

export const handleManagedRestored = (event: ChannelRpcEvents.ManagedChannelRestoredEvent) =>
  Effect.Do.pipe(
    Effect.tap(() =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          moveToRoot(channelId).pipe(
            Effect.catch((error) =>
              Effect.logWarning(
                `Failed to move managed channel ${channelId} out of archive category`,
                error,
              ),
            ),
          ),
      }),
    ),
    Effect.asVoid,
  );
