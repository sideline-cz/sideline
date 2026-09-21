import type { Discord, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { Effect } from 'effect';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER } from '~/utils/syncMemberDiscordRoles.js';

/**
 * `utils/syncGroupRoleMembers.ts` — the shared before/after effective-role diff util every
 * group-shaped write (`role_groups`, `group_members`, `groups.parent_id`, `groups.is_archived`)
 * goes through instead of emitting nothing (the reported bug) or hand-rolling a fifth ancestor
 * walk. `api/group.ts`'s six handlers (`assignGroupRole`, `unassignGroupRole`, `addGroupMember`,
 * `removeGroupMember`, `moveGroup`, `deleteGroup`) all wrap their primary write in
 * `withGroupRoleSync` — with ONE known exception: `rpc/guild/index.ts`'s invite-bound
 * `addMemberById` runs AFTER `reconcile`, so invite-bound group roles never reach Discord through
 * this path. That is a filed follow-up, not fixed here.
 *
 * `addGroupMember` / `removeGroupMember` pass `Effect.succeed([target])` as `withGroupRoleSync`'s
 * `targets` — a single already-known member, no descendant walk needed — rather than a bespoke
 * variant that reused the caller's already-loaded `RosterEntry.effective_roles` as the BEFORE
 * snapshot. Both sides now derive from the same `effectiveRolesFrom` fragment (which filters
 * archived roles as of `fix/archived-roles-grant-permissions`, so the archived-but-still-held
 * role that once made the two snapshots disagree no longer can), but the BEFORE snapshot still
 * goes through `findEffectiveRolesForMembers` rather than the roster DTO: a display DTO is not a
 * decision input (see "Authorization Decisions Must Read a Membership Query, Never a Roster DTO"
 * in `applications/server/AGENTS.md`), and one extra round trip per `addGroupMember` call is worth
 * not having two definitions of "effective roles" feeding one diff.
 *
 * The design:
 *
 * 1. **Snapshot BEFORE the write** (`captureGroupRoleSnapshot`) — the affected members' effective
 *    roles, read via the shared `effectiveRolesFrom` fragment (`TeamMembersRepository
 *    .findEffectiveRolesForMembers`), never a hand-rolled ancestor walk.
 * 2. **The write runs, uninstrumented.**
 * 3. **Snapshot AFTER the write** (inside `emitGroupRoleChanges`) — the SAME query, called again.
 *    `gained = after \ before` → `role_assigned`. `lost = before \ after`, **filtered to
 *    `member_role_grants`** (a member with no grant row for a role predates that table or holds it
 *    by hand, and must never be stripped) → `role_unassigned`.
 * 4. Steady state (`before == after`, e.g. a re-submitted `ON CONFLICT DO NOTHING` write) emits
 *    NOTHING — this is structural, not a rowcount check.
 * 5. **Assign is deliberately NOT filtered by `discord_role_mappings`.** `handleAssigned.ts` calls
 *    `ensureMapping` as its first step, so an unfiltered `role_assigned` for a brand-new role
 *    BOOTSTRAPS the mapping. Filtering would reproduce the reported bug for the single most likely
 *    captain workflow (create a role → attach it to a group). Prior art:
 *    `syncMemberDiscordRoles.ts` does exactly this (unfiltered assign, grant-gated unassign).
 *
 * Caps (both best-effort, never fail the write):
 *
 * - Per member: `MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER` (shared with `syncMemberDiscordRoles.ts` /
 *   `reconcileMemberDiscordRoles.ts`).
 * - Per operation: `MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION`. `RoleSyncEventsRepository
 *   .findUnprocessed` has NO team/guild predicate and the bot drains it at `concurrency: 1` for
 *   the whole process (`ProcessorService.ts`), so an oversized batch from one team stalls every
 *   tenant's role syncs — this is a MUCH tighter budget than a per-team fan-out concern.
 *   Removals are reserved first (a role a member should have LOST is a live permissions problem;
 *   one they have not yet gained is an inconvenience), but **at least one assign slot per distinct
 *   `roleId` always survives** — otherwise a removal-heavy operation could permanently starve a
 *   brand-new role's mapping bootstrap, and `reconcileMemberDiscordRoles`'s own `managed` filter
 *   can never recover an unmapped role, so nothing else would ever retry it.
 *
 * Both phases are best-effort end to end: the BEFORE phase (`targets` resolution +
 * `captureGroupRoleSnapshot`, wrapped together by `withGroupRoleSync`) and the AFTER phase
 * (`emitGroupRoleChanges`) each carry their own `Effect.timeout` + `Effect.catchCause` — repository
 * reads pipe `catchSqlErrors`, which turns a `SqlError` into a DEFECT, so a typed-error-only
 * handler would let a DB blip or a slow query 500 or hang a request whose primary write already
 * committed (or hasn't even run yet, for the BEFORE phase) — and degrade to a no-op (an empty
 * snapshot / an empty result) rather than propagate.
 *
 * Known, accepted gaps (not fixed here):
 * - **No transaction** spans the write and the emission — the AFTER snapshot must observe the
 *   write's committed effect, and repository emissions are best-effort by convention.
 * - **Concurrent-writer interleaving**: two overlapping group operations can each attribute the
 *   other's delta to themselves. Both directions are idempotent at Discord (`addGuildMemberRole`
 *   is a PUT, `deleteGuildMemberRole` on an absent role is a no-op), so the worst case is a
 *   duplicate event, never a lost one.
 * - **No in-app notification parity** — `api/role.ts`'s direct role changes notify the member;
 *   group operations do not (200 notifications for one captain action would be the wrong
 *   trade-off).
 * - The bootstrap-on-assign property (§5 above) is only safe because the bot's role event drain
 *   runs at `concurrency: 1` — raising that concurrency would turn a fan-out for one unmapped role
 *   into a thundering-herd Discord-role-creation hazard.
 */

