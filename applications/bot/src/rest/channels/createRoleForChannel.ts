import { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import * as Discord from 'dfx/types';
import { Effect } from 'effect';
import { READ_WRITE } from '../permissions.js';
import { allow, retryPolicy } from '../utils.js';

/** Creates a Discord role and sets READ_WRITE permission overwrite on an existing channel. */
export const createRoleForChannel = (
  guildId: DiscordSchemas.Snowflake,
  channelId: DiscordSchemas.Snowflake,
  roleName: string,
  roleColor?: number,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('role', ({ rest }) =>
      rest
        .createGuildRole(guildId, { name: roleName, color: roleColor, permissions: 0 })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Auto-created Discord role "${roleName}" (${role.id}) in guild ${guildId}`),
    ),
    Effect.tap(({ role, rest }) =>
      rest
        .setChannelPermissionOverwrite(channelId, role.id, {
          type: Discord.ChannelPermissionOverwrites.ROLE,
          allow: allow(READ_WRITE),
        })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Set role ${role.id} permission overwrite on channel ${channelId}`),
    ),
    Effect.map(({ role }) => ({
      discord_channel_id: channelId,
      discord_role_id: DiscordSchemas.Snowflake.makeUnsafe(role.id),
    })),
  );
