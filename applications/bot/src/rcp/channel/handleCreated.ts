import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Exit, Option } from 'effect';
import { isPermanentError } from '~/rcp/channel/ProcessorService.js';
import { createChannelOnly } from '~/rest/channels/createChannelOnly.js';
import { createRoleForChannel } from '~/rest/channels/createRoleForChannel.js';
import { createRoleOnly } from '~/rest/channels/createRoleOnly.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc, type SyncRpcClient } from '~/services/SyncRpc.js';

// Shared helper for the role-only path when no mapping exists (or mapping has no role and no
// channel). Creates the role and persists the role-only mapping. Used for both the "no mapping"
// and "mapping with both ids None" cases — they are identical.
const provisionRoleOnly = (
  rpc: SyncRpcClient,
  event: ChannelRpcEvents.GroupChannelCreatedEvent,
  roleColor: number | undefined,
) =>
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
    Effect.map(({ roleResult }) => roleResult.discord_role_id),
  );

export const handleCreated = (event: ChannelRpcEvents.GroupChannelCreatedEvent) => {
  const roleColor = Option.getOrUndefined(event.discord_role_color);

  return Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roleId', ({ rpc }) =>
      Option.match(event.existing_channel_id, {
        // Branch 1: existing channel supplied → create role for it, upsert mapping, yield role id
        onSome: (channelId) =>
          Effect.Do.pipe(
            Effect.bind('result', () =>
              createRoleForChannel(event.guild_id, channelId, event.discord_role_name, roleColor),
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
        onNone: () =>
          Option.match(event.discord_channel_name, {
            // Branch 2: new channel + role → create channel, persist channel id BEFORE role to
            // avoid orphans on retry, then create role, upsert full mapping, yield role id
            onSome: (channelName) =>
              Effect.Do.pipe(
                Effect.bind('channelResult', () => createChannelOnly(event.guild_id, channelName)),
                // Persist the channel ID immediately before role creation to avoid orphan channels on retry
                Effect.tap(({ channelResult }) =>
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
                Effect.tap(({ roleResult }) =>
                  rpc['Channel/UpsertMapping']({
                    team_id: event.team_id,
                    group_id: event.group_id,
                    discord_channel_id: roleResult.discord_channel_id,
                    discord_role_id: roleResult.discord_role_id,
                  }),
                ),
                Effect.map(({ roleResult }) => roleResult.discord_role_id),
              ),
            // Branch 3–5: role-only path — GetMapping-first for idempotency
            onNone: () =>
              Effect.Do.pipe(
                Effect.bind('cached', () =>
                  rpc['Channel/GetMapping']({ team_id: event.team_id, group_id: event.group_id }),
                ),
                Effect.flatMap(({ cached }) =>
                  Option.match(cached, {
                    onSome: (mapping) =>
                      Option.match(mapping.discord_role_id, {
                        // Branch 3: mapping already has role → reuse it, no creation, no upsert
                        onSome: (existingRoleId) => Effect.succeed(existingRoleId),
                        onNone: () =>
                          Option.match(mapping.discord_channel_id, {
                            // Branch 4: mapping has channel but no role → create role for that channel
                            onSome: (channelId) =>
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
                                Effect.map(({ roleResult }) => roleResult.discord_role_id),
                              ),
                            // Branch 5a: mapping has no channel and no role → provision role only
                            onNone: () => provisionRoleOnly(rpc, event, roleColor),
                          }),
                      }),
                    // Branch 5b: no mapping at all → provision role only
                    onNone: () => provisionRoleOnly(rpc, event, roleColor),
                  }),
                ),
              ),
          }),
      }),
    ),
    // Shared backfill step: read group members and assign the resolved role to each
    Effect.bind('members', ({ rpc }) =>
      rpc['Channel/GetGroupMembers']({ team_id: event.team_id, group_id: event.group_id }),
    ),
    Effect.tap(({ rest, roleId, members }) =>
      Effect.forEach(
        members,
        (member) =>
          rest.addGuildMemberRole(event.guild_id, member.discord_user_id, roleId).pipe(
            Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.match(exit, {
                onSuccess: () => Effect.void,
                onFailure: (cause) =>
                  Effect.logWarning(
                    `Failed to add role ${roleId} to member ${member.team_member_id} (discord user ${member.discord_user_id}): ${String(cause)}`,
                  ),
              }),
            ),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.tap(({ roleId }) =>
      Effect.logInfo(
        `Synced group_channel_created: group ${event.group_id} → role ${roleId} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
};