/** Cap on total `role_sync_events` rows one group-shaped write may enqueue across ALL members. */
export const MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION = 200;

export type GroupRoleSyncTarget = {
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly discordUserId: Discord.Snowflake | null;
};

export type GroupRoleSnapshot = {
  readonly targets: ReadonlyArray<{
    readonly teamMemberId: TeamMember.TeamMemberId;
    readonly discordUserId: Discord.Snowflake;
  }>;
  readonly before: ReadonlyMap<TeamMember.TeamMemberId, ReadonlyMap<Role.RoleId, string>>;
  readonly skippedNoDiscordId: number;
};

export type GroupRoleSyncResult = {
  readonly assigned: number;
  readonly unassigned: number;
  readonly skippedForCap: number;
  readonly skippedNoDiscordId: number;
};

const emptyResult: GroupRoleSyncResult = {
  assigned: 0,
  unassigned: 0,
  skippedForCap: 0,
  skippedNoDiscordId: 0,
};

const emptySnapshot: GroupRoleSnapshot = {
  targets: [],
  before: new Map(),
  skippedNoDiscordId: 0,
};

type EmitEntry = {
  readonly eventType: 'role_assigned' | 'role_unassigned';
  readonly roleId: Role.RoleId;
  readonly roleName: string;
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly discordUserId: Discord.Snowflake;
};

const rolesByMember = (
  rows: ReadonlyArray<{
    readonly team_member_id: TeamMember.TeamMemberId;
    readonly role_id: Role.RoleId;
    readonly role_name: string;
  }>,
): ReadonlyMap<TeamMember.TeamMemberId, ReadonlyMap<Role.RoleId, string>> => {
  const map = new Map<TeamMember.TeamMemberId, Map<Role.RoleId, string>>();
  for (const row of rows) {
    const forMember = map.get(row.team_member_id) ?? new Map<Role.RoleId, string>();
    forMember.set(row.role_id, row.role_name);
    map.set(row.team_member_id, forMember);
  }
  return map;
};

const grantedByMember = (
  rows: ReadonlyArray<{
    readonly team_member_id: TeamMember.TeamMemberId;
    readonly role_id: Role.RoleId;
  }>,
): ReadonlyMap<TeamMember.TeamMemberId, ReadonlySet<Role.RoleId>> => {
  const map = new Map<TeamMember.TeamMemberId, Set<Role.RoleId>>();
  for (const row of rows) {
    const forMember = map.get(row.team_member_id) ?? new Set<Role.RoleId>();
    forMember.add(row.role_id);
    map.set(row.team_member_id, forMember);
  }
  return map;
};

