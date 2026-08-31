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
 * - **removed** = every NON-ADOPTED role in `managed` that is NOT in `desired` → `role_unassigned`.
 *   Removal is intentionally restricted to `managed`: a Discord role a captain granted by hand
 *   (no Sideline mapping for it) is never considered here, so this sync can never strip a
 *   hand-granted Discord role. Do not widen `removed` to "any Discord role the member doesn't
 *   need" — that is the anti-stripping guard CC-8 requires. An `adopted: true` mapping IS in
 *   `managed`, so it needs its own guard on top of CC-8 (blocker A, whole-series review): a
 *   member holding an adopted role by hand has no `member_roles` row and so never appears in
 *   `desired` either — without excluding `adopted` mappings from `removed` explicitly, this sync
 *   would strip every adopted role on the very first click for any member who has one.
 * - A member with no `discord_id`, or that does not exist on this team, returns
 *   `{ skippedCount: 1, roleSyncState: 'never' }` and enqueues nothing.
 * - `RoleSyncEventsRepository`'s `_emitIfGuildLinked` already no-ops (writes nothing) for a team
 *   with no `guild_id`, so a team without Discord returns all-zero counts without an error.
 * - The combined fan-out is capped at `MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER`; if the diff is
 *   larger, only the first N (added, then removed) are enqueued and a warning is logged with the
 *   full vs. capped counts.
 *
 * `SyncMemberRolesResult` reports two DIFFERENT things that a later reader must not conflate:
 *
 * - `addedCount` / `removedCount` / `skippedCount` describe what THIS CLICK enqueued (the diff
 *   computed just now, against the live `member_roles` / `discord_role_mappings` state).
 * - `roleSyncState` / `lastRoleSyncAt` / `lastRoleSyncError` describe the member's PREVIOUS
 *   COMPLETED attempt, as recorded on `team_members.last_role_sync_*` by
 *   `RoleSyncEventsRepository.recordLastRoleSync` (written when the bot reports a `role_assigned`
 *   / `role_unassigned` event processed or terminally failed — see that repository's docs for why
 *   a transient failure, CC-0, writes nothing there). These two halves of the DTO are computed
 *   from different sources and are allowed to disagree (e.g. `addedCount: 2` alongside
 *   `roleSyncState: 'failed'` from an unrelated earlier attempt) — do NOT try to make one derive
 *   from the other.
 *
 * `roleSyncState` precedence when this click BOTH enqueues new work AND a prior attempt is on
 * record: `'queued'` wins. A captain who just clicked "sync" wants confirmation that the click
 * did something — reporting a stale `'failed'` (or `'ok'`) as the headline state while a fresh
 * attempt is already in flight would read as "the bot ignored my click". The prior outcome is not
 * discarded, though: `lastRoleSyncAt` / `lastRoleSyncError` are still populated from the prior
 * record even when `roleSyncState` is `'queued'`, so a captain retrying after fixing a permission
 * issue still sees "previously failed: bot missing permission" as context alongside the new
 * "queued" state.
 *
 * When nothing is enqueued this click, `roleSyncState` falls through to the prior record's own
 * `state` (`'ok'` or `'failed'`), or `'never'` when there is no prior record at all. This is what
 * keeps `'never'` ("this member has no completed sync in its history") distinguishable from a
 * prior success with nothing left to do right now (`roleSyncState: 'ok'`, `lastRoleSyncAt: Some`).
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
    // The PREVIOUS completed attempt, independent of the diff computed below — see the module
    // doc comment for why these two never derive from one another.
    Effect.bind('priorSync', () => params.members.findLastRoleSync(params.teamMemberId)),
    Effect.let('desiredIds', ({ desired }) => new Set(desired.map((r) => r.role_id))),
    // Blocker A (whole-series review): `adopted` mappings are excluded here, same rationale as
    // `reconcileMemberDiscordRoles.ts` — a member holding an adopted Discord role by hand has no
    // `member_roles` row and so never appears in `desired`. Without this exclusion, a captain
    // clicking "sync" on ANY member stripped every adopted role that member held but was never
    // assigned through Sideline. It may still be ADDED via `desired` above; only removal is
    // guarded.
    Effect.let('removedCandidates', ({ managed, desiredIds }) =>
      managed.filter((mapping) => !mapping.adopted && !desiredIds.has(mapping.role_id)),
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
    Effect.map(({ cappedAdded, cappedRemoved, priorSync }) => {
      const enqueuedThisClick = cappedAdded.length + cappedRemoved.length > 0;
      // 'queued' wins whenever this click enqueued work, even over a prior 'failed'/'ok' — see
      // the module doc comment ("`roleSyncState` precedence") for why. When nothing was enqueued,
      // fall through to the prior record's own state, or 'never' when there is none at all.
      const roleSyncState = enqueuedThisClick
        ? 'queued'
        : Option.match(priorSync, { onNone: () => 'never' as const, onSome: (p) => p.state });
      return new RoleApi.SyncMemberRolesResult({
        addedCount: cappedAdded.length,
        removedCount: cappedRemoved.length,
        skippedCount: 0,
        roleSyncState,
        lastRoleSyncAt: Option.map(priorSync, (p) => p.at),
        lastRoleSyncError: Option.flatMap(priorSync, (p) => p.errorCode),
      });
    }),
  );
