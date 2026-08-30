import type { Discord, RoleRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx';
import { Effect } from 'effect';
import { SyncRpc } from '~/index.js';
import { retryPolicy } from '~/rest/utils.js';

/** Blocker 2: `mapping.adopted` is `true` when `discord_role_id` points at a pre-existing Discord
 * role Sideline adopted rather than created. Deleting the Sideline role must NEVER delete an
 * adopted Discord role — it may be a hand-made role with members Sideline has never tracked (e.g.
 * a club's "Veterans" role held by 30 people), and `role.ts`'s delete guard only blocks deleting a
 * Sideline role that still has Sideline members, which says nothing about the Discord side. Only
 * the mapping is removed for an adopted role; the Discord role itself is left untouched. */
const deleteUnderlyingDiscordRole = (
  mapping: { readonly discord_role_id: Discord.Snowflake; readonly adopted: boolean },
  guildId: Discord.Snowflake,
) =>
  mapping.adopted
    ? Effect.logInfo(
        `Role deleted in Sideline was mapped to adopted Discord role ${mapping.discord_role_id} in guild ${guildId}; leaving the Discord role in place and removing only the mapping`,
      )
    : Effect.Do.pipe(
        Effect.bind('rest', () => DiscordREST.asEffect()),
        Effect.tap(({ rest }) =>
          rest.deleteGuildRole(guildId, mapping.discord_role_id).pipe(Effect.retry(retryPolicy)),
        ),
        Effect.tap(() =>
          Effect.logInfo(`Deleted Discord role ${mapping.discord_role_id} in guild ${guildId}`),
        ),
        Effect.asVoid,
      );

export const handleDeleted = (event: RoleRpcEvents.RoleDeletedEvent) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('cached', ({ rpc }) =>
      rpc['Role/GetMapping']({
        team_id: event.team_id,
        role_id: event.role_id,
      }),
    ),
    Effect.bind('mapping', ({ cached }) => Effect.fromOption(cached)),
    Effect.tapErrorTag('NoSuchElementError', () =>
      Effect.logWarning(
        `No mapping found for role ${event.role_id} in guild ${event.guild_id}, skipping delete`,
      ),
    ),
    Effect.tap(({ mapping }) => deleteUnderlyingDiscordRole(mapping, event.guild_id)),
    Effect.tap(({ rpc }) =>
      rpc['Role/DeleteMapping']({
        team_id: event.team_id,
        role_id: event.role_id,
      }),
    ),
    Effect.asVoid,
    Effect.catchTag('NoSuchElementError', () =>
      Effect.logWarning(
        `No mapping found for role ${event.role_id} in guild ${event.guild_id}, skipping role delete`,
      ),
    ),
  );
