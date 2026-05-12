import type { Discord as DiscordSchemas } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { retryPolicy } from '../utils.js';

/** Creates a Discord guild role. Returns the new role id. */
export const createRoleOnly = (
  guildId: DiscordSchemas.Snowflake,
  roleName: string,
  roleColor?: number,
) =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('role', ({ rest }) =>
      rest
        .createGuildRole(guildId, { name: roleName, color: roleColor })
        .pipe(Effect.retry(retryPolicy)),
    ),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Auto-created Discord role "${roleName}" (${role.id}) in guild ${guildId}`),
    ),
    Effect.map(({ role }) => ({
      discord_role_id: role.id as DiscordSchemas.Snowflake,
    })),
  );
