import { Discord, type Role, type Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { retryPolicy } from '../utils.js';

export const createGuildRole = (
  teamId: Team.TeamId,
  roleId: Role.RoleId,
  guildId: Discord.Snowflake,
  roleName: string,
) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('role', ({ rest }) =>
      rest.createGuildRole(guildId, { name: roleName, permissions: 0 }),
    ),
    Effect.retry(retryPolicy),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Auto-created Discord role "${roleName}" (${role.id}) in guild ${guildId}`),
    ),
    Effect.flatMap(({ role, rpc }) =>
      rpc['Role/UpsertMapping']({
        team_id: teamId,
        role_id: roleId,
        discord_role_id: Discord.Snowflake.makeUnsafe(role.id),
      }).pipe(Effect.map(() => role.id)),
    ),
  );
