import { Discord as DiscordSchemas, type GroupModel, type Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Effect, Option } from 'effect';
import { isPermanentError } from '~/rcp/channel/ProcessorService.js';
import { SyncRpc } from '~/services/SyncRpc.js';
import { HIDDEN, READ_WRITE } from '../permissions.js';
import { allow, deny, retryPolicy } from '../utils.js';

const buildChannelParams = (
  guildId: DiscordSchemas.Snowflake,
  channelName: string,
  parentId?: DiscordSchemas.Snowflake,
) => ({
  name: channelName,
  type: Discord.ChannelTypes.GUILD_TEXT,
  permission_overwrites: [
    { id: guildId, type: Discord.ChannelPermissionOverwrites.ROLE, deny: deny(HIDDEN) },
  ],
  ...(parentId !== undefined ? { parent_id: parentId } : {}),
});

/**
 * Creates a hidden Discord text channel with an associated role. Returns channel + role IDs.
 *
 * When `parentId` is provided the channel is created inside that category.
 * Transient errors (5xx) are retried with `parent_id` still present — `retryPolicy`
 * only fires while the error is NOT permanent, so a permanent error exits immediately.
 * If the category is stale/invalid (permanent Discord error, e.g. 10003/404, 50035/400),
 * `catchIf(isPermanentError)` intercepts and falls back to guild-root channel creation
 * with its own `retryPolicy`. The fallback is terminal — no outer retry wraps it.
 */
export const createDiscordChannelAndRole = (
  guildId: DiscordSchemas.Snowflake,
  channelName: string,
  roleName: string,
  roleColor?: number,
  parentId?: DiscordSchemas.Snowflake,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('channel', ({ rest }) => {
      const rootParams = buildChannelParams(guildId, channelName, undefined);

      if (parentId === undefined) {
        return Effect.suspend(() => rest.createGuildChannel(guildId, rootParams)).pipe(
          Effect.retry(retryPolicy),
        );
      }

      const withParentParams = buildChannelParams(guildId, channelName, parentId);

      // Retry the with-parent call only while the error is transient (not permanent), so a
      // permanent error exits the retry immediately without burning retry budget.
      // catchIf then handles the permanent-error case: log a warning and fall back to
      // guild-root channel creation with its own retryPolicy. The fallback is terminal —
      // no outer retry wraps it, preventing duplicate guild-root channels on re-entry.
      return Effect.suspend(() => rest.createGuildChannel(guildId, withParentParams)).pipe(
        Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
        Effect.catchIf(isPermanentError, (error) =>
          Effect.logWarning(
            `Category ${parentId} is stale/invalid (${String(error)}); falling back to guild-root channel creation`,
          ).pipe(
            Effect.flatMap(() =>
              Effect.suspend(() => rest.createGuildChannel(guildId, rootParams)).pipe(
                Effect.retry(retryPolicy),
              ),
            ),
          ),
        ),
      );
    }),
    Effect.tap(({ channel }) =>
      Effect.logInfo(
        `Auto-created Discord channel "${channelName}" (${channel.id}) in guild ${guildId}`,
      ),
    ),
    Effect.bind('role', ({ rest }) =>
      rest
        .createGuildRole(guildId, { name: roleName, color: roleColor })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Auto-created Discord role "${roleName}" (${role.id}) in guild ${guildId}`),
    ),
    Effect.tap(({ channel, role, rest }) =>
      rest
        .setChannelPermissionOverwrite(channel.id, role.id, {
          type: Discord.ChannelPermissionOverwrites.ROLE,
          allow: allow(READ_WRITE),
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ channel, role }) =>
      Effect.logInfo(`Set role ${role.id} permission overwrite on channel ${channel.id}`),
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
    Effect.map(({ channel, role }) => ({
      discord_channel_id: channel.id as DiscordSchemas.Snowflake,
      discord_role_id: role.id as DiscordSchemas.Snowflake,
    })),
  );

export const createChannelWithRole = (
  teamId: Team.TeamId,
  groupId: GroupModel.GroupId,
  guildId: DiscordSchemas.Snowflake,
  channelName: string,
  roleName: string,
  roleColor?: number,
) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('result', () =>
      createDiscordChannelAndRole(guildId, channelName, roleName, roleColor),
    ),
    Effect.tap(({ result, rpc }) =>
      rpc['Channel/UpsertMapping']({
        team_id: teamId,
        group_id: groupId,
        discord_channel_id: result.discord_channel_id,
        discord_role_id: result.discord_role_id,
      }),
    ),
    Effect.map(({ result }) => result),
  );
