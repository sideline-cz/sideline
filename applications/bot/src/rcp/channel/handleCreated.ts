import type { ChannelRpcEvents } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { createChannelOnly } from '~/rest/channels/createChannelOnly.js';
import { createRoleForChannel } from '~/rest/channels/createRoleForChannel.js';
import { createRoleOnly } from '~/rest/channels/createRoleOnly.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleCreated = (event: ChannelRpcEvents.GroupChannelCreatedEvent) => {
  const roleColor = Option.getOrUndefined(event.discord_role_color);

  return Option.match(event.existing_channel_id, {
    onSome: (channelId) =>
      Effect.Do.pipe(
        Effect.bind('rpc', () => SyncRpc.asEffect()),
        Effect.bind('result', () =>
          createRoleForChannel(event.guild_id, channelId, event.discord_role_name, roleColor),
        ),
        Effect.tap(({ result, rpc }) =>
          rpc['Channel/UpsertMapping']({
            team_id: event.team_id,
            group_id: event.group_id,
            discord_channel_id: result.discord_channel_id,
            discord_role_id: result.discord_role_id,
          }),
        ),
        Effect.tap(({ result }) =>
          Effect.logInfo(
            `Synced group_channel_created (link): group ${event.group_id} → Discord channel ${result.discord_channel_id} in guild ${event.guild_id}`,
          ),
        ),
        Effect.asVoid,
      ),
    onNone: () =>
      Option.match(event.discord_channel_name, {
        onSome: (channelName) =>
          Effect.Do.pipe(
            Effect.bind('rpc', () => SyncRpc.asEffect()),
            Effect.bind('channelResult', () => createChannelOnly(event.guild_id, channelName)),
            // Persist the channel ID immediately before role creation to avoid orphan channels on retry
            Effect.tap(({ channelResult, rpc }) =>
              rpc['Channel/UpsertGroupChannel']({
                team_id: event.team_id,
                group_id: event.group_id,
                discord_channel_id: channelResult.discord_channel_id,
              }),
            ),
            Effect.bind('roleResult', ({ channelResult }) =>
              createRoleForChannel(
                event.guild_id,
                channelResult.discord_channel_id,
                event.discord_role_name,
                roleColor,
              ),
            ),
            Effect.tap(({ roleResult, rpc }) =>
              rpc['Channel/UpsertMapping']({
                team_id: event.team_id,
                group_id: event.group_id,
                discord_channel_id: roleResult.discord_channel_id,
                discord_role_id: roleResult.discord_role_id,
              }),
            ),
            Effect.tap(({ roleResult }) =>
              Effect.logInfo(
                `Synced group_channel_created (new): group ${event.group_id} → Discord channel ${roleResult.discord_channel_id} in guild ${event.guild_id}`,
              ),
            ),
            Effect.asVoid,
          ),
        onNone: () =>
          Effect.Do.pipe(
            Effect.bind('rpc', () => SyncRpc.asEffect()),
            Effect.bind('cached', ({ rpc }) =>
              rpc['Channel/GetMapping']({ team_id: event.team_id, group_id: event.group_id }),
            ),
            Effect.flatMap(({ rpc, cached }) =>
              Option.match(cached, {
                onSome: (mapping) =>
                  Option.match(mapping.discord_role_id, {
                    onSome: (roleId) =>
                      Effect.logInfo(
                        `group_channel_created (role-only) skipped: mapping already has role ${roleId} for group ${event.group_id}`,
                      ),
                    onNone: () =>
                      Effect.fromOption(mapping.discord_channel_id).pipe(
                        Effect.flatMap((channelId) =>
                          Effect.Do.pipe(
                            Effect.bind('roleResult', () =>
                              createRoleForChannel(
                                event.guild_id,
                                channelId,
                                event.discord_role_name,
                                roleColor,
                              ),
                            ),
                            Effect.tap(({ roleResult }) =>
                              rpc['Channel/UpsertMapping']({
                                team_id: event.team_id,
                                group_id: event.group_id,
                                discord_channel_id: roleResult.discord_channel_id,
                                discord_role_id: roleResult.discord_role_id,
                              }),
                            ),
                            Effect.tap(({ roleResult }) =>
                              Effect.logInfo(
                                `Synced group_channel_created (role-only→channel+role): group ${event.group_id} → Discord role ${roleResult.discord_role_id} in guild ${event.guild_id}`,
                              ),
                            ),
                            Effect.asVoid,
                          ),
                        ),
                        Effect.catchTag('NoSuchElementError', () =>
                          Effect.Do.pipe(
                            Effect.bind('roleResult', () =>
                              createRoleOnly(event.guild_id, event.discord_role_name, roleColor),
                            ),
                            Effect.tap(({ roleResult }) =>
                              rpc['Channel/UpsertMappingRoleOnly']({
                                team_id: event.team_id,
                                group_id: event.group_id,
                                discord_role_id: roleResult.discord_role_id,
                              }),
                            ),
                            Effect.tap(({ roleResult }) =>
                              Effect.logInfo(
                                `Synced group_channel_created (role-only): group ${event.group_id} → Discord role ${roleResult.discord_role_id} in guild ${event.guild_id}`,
                              ),
                            ),
                            Effect.asVoid,
                          ),
                        ),
                      ),
                  }),
                onNone: () =>
                  Effect.Do.pipe(
                    Effect.bind('roleResult', () =>
                      createRoleOnly(event.guild_id, event.discord_role_name, roleColor),
                    ),
                    Effect.tap(({ roleResult }) =>
                      rpc['Channel/UpsertMappingRoleOnly']({
                        team_id: event.team_id,
                        group_id: event.group_id,
                        discord_role_id: roleResult.discord_role_id,
                      }),
                    ),
                    Effect.tap(({ roleResult }) =>
                      Effect.logInfo(
                        `Synced group_channel_created (role-only): group ${event.group_id} → Discord role ${roleResult.discord_role_id} in guild ${event.guild_id}`,
                      ),
                    ),
                    Effect.asVoid,
                  ),
              }),
            ),
          ),
      }),
  });
};
