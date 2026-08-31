import type { Discord, Team, TeamMember } from '@sideline/domain';
import { RoleApi } from '@sideline/domain';
import { Array, Effect, Option, type ServiceMap } from 'effect';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

/**
 * Cap on the number of role_sync_events a single manual sync enqueues for one member. This is a
 * captain-triggered, single-member action — not a bulk backfill — so a member legitimately
 * needing more than this many role changes in one sync is a sign something upstream is wrong,
 * not a case to special-case. PR-8's level-based reconciliation reuses this same constant as its
 * per-member cap.
 */
export const MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER = 25;

const neverSyncedResult = new RoleApi.SyncMemberRolesResult({
  addedCount: 0,
  removedCount: 0,
  skippedCount: 1,
  roleSyncState: 'never',
  lastRoleSyncAt: Option.none(),
  lastRoleSyncError: Option.none(),
});

/**
 * Pushes one member's current effective Sideline roles into Discord by enqueueing
 * `role_assigned` / `role_unassigned` rows onto `role_sync_events` for the bot's (concurrency: 1)
 * role loop to drain. This never talks to Discord directly — it only computes a diff and queues
 * events, which is why the result is reported as "queued", not "synced".
 *
 * - **desired** = the member's effective Sideline roles (`findEffectiveRoleIdsForMember`: direct
 *   `member_roles` UNION roles inherited through group membership / ancestry).
 * - **managed** = the Discord roles this team has a `discord_role_mappings` row for — i.e. the
 *   Discord roles Sideline actually owns.
 * - **added** = every role in `desired` → `role_assigned`.
 * - **removed** = every role in `managed` that is NOT in `desired` → `role_unassigned`.
 *   Removal is intentionally restricted to `managed`: a Discord role a captain granted by hand
 *   (no Sideline mapping for it) is never considered here, so this sync can never strip a
 *   hand-granted Discord role. Do not widen `removed` to "any Discord role the member doesn't
 *   need" — that is the anti-stripping guard CC-8 requires.
 * - A member with no `discord_id`, or that does not exist on this team, returns
 *   `{ skippedCount: 1, roleSyncState: 'never' }` and enqueues nothing.
 * - `RoleSyncEventsRepository`'s `_emitIfGuildLinked` already no-ops (writes nothing) for a team
 *   with no `guild_id`, so a team without Discord returns all-zero counts without an error.
 * - The combined fan-out is capped at `MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER`; if the diff is
 *   larger, only the first N (added, then removed) are enqueued and a warning is logged with the
 *   full vs. capped counts. `roleSyncState` still reports `'queued'` — the client can click sync
 *   again to drain the remainder.
 */
export const syncMemberDiscordRoles = (
  teamId: Team.TeamId,
  teamMemberId: TeamMember.TeamMemberId,
) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('roleSyncEvents', () => RoleSyncEventsRepository.asEffect()),
    Effect.bind('targetMember', ({ members }) =>
      members.findRosterMemberByIds(teamId, teamMemberId),
    ),
    Effect.flatMap(({ members, mappings, roles, roleSyncEvents, targetMember }) =>
      Option.match(targetMember, {
        onNone: () => Effect.succeed(neverSyncedResult),
        onSome: (member) =>
          // discord_id is a required column on `users` today, but this check stays defensive —
          // it is the documented skip path (CC-8 / PR-7 step 5) and costs nothing.
          member.discord_id
            ? syncLinkedMember({
                teamId,
                teamMemberId,
                discordId: member.discord_id,
                members,
                mappings,
                roles,
                roleSyncEvents,
              })
            : Effect.succeed(neverSyncedResult),
      }),
    ),
  );

const syncLinkedMember = (params: {
  readonly teamId: Team.TeamId;
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly discordId: Discord.Snowflake;
  readonly members: ServiceMap.Service.Shape<typeof TeamMembersRepository>;
  readonly mappings: ServiceMap.Service.Shape<typeof DiscordRoleMappingRepository>;
  readonly roles: ServiceMap.Service.Shape<typeof RolesRepository>;
  readonly roleSyncEvents: ServiceMap.Service.Shape<typeof RoleSyncEventsRepository>;
}) =>
  Effect.Do.pipe(
    Effect.bind('desired', () => params.members.findEffectiveRoleIdsForMember(params.teamMemberId)),
    Effect.bind('managed', () => params.mappings.findAllByTeam(params.teamId)),
    Effect.let('desiredIds', ({ desired }) => new Set(desired.map((r) => r.role_id))),
    Effect.let('removedCandidates', ({ managed, desiredIds }) =>
      managed.filter((mapping) => !desiredIds.has(mapping.role_id)),
    ),
    // Resolve names for the roles being removed. A mapping whose role can no longer be found
    // (e.g. archived) is skipped rather than emitted with a fabricated name.
    Effect.bind('removed', ({ removedCandidates }) =>
      Effect.forEach(removedCandidates, (mapping) =>
        params.roles
          .findRoleById(mapping.role_id)
          .pipe(
            Effect.map(Option.map((role) => ({ roleId: mapping.role_id, roleName: role.name }))),
          ),
      ).pipe(Effect.map(Array.getSomes)),
    ),
    Effect.let('cappedAdded', ({ desired }) =>
      desired.slice(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER),
    ),
    Effect.let('cappedRemoved', ({ removed, cappedAdded }) =>
      removed.slice(0, Math.max(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER - cappedAdded.length)),
    ),
    Effect.tap(({ desired, removed, cappedAdded, cappedRemoved }) => {
      const total = desired.length + removed.length;
      const capped = cappedAdded.length + cappedRemoved.length;
      return capped < total
        ? Effect.logWarning('syncMemberDiscordRoles: fan-out cap reached', {
            teamId: params.teamId,
            teamMemberId: params.teamMemberId,
            total,
            capped,
            max: MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER,
          })
        : Effect.void;
    }),
    Effect.tap(({ cappedAdded }) =>
      Effect.forEach(
        cappedAdded,
        (role) =>
          params.roleSyncEvents.emitRoleAssigned(
            params.teamId,
            role.role_id,
            role.role_name,
            params.teamMemberId,
            params.discordId,
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.tap(({ cappedRemoved }) =>
      Effect.forEach(
        cappedRemoved,
        (role) =>
          params.roleSyncEvents.emitRoleUnassigned(
            params.teamId,
            role.roleId,
            role.roleName,
            params.teamMemberId,
            params.discordId,
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.map(
      ({ cappedAdded, cappedRemoved }) =>
        new RoleApi.SyncMemberRolesResult({
          addedCount: cappedAdded.length,
          removedCount: cappedRemoved.length,
          skippedCount: 0,
          roleSyncState: 'queued',
          lastRoleSyncAt: Option.none(),
          lastRoleSyncError: Option.none(),
        }),
    ),
  );
