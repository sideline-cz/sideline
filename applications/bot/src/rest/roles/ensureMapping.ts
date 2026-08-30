import { Discord, type Role, type Team } from '@sideline/domain';
import { DiscordREST } from 'dfx/DiscordREST';
import { Array as Arr, Cause, Effect, Option, pipe } from 'effect';
import { SyncRpc } from '~/services/SyncRpc.js';
import { type AdoptableCandidateRole, pickAdoptableRole } from './adoptableGuildRole.js';
import { createGuildRole } from './createGuildRole.js';

/** The bot's own top role position: the max position of any role it has, or -1 if unknown
 * (`getMyGuildMember` failed, or its `roles` share nothing with `listGuildRoles`). `-1` is a
 * deliberate fail-safe: `pickAdoptableRole`'s `position < botTopPosition` guard can never be
 * satisfied against it (no valid Discord role position is negative), so an unknown bot position
 * always falls through to `createGuildRole` rather than risking a `50013` from assigning at/above
 * a position we cannot verify. */
const botTopPosition = (
  roles: ReadonlyArray<AdoptableCandidateRole>,
  botRoleIds: ReadonlyArray<string>,
): number =>
  pipe(
    roles,
    Arr.filter((role) => botRoleIds.includes(role.id)),
    Arr.map((role) => role.position),
    Arr.reduce(-1, (acc, position) => Math.max(acc, position)),
  );

const describeRejection = (role: AdoptableCandidateRole, botTop: number): Option.Option<string> => {
  const reasons: Array<string> = [];
  if (role.managed) reasons.push('managed');
  if (role.permissions !== '0') reasons.push(`permissions=${role.permissions}`);
  if (botTop < 0) {
    reasons.push("bot's position unknown");
  } else if (role.position >= botTop) {
    reasons.push(`position ${role.position} >= bot's ${botTop}`);
  }
  return reasons.length === 0 ? Option.none() : Option.some(reasons.join(', '));
};

/** Every role named `roleName` that was rejected for adoption, with its rejection reason. */
const findNearMisses = (
  roles: ReadonlyArray<AdoptableCandidateRole>,
  roleName: string,
  botTop: number,
): ReadonlyArray<{ readonly id: string; readonly reason: string }> =>
  pipe(
    roles,
    Arr.filter((role) => role.name === roleName),
    Arr.map((role) =>
      Option.map(describeRejection(role, botTop), (reason) => ({ id: role.id, reason })),
    ),
    Arr.getSomes,
  );

const logNearMisses = (
  roles: ReadonlyArray<AdoptableCandidateRole>,
  guildId: Discord.Snowflake,
  roleName: string,
  botTop: number,
) => {
  const misses = findNearMisses(roles, roleName, botTop);
  if (misses.length === 0) return Effect.void;
  // Level an operator will actually see: this is the design-problem case where a captain's
  // pre-existing "Captain"/"Player" role sits above the bot's own top role (the ordinary default
  // install shape — an OAuth-invited bot lands at position 1). Name the remedy so a report of this
  // log line is directly actionable without reading the source.
  return Effect.logWarning(
    `Guild ${guildId}: found ${misses.length} near-miss role(s) named "${roleName}" not adopted: ${misses
      .map((miss) => `${miss.id} (${miss.reason})`)
      .join(
        '; ',
      )}. If this is a position rejection, move the Sideline bot role above ${roleName} in Server Settings → Roles, then re-run role sync.`,
  );
};

/** Tier 2: adopt an existing guild role by name, from live Discord state. */
const adoptExistingRole = (
  teamId: Team.TeamId,
  roleId: Role.RoleId,
  guildId: Discord.Snowflake,
  roleName: string,
) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('rest', () => DiscordREST.asEffect()),
    Effect.bind('roles', ({ rest }) => rest.listGuildRoles(guildId)),
    Effect.bind('me', ({ rest }) => rest.getMyGuildMember(guildId)),
    Effect.let('topPosition', ({ roles, me }) => botTopPosition(roles, me.roles)),
    Effect.tap(({ roles, topPosition }) => logNearMisses(roles, guildId, roleName, topPosition)),
    Effect.bind('picked', ({ roles, topPosition }) =>
      Effect.fromOption(pickAdoptableRole(roles, roleName, topPosition)),
    ),
    Effect.tap(({ picked }) =>
      Effect.logInfo(
        `Adopted existing Discord role "${roleName}" (${picked.id}, position ${picked.position}) in guild ${guildId} instead of creating a new one`,
      ),
    ),
    Effect.tap(({ rpc, picked }) =>
      rpc['Role/UpsertMapping']({
        team_id: teamId,
        role_id: roleId,
        discord_role_id: Discord.Snowflake.makeUnsafe(picked.id),
        adopted: true,
      }),
    ),
    Effect.map(({ picked }) => Discord.Snowflake.makeUnsafe(picked.id)),
  );

export const ensureMapping = (
  teamId: Team.TeamId,
  roleId: Role.RoleId,
  guildId: Discord.Snowflake,
  roleName: string,
) =>
  Effect.Do.pipe(
    Effect.bind('rpc', () => SyncRpc.asEffect()),
    Effect.bind('cached', ({ rpc }) =>
      rpc['Role/GetMapping']({ team_id: teamId, role_id: roleId }),
    ),
    Effect.flatMap(({ cached }) => Effect.fromOption(cached)),
    Effect.map(({ discord_role_id }) => discord_role_id),
    Effect.catchTag('NoSuchElementError', () =>
      adoptExistingRole(teamId, roleId, guildId, roleName).pipe(
        // Every non-happy-path outcome of tier 2 — no adoptable candidate, a Discord hiccup while
        // resolving candidates, or the target Discord role already claimed by another Sideline
        // role in this team — is converted to the SAME `NoSuchElementError` tag below, so
        // `createGuildRole` is reached from exactly one `catchTag`, exactly once. Blocker 1: the
        // previous shape chained two independent `catchTag`s in one `.pipe()`, so the second
        // (meant for tier-2 REST failures) also caught failures coming out of the first's
        // `createGuildRole` call, invoking it a second time on failure.
        Effect.catchTag(['HttpClientError', 'RatelimitedResponse', 'ErrorResponse'], (error) =>
          Effect.logWarning(
            `Failed to resolve adoptable role for guild ${guildId}; creating a new role instead`,
            error,
          ).pipe(Effect.flatMap(() => Effect.fail(new Cause.NoSuchElementError()))),
        ),
        // The 23505 on `UNIQUE(team_id, discord_role_id)` — reachable via a Sideline role rename
        // (no `role_renamed` event exists to clear the stale mapping) followed by a different role
        // adopting the same Discord role. Safe to fall through to create: a fresh, zero-permission
        // role is never wrong, and the alternative (treating this as terminal) stalls the event.
        Effect.catchTag('DiscordRoleAlreadyMapped', () =>
          Effect.logWarning(
            `Adoptable Discord role for "${roleName}" in guild ${guildId} is already mapped to another Sideline role; creating a new role instead`,
          ).pipe(Effect.flatMap(() => Effect.fail(new Cause.NoSuchElementError()))),
        ),
        Effect.catchTag('NoSuchElementError', () =>
          createGuildRole(teamId, roleId, guildId, roleName),
        ),
      ),
    ),
  );
