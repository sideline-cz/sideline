import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Option } from 'effect';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleGroupChannelUpdated = (event: ChannelRpcEvents.GroupChannelUpdatedEvent) => {
  const roleColor = Option.getOrElse(event.discord_role_color, () => 0);
  const hasChannel = Option.isSome(event.discord_channel_id);
  const hasRole = Option.isSome(event.discord_role_id);

  if (!hasChannel && !hasRole) {
    return Effect.logWarning(
      `group_channel_updated for group ${event.group_id} in guild ${event.guild_id} has neither channel nor role — no-op`,
    );
  }

  return Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.tap(({ rest }) =>
      Option.match(event.discord_role_id, {
        onNone: () => Effect.void,
        onSome: (roleId) =>
          rest
            .updateGuildRole(event.guild_id, roleId, {
              name: event.discord_role_name,
              color: roleColor,
            })
            .pipe(
              Effect.retry(retryPolicy),
              Effect.tap(() =>
                Effect.logInfo(
                  `Updated Discord role ${roleId} name="${event.discord_role_name}" in guild ${event.guild_id}`,
                ),
              ),
            ),
      }),
    ),
    Effect.tap(({ rest, rpc }) =>
      Option.match(event.discord_channel_id, {
        onNone: () => Effect.void,
        onSome: (channelId) =>
          rest.updateChannel(channelId, { name: event.discord_channel_name }).pipe(
            Effect.retry(retryPolicy),
            Effect.tap(() =>
              Effect.logInfo(
                `Updated Discord channel ${channelId} name="${event.discord_channel_name}" in guild ${event.guild_id}`,
              ),
            ),
            Effect.tap(() =>
              rpc['Guild/UpdateChannelName']({
                channel_id: channelId,
                name: event.discord_channel_name,
              }),
            ),
            Effect.tap(() =>
              Effect.logInfo(`Synced channel name update for ${channelId} to server`),
            ),
          ),
      }),
    ),
    Effect.asVoid,
  );
};

export const handleRosterChannelUpdated = (event: ChannelRpcEvents.RosterChannelUpdatedEvent) => {
  const roleColor = Option.getOrElse(event.discord_role_color, () => 0);
  return Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.tap(({ rest }) =>
      rest
        .updateGuildRole(event.guild_id, event.discord_role_id, {
          name: event.discord_role_name,
          color: roleColor,
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Updated Discord role ${event.discord_role_id} name="${event.discord_role_name}" in guild ${event.guild_id}`,
      ),
    ),
    Effect.tap(({ rest }) =>
      rest
        .updateChannel(event.discord_channel_id, { name: event.discord_channel_name })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(() =>
      Effect.logInfo(
        `Updated Discord channel ${event.discord_channel_id} name="${event.discord_channel_name}" in guild ${event.guild_id}`,
      ),
    ),
    Effect.tap(({ rpc }) =>
      rpc['Guild/UpdateChannelName']({
        channel_id: event.discord_channel_id,
        name: event.discord_channel_name,
      }),
    ),
    Effect.tap(() =>
      Effect.logInfo(`Synced channel name update for ${event.discord_channel_id} to server`),
    ),
    Effect.asVoid,
  );
};