/**
 * Phase 1 — MUST run BEFORE the write. Dedupes `targets` by `teamMemberId` (a member reachable
 * through two subgroups of the same moved/deleted group must contribute one entry, not two),
 * drops any target with no `discordUserId` (counted in `skippedNoDiscordId`), then reads their
 * CURRENT effective roles as the "before" snapshot every later diff is computed against.
 *
 * Never fails: a capture failure degrades to `{ targets: [], before: empty, skippedNoDiscordId }`,
 * which makes phase 2 (`emitGroupRoleChanges`) a no-op — the safe default when the "before" side
 * of the diff cannot be trusted. The write this precedes must never be blocked by a read failure.
 */
export const captureGroupRoleSnapshot = (
  targets: ReadonlyArray<GroupRoleSyncTarget>,
): Effect.Effect<GroupRoleSnapshot, never, TeamMembersRepository> => {
  const dedupedById = new Map<TeamMember.TeamMemberId, Discord.Snowflake | null>();
  for (const target of targets) {
    if (!dedupedById.has(target.teamMemberId)) {
      dedupedById.set(target.teamMemberId, target.discordUserId);
    }
  }

  let skippedNoDiscordId = 0;
  const withDiscordId: Array<{
    readonly teamMemberId: TeamMember.TeamMemberId;
    readonly discordUserId: Discord.Snowflake;
  }> = [];
  for (const [teamMemberId, discordUserId] of dedupedById) {
    if (discordUserId) {
      withDiscordId.push({ teamMemberId, discordUserId });
    } else {
      skippedNoDiscordId += 1;
    }
  }

  if (withDiscordId.length === 0) {
    return Effect.succeed({ targets: [], before: new Map(), skippedNoDiscordId });
  }

  return TeamMembersRepository.asEffect().pipe(
    Effect.flatMap((members) =>
      members.findEffectiveRolesForMembers(withDiscordId.map((t) => t.teamMemberId)),
    ),
    Effect.map(
      (rows): GroupRoleSnapshot => ({
        targets: withDiscordId,
        before: rolesByMember(rows),
        skippedNoDiscordId,
      }),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        'syncGroupRoleMembers: captureGroupRoleSnapshot failed — degrading to empty snapshot, no role sync will be emitted for this operation',
        cause,
      ).pipe(Effect.as({ targets: [], before: new Map(), skippedNoDiscordId })),
    ),
  );
};

const applyGlobalCap = (
  assignEntries: ReadonlyArray<EmitEntry>,
  unassignEntries: ReadonlyArray<EmitEntry>,
): {
  readonly finalAssign: ReadonlyArray<EmitEntry>;
  readonly finalUnassign: ReadonlyArray<EmitEntry>;
  readonly skippedForCap: number;
} => {
  const cap = MAX_ROLE_SYNC_EMISSIONS_PER_GROUP_OPERATION;

  // Reserve at least one assign slot per DISTINCT roleId before handing the rest of the budget to
  // removals — otherwise a removal-heavy operation could permanently starve a brand-new role's
  // `ensureMapping` bootstrap (see this file's header, point 5).
  const distinctAssignRoleIds = new Set(assignEntries.map((e) => e.roleId));
  const reservedAssignSlots = Math.min(distinctAssignRoleIds.size, cap);
  const removalsAllowed = Math.min(unassignEntries.length, Math.max(0, cap - reservedAssignSlots));
  const remainingForAssigns = cap - removalsAllowed;

  const finalUnassign = unassignEntries.slice(0, removalsAllowed);

  const sortedAssign = [...assignEntries].sort((a, b) => {
    if (a.roleId !== b.roleId) return a.roleId < b.roleId ? -1 : 1;
    return a.teamMemberId < b.teamMemberId ? -1 : a.teamMemberId > b.teamMemberId ? 1 : 0;
  });

  const seenRoleIds = new Set<Role.RoleId>();
  const representatives: Array<EmitEntry> = [];
  for (const entry of sortedAssign) {
    if (!seenRoleIds.has(entry.roleId)) {
      seenRoleIds.add(entry.roleId);
      representatives.push(entry);
    }
  }

  const finalAssign: Array<EmitEntry> = [];
  const usedKeys = new Set<string>();
  for (const entry of representatives) {
    if (finalAssign.length >= remainingForAssigns) break;
    finalAssign.push(entry);
    usedKeys.add(`${entry.teamMemberId}:${entry.roleId}`);
  }
  if (finalAssign.length < remainingForAssigns) {
    for (const entry of sortedAssign) {
      if (finalAssign.length >= remainingForAssigns) break;
      const key = `${entry.teamMemberId}:${entry.roleId}`;
      if (usedKeys.has(key)) continue;
      finalAssign.push(entry);
      usedKeys.add(key);
    }
  }

  const skippedForCap =
    assignEntries.length - finalAssign.length + (unassignEntries.length - finalUnassign.length);

  return { finalAssign, finalUnassign, skippedForCap };
};

