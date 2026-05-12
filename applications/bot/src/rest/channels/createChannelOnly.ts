import { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Effect, Option } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { HIDDEN } from '../permissions.js';
import { deny, retryPolicy } from '../utils.js';

/** Creates a hidden Discord text channel. Does NOT create a role or permission overwrite. */
export const createChannelOnly = (guildId: DiscordSchemas.Snowflake, channelName: string) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('channel', ({ rest }) =>
      rest
        .createGuildChannel(guildId, {
          name: channelName,
          type: Discord.ChannelTypes.GUILD_TEXT,
          permission_overwrites: [
            { id: guildId, type: Discord.ChannelPermissionOverwrites.ROLE, deny: deny(HIDDEN) },
          ],
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ channel }) =>
      Effect.logInfo(
        `Auto-created Discord channel "${channelName}" (${channel.id}) in guild ${guildId}`,
      ),
    ),
    Effect.tap(({ channel, rpc }) =>
      rpc['Guild/UpsertChannel']({
        guild_id: guildId,
        channel_id: channel.id as DiscordSchemas.Snowflake,
        name: channelName,
        type: Discord.ChannelTypes.GUILD_TEXT,
        parent_id: Option.map(
          Option.fromNullishOr(channel.parent_id),
          DiscordSchemas.Snowflake.makeUnsafe,
        ),
      }).pipe(
        Effect.tapError((e) =>
          Effect.logWarning(`Failed to upsert discord_channels row for ${channel.id}`, e),
        ),
        Effect.catchTag('RpcClientError', () => Effect.void),
      ),
    ),
    Effect.map(({ channel }) => ({
      discord_channel_id: channel.id as DiscordSchemas.Snowflake,
    })),
  );
