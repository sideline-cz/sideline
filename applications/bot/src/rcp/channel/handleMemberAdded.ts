import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect, Option } from 'effect';
import { createRoleForChannel } from '~/rest/channels/createRoleForChannel.js';
import { createRoleOnly } from '~/rest/channels/createRoleOnly.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

export const handleMemberAdded = (event: ChannelRpcEvents.GroupMemberAddedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('cached', ({ rpc }) =>
      rpc['Channel/GetMapping']({ team_id: event.team_id, group_id: event.group_id }),
    ),
    Effect.bind('roleId', ({ rpc, cached }) =>
      Option.match(cached, {
        onSome: (mapping) =>
          Option.match(mapping.discord_role_id, {
            onSome: (roleId) => Effect.succeed(roleId),
            onNone: () =>
              Effect.flatMap(Effect.fromOption(mapping.discord_channel_id), (channelId) =>
                Effect.Do.pipe(
                  Effect.bind('result', () =>
                    createRoleForChannel(event.guild_id, channelId, event.group_name),
                  ),
                  Effect.tap(({ result }) =>
                    rpc['Channel/UpsertMapping']({
                      team_id: event.team_id,
                      group_id: event.group_id,
                      discord_channel_id: result.discord_channel_id,
                      discord_role_id: result.discord_role_id,
                    }),
                  ),
                  Effect.map(({ result }) => result.discord_role_id),
                ),
              ).pipe(
                Effect.catchTag('NoSuchElementError', () =>
                  Effect.Do.pipe(
                    Effect.bind('result', () => createRoleOnly(event.guild_id, event.group_name)),
                    Effect.tap(({ result }) =>
                      rpc['Channel/UpsertMappingRoleOnly']({
                        team_id: event.team_id,
                        group_id: event.group_id,
                        discord_role_id: result.discord_role_id,
                      }),
                    ),
                    Effect.map(({ result }) => result.discord_role_id),
                  ),
                ),
              ),
          }),
        onNone: () =>
          Effect.Do.pipe(
            Effect.bind('result', () => createRoleOnly(event.guild_id, event.group_name)),
            Effect.tap(({ result }) =>
              rpc['Channel/UpsertMappingRoleOnly']({
                team_id: event.team_id,
                group_id: event.group_id,
                discord_role_id: result.discord_role_id,
              }),
            ),
            Effect.map(({ result }) => result.discord_role_id),
          ),
      }),
    ),
    Effect.tap(({ rest, roleId }) =>
      rest
        .addGuildMemberRole(event.guild_id, event.discord_user_id, roleId)
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Assigned role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );

export const handleRosterMemberAdded = (event: ChannelRpcEvents.RosterMemberAddedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('cached', ({ rpc }) =>
      rpc['Channel/GetRosterMapping']({ team_id: event.team_id, roster_id: event.roster_id }),
    ),
    Effect.bind('mapping', ({ cached }) => Effect.fromOption(cached)),
    Effect.bind('roleId', ({ mapping }) => Effect.fromOption(mapping.discord_role_id)),
    Effect.tap(({ rest, roleId }) =>
      rest
        .addGuildMemberRole(event.guild_id, event.discord_user_id, roleId)
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Assigned role ${roleId} to user ${event.discord_user_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
    Effect.catchTag('NoSuchElementError', () =>
      Effect.logWarning(
        `No mapping or role found for roster ${event.roster_id} in guild ${event.guild_id}, skipping member_added`,
      ),
    ),
  );
