import type { Discord } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Effect, Ref, ServiceMap } from 'effect';
import type { AdoptableCandidateRole } from '~/rest/roles/adoptableGuildRole.js';

export interface GuildRolesCacheService {
  /** Returns `listGuildRoles(guildId)`, fetching once and reusing the result for every
   * subsequent call with the same `guildId` against THIS cache instance. */
  readonly get: (
    guildId: Discord.Snowflake,
  ) => Effect.Effect<ReadonlyArray<AdoptableCandidateRole>, unknown, DiscordREST>;
}

const makeCache: Effect.Effect<GuildRolesCacheService> = Effect.map(
  Ref.make(new Map<string, ReadonlyArray<AdoptableCandidateRole>>()),
  (cacheRef): GuildRolesCacheService => ({
    get: (guildId) =>
      Ref.get(cacheRef).pipe(
        Effect.flatMap((cache) => {
          const hit = cache.get(guildId);
          if (hit !== undefined) return Effect.succeed(hit);
          return DiscordREST.asEffect().pipe(
            Effect.flatMap((rest) => rest.listGuildRoles(guildId)),
            Effect.tap((roles) => Ref.update(cacheRef, (map) => new Map(map).set(guildId, roles))),
          );
        }),
      ),
  }),
);

/**
 * Blocker 3's per-tick `listGuildRoles` cache: `handleMemberAdded` must re-validate a target
 * role's permissions immediately before `addGuildMemberRole` (a role's permissions can change in
 * Discord at any time after it was mapped), but doing that with a fresh REST call per event would
 * turn one busy tick's worth of `role_assigned` events into a `listGuildRoles` call per event.
 *
 * This is deliberately NOT a `Layer`/long-lived service — a cache that survives past one
 * processor tick would miss exactly the permission change it exists to catch. `ProcessorService`
 * builds a fresh instance (via `GuildRolesCache.make`) at the top of every `processTick`
 * execution and provides it only for that tick's batch of events.
 */
export class GuildRolesCache extends ServiceMap.Service<GuildRolesCache, GuildRolesCacheService>()(
  'bot/GuildRolesCache',
) {
  static readonly make = makeCache;
}