/**
 * Phase 2 — MUST run AFTER the write. Re-reads the same members' effective roles (the "after"
 * snapshot), diffs against `snapshot.before`, gates removals on `member_role_grants`, applies the
 * per-member then per-operation caps, and enqueues the result as one
 * `RoleSyncEventsRepository.emitRoleEventsBatch` call.
 *
 * Best-effort: the entire computation (including the "after"/`member_role_grants` reads and the
 * batch insert) is wrapped in `Effect.timeout` + `Effect.catchCause`, so neither a slow query nor
 * a DB failure can hang or fail the caller — see this file's header.
 */
export const emitGroupRoleChanges = (
  teamId: Team.TeamId,
  snapshot: GroupRoleSnapshot,
  context: { readonly groupId?: GroupModel.GroupId; readonly operation: string },
): Effect.Effect<GroupRoleSyncResult, never, TeamMembersRepository | RoleSyncEventsRepository> => {
  if (snapshot.targets.length === 0) return Effect.succeed(emptyResult);

  const targetIds = snapshot.targets.map((t) => t.teamMemberId);
  const discordIdByMember = new Map(snapshot.targets.map((t) => [t.teamMemberId, t.discordUserId]));

  return Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('roleSyncEvents', () => RoleSyncEventsRepository.asEffect()),
    Effect.bind('afterRows', ({ members }) => members.findEffectiveRolesForMembers(targetIds)),
    Effect.bind('grantedRows', ({ members }) => members.findGrantedRolePairsForMembers(targetIds)),
    Effect.let('after', ({ afterRows }) => rolesByMember(afterRows)),
    Effect.let('granted', ({ grantedRows }) => grantedByMember(grantedRows)),
    Effect.let('diff', ({ after, granted }) => {
      // Sorted purely for stable logging/debugging — re-running an operation yields
      // `before == after` (zero events) regardless of iteration order, so this buys no
      // correctness property on its own.
      const sortedMemberIds = [...targetIds].sort();
      let perMemberCapSkipped = 0;
      const assignEntries: Array<EmitEntry> = [];
      const unassignEntries: Array<EmitEntry> = [];

      for (const memberId of sortedMemberIds) {
        const discordUserId = discordIdByMember.get(memberId);
        if (!discordUserId) continue;

        const beforeRoles = snapshot.before.get(memberId) ?? new Map<Role.RoleId, string>();
        const afterRoles = after.get(memberId) ?? new Map<Role.RoleId, string>();
        const grantedRoles = granted.get(memberId) ?? new Set<Role.RoleId>();

        const gained: Array<EmitEntry> = [];
        for (const [roleId, roleName] of afterRoles) {
          if (!beforeRoles.has(roleId)) {
            gained.push({
              eventType: 'role_assigned',
              roleId,
              roleName,
              teamMemberId: memberId,
              discordUserId,
            });
          }
        }

        const lost: Array<EmitEntry> = [];
        for (const [roleId, roleName] of beforeRoles) {
          if (!afterRoles.has(roleId) && grantedRoles.has(roleId)) {
            lost.push({
              eventType: 'role_unassigned',
              roleId,
              roleName,
              teamMemberId: memberId,
              discordUserId,
            });
          }
        }

        const cappedAssign = gained.slice(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER);
        const cappedUnassign = lost.slice(
          0,
          Math.max(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER - cappedAssign.length),
        );
        perMemberCapSkipped +=
          gained.length + lost.length - cappedAssign.length - cappedUnassign.length;

        assignEntries.push(...cappedAssign);
        unassignEntries.push(...cappedUnassign);
      }

      return { assignEntries, unassignEntries, perMemberCapSkipped };
    }),
    Effect.let('capped', ({ diff }) => applyGlobalCap(diff.assignEntries, diff.unassignEntries)),
    Effect.let(
      'totalSkippedForCap',
      ({ diff, capped }) => diff.perMemberCapSkipped + capped.skippedForCap,
    ),
    Effect.tap(({ totalSkippedForCap }) =>
      totalSkippedForCap > 0
        ? Effect.logWarning('syncGroupRoleMembers: fan-out cap reached for a group role sync', {
            teamId,
            groupId: context.groupId,
            operation: context.operation,
            skippedForCap: totalSkippedForCap,
            remedy:
              'the truncated tail is repaired by the next bot reconnect (Guild/ReconcileMembers) — the per-member "Sync roles" button is per-member and throttled to once per 60s, and will not catch up in bulk',
          })
        : Effect.void,
    ),
    Effect.tap(({ roleSyncEvents, capped }) =>
      roleSyncEvents.emitRoleEventsBatch({
        teamId,
        entries: [...capped.finalUnassign, ...capped.finalAssign],
      }),
    ),
    Effect.map(
      ({ capped, totalSkippedForCap }): GroupRoleSyncResult => ({
        assigned: capped.finalAssign.length,
        unassigned: capped.finalUnassign.length,
        skippedForCap: totalSkippedForCap,
        skippedNoDiscordId: snapshot.skippedNoDiscordId,
      }),
    ),
    Effect.timeout('10 seconds'),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        'syncGroupRoleMembers: emitGroupRoleChanges failed or timed out — the primary write already committed, Discord will lag until the next reconcile',
        cause,
      ).pipe(Effect.as(emptyResult)),
    ),
  );
};

