import { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Effect, Option } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { HIDDEN, PERSONAL_VIEW } from '../permissions.js';
import { allow, deny, retryPolicy } from '../utils.js';

/**
 * Creates a private personal-events Discord text channel for a single guild member.
 *
 * Permission overwrites:
 *   - @everyone role → DENY ViewChannel (hidden from everyone)
 *   - member (MEMBER type) → allow ViewChannel + ReadMessageHistory, deny SendMessages (read-only)
 *
 * The channel is placed inside the given `categoryId`.
 */
export const createPersonalEventChannel = (
  guildId: DiscordSchemas.Snowflake,
  discordUserId: DiscordSchemas.Snowflake,
  categoryId: DiscordSchemas.Snowflake,
  channelName: string,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('channel', ({ rest }) =>
      rest
        .createGuildChannel(guildId, {
          name: channelName,
          type: Discord.ChannelTypes.GUILD_TEXT,
          parent_id: categoryId,
          permission_overwrites: [
            // Deny @everyone role (id = guildId) from viewing this channel
            {
              id: guildId,
              type: Discord.ChannelPermissionOverwrites.ROLE,
              deny: deny(HIDDEN),
            },
            // Allow the specific member to read (but not send messages)
            {
              id: discordUserId,
              type: Discord.ChannelPermissionOverwrites.MEMBER,
              allow: allow(PERSONAL_VIEW),
              deny: deny(PERSONAL_VIEW),
            },
          ],
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ channel }) =>
      Effect.logInfo(
        `Auto-created personal Discord channel "${channelName}" (${channel.id}) for user ${discordUserId} in guild ${guildId}`,
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
