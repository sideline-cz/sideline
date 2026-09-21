import { Discord, type Role, type Team } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect } from 'effect';
import { GuildRolesCache } from '~/services/GuildRolesCache.js';
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
    Effect.bind('rolesCache', () => GuildRolesCache.asEffect()),
    Effect.bind('role', ({ rest }) =>
      rest.createGuildRole(guildId, { name: roleName, permissions: 0 }),
    ),
    Effect.retry(retryPolicy),
    Effect.tap(({ role }) =>
      Effect.logInfo(`Auto-created Discord role "${roleName}" (${role.id}) in guild ${guildId}`),
    ),
    // Blocker (whole-series review of `GuildRolesCacheService`): a role created HERE, mid-tick,
    // must be visible to a LATER event's `handleMemberAdded` -> `rolesCache.get(guildId)` read in
    // the SAME tick — otherwise that later event sees the pre-creation cached list, treats this
    // brand-new role as "missing", and deletes the mapping just written below.
    //
    // Built from what THIS call is known to have requested/produced rather than trusted verbatim
    // off `role` (whose only contractually-read fields elsewhere have always been `id`/`name`):
    // `permissions: '0'` because that's exactly what was passed to `rest.createGuildRole` above,
    // and `managed: false` because Discord only ever sets `managed: true` on roles IT creates for
    // its own bots/integrations, never on one created via this user-facing endpoint. `position`
    // is irrelevant here — `GuildRolesCacheService`'s cached entries are read only for `id`
    // presence (`missing`) and `permissions` (`dangerous`) by `handleMemberAdded`, never for
    // `position` (that's only ever read off a FRESH `listGuildRoles` result, e.g. `pickAdoptableRole`).
    Effect.tap(({ role, rolesCache }) =>
      rolesCache.record(guildId, {
        id: role.id,
        name: roleName,
        permissions: '0',
        position: 0,
        managed: false,
      }),
    ),
    Effect.flatMap(({ role, rpc }) =>
      rpc['Role/UpsertMapping']({
        team_id: teamId,
        role_id: roleId,
        discord_role_id: Discord.Snowflake.makeUnsafe(role.id),
        adopted: false,
      }).pipe(
        // A freshly-minted Discord role id colliding with an existing mapping for a different
        // Sideline role is a Discord snowflake collision — never happens in production.
        Effect.catchTag('DiscordRoleAlreadyMapped', () =>
          LogicError.die(
            `Freshly created Discord role ${role.id} unexpectedly collided with an existing mapping`,
          ),
        ),
        Effect.map(() => role.id),
      ),
    ),
  );
