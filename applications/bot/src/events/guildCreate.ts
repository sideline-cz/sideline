import { Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import type * as DiscordTypes from 'dfx/types';
import { Array as Arr, Effect, Option, Schema } from 'effect';
import { DfxGuildMember, DfxSyncableChannel } from '~/schemas.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const decodeSnowflake = Schema.decodeSync(Discord.Snowflake);
const decodeSyncableChannel = Schema.decodeUnknownOption(DfxSyncableChannel);
const decodeGuildMember = Schema.decodeUnknownOption(DfxGuildMember);

export const handleGuildCreate = (
  guild: DiscordTypes.GatewayGuildCreateDispatchData,
): Effect.Effect<void, never, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.tap(({ rpc }) =>
      rpc['Guild/RegisterGuild']({
        guild_id: decodeSnowflake(guild.id),
        guild_name: guild.name,
        is_community_enabled: guild.features.some((f) => f === 'COMMUNITY'),
      }),
    ),
    Effect.tap(({ rpc, rest }) =>
      rest.listGuildChannels(guild.id).pipe(
        Effect.map((channels) =>
          Arr.getSomes(
            Arr.map(channels, (ch) =>
              Option.map(decodeSyncableChannel(ch), (decoded) => ({
                channel_id: decoded.id,
                name: decoded.name,
                type: decoded.type,
                parent_id: decoded.parent_id,
              })),
            ),
          ),
        ),
        Effect.tap((channels) =>
          rpc['Guild/SyncGuildChannels']({
            guild_id: decodeSnowflake(guild.id),
            channels,
          }),
        ),
        Effect.catchTag(
          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse', 'RpcClientError'],
          (error) => Effect.logError(`Failed to sync channels for guild ${guild.id}`, error),
        ),
      ),
    ),
    Effect.tap(({ rpc }) => {
      const roles = guild.roles ?? [];
      if (roles.length === 0) return Effect.void;
      return rpc['Guild/SyncGuildRoles']({
        guild_id: decodeSnowflake(guild.id),
        roles: Arr.map(roles, (r) => ({
          role_id: decodeSnowflake(r.id),
          name: r.name,
          color: r.color,
          position: r.position,
          managed: r.managed,
        })),
      }).pipe(
        Effect.catchTag('RpcClientError', (error) =>
          Effect.logError(`Failed to sync roles for guild ${guild.id}`, error),
        ),
      );
    }),
    Effect.tap(({ rpc, rest }) =>
      rest.listGuildMembers(guild.id, { limit: 1000 }).pipe(
        Effect.map((guildMembers) =>
          Arr.getSomes(
            Arr.map(guildMembers, (m) =>
              Option.flatMap(
                Option.filter(decodeGuildMember(m), (decoded) => !decoded.user.bot),
                (decoded) =>
                  Option.some({
                    discord_id: decoded.user.id,
                    username: decoded.user.username,
                    avatar: decoded.user.avatar,
                    roles: decoded.roles,
                    nickname: decoded.nick,
                    display_name: decoded.user.global_name,
                  }),
              ),
            ),
          ),
        ),
        Effect.tap((members) =>
          rpc['Guild/ReconcileMembers']({
            guild_id: decodeSnowflake(guild.id),
            members,
          }),
        ),
        Effect.catchTag(
          ['HttpClientError', 'RatelimitedResponse', 'ErrorResponse', 'RpcClientError'],
          (error) => Effect.logError(`Failed to reconcile members for guild ${guild.id}`, error),
        ),
      ),
    ),
    Effect.catchTag('RpcClientError', (error) =>
      Effect.logError(`Failed to register guild ${guild.id}`, error),
    ),
    Effect.asVoid,
  );