/**
 * Target resolver for the four group-wide call sites (`assignGroupRole`, `unassignGroupRole`,
 * `moveGroup`, `deleteGroup`) — every member of the group and all its descendants, with their
 * `discord_id`. `addGroupMember` / `removeGroupMember` do not use this: they already have the one
 * member in hand from the handler's own `findRosterMemberByIds` lookup.
 *
 * `deleteGroup` MUST call this BEFORE `archiveGroupById` — `findDescendantMembersWithDiscordIdByGroupId`
 * filters `is_archived = false` in its base term, so it returns zero rows once the group is
 * archived. `withGroupRoleSync` enforces this ordering by construction (targets are resolved
 * before the write it wraps runs).
 */
export const descendantTargets = (
  groupId: GroupModel.GroupId,
): Effect.Effect<ReadonlyArray<GroupRoleSyncTarget>, never, GroupsRepository> =>
  GroupsRepository.asEffect().pipe(
    Effect.flatMap((groups) => groups.findDescendantMembersWithDiscordIdByGroupId(groupId)),
    Effect.map((rows) =>
      rows.map((r) => ({ teamMemberId: r.teamMemberId, discordUserId: r.discordUserId })),
    ),
  );

/**
 * Convenience wrapper used by all six `api/group.ts` call sites: resolves `targets`, captures the
 * BEFORE snapshot, runs `write`, and — only if `write` succeeds — emits the AFTER diff. Returns
 * `write`'s own success value unchanged. A `write` failure propagates as-is and short-circuits
 * before anything is emitted (the BEFORE snapshot was already taken, but nothing is enqueued).
 *
 * The ENTIRE BEFORE phase (`targets` resolution, e.g. `descendantTargets`'s recursive descendant
 * CTE, followed by `captureGroupRoleSnapshot`'s per-member effective-roles read) is wrapped in one
 * `Effect.timeout` + `Effect.catchCause`, degrading to `emptySnapshot` on either a timeout or a
 * failure — including a DEFECT (`catchSqlErrors` turns a `SqlError` into one), which a
 * typed-error-only handler would let hard-fail this call BEFORE `write` even runs. `targets` must
 * never be allowed to block or fail the write it precedes, exactly like the AFTER phase
 * (`emitGroupRoleChanges`) never blocks or fails the caller after the write already committed.
 */
export const withGroupRoleSync = <A, E, R>(
  teamId: Team.TeamId,
  targets: Effect.Effect<ReadonlyArray<GroupRoleSyncTarget>, E, R>,
  context: { readonly groupId?: GroupModel.GroupId; readonly operation: string },
  write: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R | TeamMembersRepository | RoleSyncEventsRepository> =>
  targets.pipe(
    Effect.flatMap((resolvedTargets) => captureGroupRoleSnapshot(resolvedTargets)),
    Effect.timeout('10 seconds'),
    Effect.catchCause((cause) =>
      Effect.logWarning(
        'syncGroupRoleMembers: BEFORE phase (target resolution + snapshot capture) failed or timed out — degrading to empty snapshot, no role sync will be emitted for this operation',
        cause,
      ).pipe(Effect.as(emptySnapshot)),
    ),
    Effect.flatMap((snapshot) =>
      write.pipe(Effect.tap(() => emitGroupRoleChanges(teamId, snapshot, context))),
    ),
  );
