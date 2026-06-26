import type { ChannelRpcEvents, Discord as DiscordSchemas } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { createDiscordChannelAndRole } from '~/rest/channels/createChannelWithRole.js';
import { createRoleForChannel } from '~/rest/channels/createRoleForChannel.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleRosterChannelCreated = (event: ChannelRpcEvents.RosterChannelCreatedEvent) => {
  const roleColor = Option.getOrUndefined(event.discord_role_color);
  return Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('result', () =>
      Option.match(event.existing_channel_id, {
        onNone: () =>
          createDiscordChannelAndRole(
            event.guild_id,
            event.discord_channel_name,
            event.discord_role_name,
            roleColor,
            Option.getOrUndefined(event.target_category_id),
          ),
        // Linking an existing channel: only create the role, ignore the roster category
        // (moving an already-existing channel into a category is a separate concern).
        onSome: (channelId) =>
          createRoleForChannel(event.guild_id, channelId, event.discord_role_name, roleColor),
      }),
    ),
    Effect.tap(({ result, rpc }) =>
      rpc['Channel/UpsertRosterMapping']({
        team_id: event.team_id,
        roster_id: event.roster_id,
        discord_channel_id: result.discord_channel_id as DiscordSchemas.Snowflake,
        discord_role_id: result.discord_role_id as DiscordSchemas.Snowflake,
      }),
    ),
    Effect.tap(({ result, rpc }) =>
      rpc['Channel/UpdateRosterChannel']({
        roster_id: event.roster_id,
        discord_channel_id: Option.some(result.discord_channel_id as DiscordSchemas.Snowflake),
      }),
    ),
    Effect.tap(({ result }) =>
      Effect.logInfo(
        `Synced roster_channel_created: roster ${event.roster_id} → Discord channel ${result.discord_channel_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
};
