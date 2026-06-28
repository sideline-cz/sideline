import type { ChannelRpcEvents } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Exit } from 'effect';
import { isPermanentError } from '~/rcp/channel/ProcessorService.js';
import { retryPolicy } from '~/rest/utils.js';
import { SyncRpc } from '~/services/SyncRpc.js';

const MAX_PAGES = 50;
const PAGE_LIMIT = 1000;

/**
 * Paginate listGuildMembers and collect all user IDs that hold the given roleId.
 * Returns an empty array and logs a warning if any page fetch fails.
 */
const collectRoleHolders = (
  event: ChannelRpcEvents.RosterRoleReconcileEvent,
): Effect.Effect<ReadonlyArray<string>, never, DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.flatMap(({ rest }) => {
      const go = (
        after: string | undefined,
        page: number,
        acc: string[],
      ): Effect.Effect<string[], never> => {
        if (page > MAX_PAGES) {
          return Effect.logWarning(
            `listGuildMembers pagination hit MAX_PAGES (${MAX_PAGES}) for guild ${event.guild_id} role ${event.discord_role_id}; stopping early`,
          ).pipe(Effect.as(acc));
        }

        // dfx types `after` as number but Discord snowflakes are strings at runtime;
        // we pass a string cursor to satisfy the Discord API while suppressing the incorrect type.
        const opts: { limit: number; after?: number } = { limit: PAGE_LIMIT };
        if (after !== undefined) {
          // @ts-expect-error dfx types `after` as number but Discord snowflakes are string ids
          opts.after = after;
        }

        return rest.listGuildMembers(event.guild_id, opts).pipe(
          Effect.flatMap((members) => {
            const holders = members
              .filter((m) => m.roles.includes(event.discord_role_id))
              .map((m) => m.user.id);

            const nextAcc = [...acc, ...holders];

            if (members.length < PAGE_LIMIT) {
              return Effect.succeed(nextAcc);
            }

            // Use BigInt comparison to find the maximum snowflake id on this page,
            // guarding against non-guaranteed ordering (snowflakes exceed Number.MAX_SAFE_INTEGER).
            const nextAfter = members.reduce((maxId, m) => {
              const memberId = m.user.id;
              return BigInt(memberId) > BigInt(maxId) ? memberId : maxId;
            }, members[0]?.user.id);

            return go(nextAfter, page + 1, nextAcc);
          }),
          Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
            Effect.logWarning(
              `Failed to list guild members for roster role reconcile in guild ${event.guild_id}`,
              error,
            ).pipe(Effect.as<string[]>([])),
          ),
        );
      };

      return go(undefined, 1, []);
    }),
  );

export const handleRosterRoleReconcile = (
  event: ChannelRpcEvents.RosterRoleReconcileEvent,
): Effect.Effect<void, unknown, SyncRpc | DiscordREST> =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('expectedList', ({ rpc }) =>
      rpc['Channel/GetExpectedRoleHolders']({
        team_id: event.team_id,
        discord_role_id: event.discord_role_id,
      }),
    ),
    Effect.let(
      'expected',
      ({ expectedList }) => new Set<string>(expectedList.map((r) => String(r.discord_user_id))),
    ),
    Effect.bind('holdersRaw', () => collectRoleHolders(event)),
    Effect.let('extras', ({ expected, holdersRaw }) =>
      holdersRaw.filter((userId) => !expected.has(userId)),
    ),
    Effect.tap(({ rest, extras }) =>
      Effect.forEach(
        extras,
        (userId) =>
          Effect.suspend(() =>
            rest.deleteGuildMemberRole(event.guild_id, userId, event.discord_role_id),
          ).pipe(
            Effect.retry({ schedule: retryPolicy, while: (e) => !isPermanentError(e) }),
            Effect.exit,
            Effect.flatMap((exit) =>
              Exit.match(exit, {
                onSuccess: () => Effect.void,
                onFailure: (cause) =>
                  Effect.logWarning(
                    `Failed to remove role ${event.discord_role_id} from user ${userId} in guild ${event.guild_id}: ${String(cause)}`,
                  ),
              }),
            ),
          ),
        { concurrency: 1 },
      ),
    ),
    Effect.tap(({ extras }) =>
      Effect.logInfo(
        `Roster role reconcile: removed ${extras.length} extra(s) for role ${event.discord_role_id} in guild ${event.guild_id}`,
      ),
    ),
    Effect.asVoid,
  );
