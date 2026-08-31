import type { Discord, Team, TeamMember } from '@sideline/domain';
import { Array, Effect, Option, Ref } from 'effect';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RoleSyncEventsRepository } from '~/repositories/RoleSyncEventsRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER } from '~/utils/syncMemberDiscordRoles.js';

/**
 * Cap on the total number of role_sync_events a single `Guild/ReconcileMembers` call may enqueue
 * across ALL members. Without this, the first post-deploy `GUILD_CREATE` for a large,
 * long-unsynced guild would dump `members × missing-roles` events into a `concurrency: 1` drain
 * loop in one shot. Pass a shared `Ref` built from this budget into every member's
 * `reconcileMemberDiscordRoles` call in the same pass (see `rpc/guild/index.ts`
 * `Guild/ReconcileMembers`); members processed after the budget is exhausted are simply picked up
 * again on the next reconnect — the diff is level-based, so nothing is lost, only deferred.
 */
export const MAX_ROLE_SYNC_EMISSIONS_PER_GUILD_RECONCILE = 200;

export type ReconcileMemberRolesResult = {
  readonly added: number;
  readonly removed: number;
  readonly skippedForCap: number;
};

/**
 * Atomically reserves up to `requested` units from a shared per-`ReconcileMembers`-call budget.
 * `Option.none()` (no budget — the direct `member_add`/`interaction` path, which only ever
 * touches one member) means unbounded: every unit requested is granted. `Ref.modify` makes the
 * reservation safe under the `concurrency: 5` fan-out `Guild/ReconcileMembers` runs member
 * effects at.
 */
const reserveFromBudget = (budget: Option.Option<Ref.Ref<number>>, requested: number) =>
  Option.match(budget, {
    onNone: () => Effect.succeed(requested),
    onSome: (ref) =>
      Ref.modify(ref, (remaining) => {
        const granted = Math.max(0, Math.min(remaining, requested));
        return [granted, remaining - granted] as const;
      }),
  });

/**
 * Diffs one member's effective Sideline roles against their ACTUAL Discord roles (from the
 * `Guild/RegisterMember` / `Guild/ReconcileMembers` payload) and enqueues only the delta onto
 * `role_sync_events` — the level-based replacement for rev 2's one-shot transition gate (CC-10).
 *
 * - **desired** = `findEffectiveRoleIdsForMember` (`member_roles` ∪ group-derived roles),
 *   intersected with `managed`'s keys.
 * - **managed** = `discord_role_mappings` for the team — the Discord roles Sideline owns.
 * - **actual** = the payload's `roles`, implicitly restricted to `managed`'s values below.
 * - `role_assigned` for every managed+desired role missing from `actual`.
 * - `role_unassigned` for every NON-ADOPTED managed role present in `actual` but not desired.
 * - **A Discord role with no `discord_role_mappings` row is never considered** — both candidate
 *   lists are filtered from `managed`, never from `actual` directly, so an unmapped role a captain
 *   granted by hand can never be stripped (the anti-stripping guard, CC-8).
 * - **An `adopted: true` mapping is excluded from `unassignCandidates` (blocker A, whole-series
 *   review)** — a member holding an adopted Discord role by hand, with no `member_roles` row,
 *   never appears in `desired`, so unlike CC-8's "no mapping at all" case, adoption alone does
 *   NOT keep the role out of `managed`/`actual` the way an unmapped role does. Without this
 *   explicit exclusion every such member gets `role_unassigned` on the very next reconcile. It
 *   may still be ADDED via `assignCandidates` — only stripping is forbidden.
 * - **In steady state (actual already matches desired) both candidate lists are empty and nothing
 *   is emitted.** This is the flood protection that replaces the transition gate, and it holds on
 *   every call, not just the first one after a migration.
 * - Capped per member at `MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER` (shared with the manual-sync
 *   button), then further capped against `guildBudget` when the caller passes one (the
 *   `Guild/ReconcileMembers` per-guild-per-pass cap). Events cut by either cap are reported via
 *   `skippedForCap` — the caller logs how many were skipped; nothing is lost, only re-derived on
 *   the next pass because the diff is computed from ground truth, not from queue state.
 */
// Split into two chained `.pipe()` calls purely to stay under `pipe`'s ~20-argument overload
// limit — beyond it TypeScript silently falls back to an untyped rest-args overload and every
// downstream `Effect.bind`/`Effect.let` callback parameter degrades to `unknown`. No behavioural
// difference from one long chain; keep this split if adding more steps below.
const computeRoleDiff = (
  team: { readonly id: Team.TeamId },
  teamMember: { readonly id: TeamMember.TeamMemberId },
  actualDiscordRoleIds: ReadonlyArray<string>,
) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
    Effect.bind('roles', () => RolesRepository.asEffect()),
    Effect.bind('roleSyncEvents', () => RoleSyncEventsRepository.asEffect()),
    Effect.bind('desired', ({ members }) => members.findEffectiveRoleIdsForMember(teamMember.id)),
    Effect.bind('managed', ({ mappings }) => mappings.findAllByTeam(team.id)),
    Effect.let('desiredRoleIds', ({ desired }) => new Set(desired.map((r) => r.role_id))),
    Effect.let('actualRoleIds', () => new Set(actualDiscordRoleIds)),
    // Both candidate lists are filtered from `managed` — never from `actual` directly — so a
    // Discord role with no `discord_role_mappings` row is never considered, added, or removed
    // (the anti-stripping guard, CC-8).
    Effect.let('assignCandidates', ({ managed, desiredRoleIds, actualRoleIds }) =>
      managed.filter((m) => desiredRoleIds.has(m.role_id) && !actualRoleIds.has(m.discord_role_id)),
    ),
    // Blocker A (whole-series review): `adopted` mappings are excluded here — never from
    // `assignCandidates` above. An adopted mapping points at a Discord role Sideline did not
    // create (`ensureMapping.ts`); members holding it because a captain granted it by hand,
    // before or outside Sideline, have no `member_roles` row and so never appear in `desired`.
    // Stripping it on that basis would destroy human-managed Discord state — exactly what
    // `handleDeleted.ts` and the `adopted` column exist to prevent, just reached through this
    // diff instead of a role deletion. Adopted roles may still be ADDED (Sideline is free to
    // bring its own members into sync with a role it now manages); they must never be REMOVED
    // by a diff Sideline did not author.
    Effect.let('unassignCandidates', ({ managed, desiredRoleIds, actualRoleIds }) =>
      managed.filter(
        (m) => !m.adopted && actualRoleIds.has(m.discord_role_id) && !desiredRoleIds.has(m.role_id),
      ),
    ),
    // Resolve role names; a mapping whose role can no longer be found (e.g. archived) is skipped
    // rather than emitted with a fabricated name — mirrors syncMemberDiscordRoles.ts.
    Effect.bind('toAssign', ({ roles, assignCandidates }) =>
      Effect.forEach(assignCandidates, (m) =>
        roles
          .findRoleById(m.role_id)
          .pipe(Effect.map(Option.map((role) => ({ roleId: m.role_id, roleName: role.name })))),
      ).pipe(Effect.map(Array.getSomes)),
    ),
    Effect.bind('toUnassign', ({ roles, unassignCandidates }) =>
      Effect.forEach(unassignCandidates, (m) =>
        roles
          .findRoleById(m.role_id)
          .pipe(Effect.map(Option.map((role) => ({ roleId: m.role_id, roleName: role.name })))),
      ).pipe(Effect.map(Array.getSomes)),
    ),
  );

export const reconcileMemberDiscordRoles = (
  team: { readonly id: Team.TeamId },
  teamMember: { readonly id: TeamMember.TeamMemberId },
  discordId: Discord.Snowflake,
  actualDiscordRoleIds: ReadonlyArray<string>,
  guildBudget: Option.Option<Ref.Ref<number>> = Option.none(),
) =>
  computeRoleDiff(team, teamMember, actualDiscordRoleIds).pipe(
    Effect.let('cappedAssign', ({ toAssign }) =>
      toAssign.slice(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER),
    ),
    Effect.let('cappedUnassign', ({ toUnassign, cappedAssign }) =>
      toUnassign.slice(0, Math.max(0, MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER - cappedAssign.length)),
    ),
    Effect.tap(({ toAssign, toUnassign, cappedAssign, cappedUnassign }) => {
      const total = toAssign.length + toUnassign.length;
      const capped = cappedAssign.length + cappedUnassign.length;
      return capped < total
        ? Effect.logWarning('reconcileMemberDiscordRoles: per-member fan-out cap reached', {
            teamId: team.id,
            teamMemberId: teamMember.id,
            total,
            capped,
            max: MAX_ROLE_SYNC_EMISSIONS_PER_MEMBER,
          })
        : Effect.void;
    }),
    Effect.bind('granted', ({ cappedAssign, cappedUnassign }) =>
      reserveFromBudget(guildBudget, cappedAssign.length + cappedUnassign.length),
    ),
    Effect.let('finalAssign', ({ cappedAssign, granted }) => cappedAssign.slice(0, granted)),
    Effect.let('finalUnassign', ({ cappedUnassign, finalAssign, granted }) =>
      cappedUnassign.slice(0, Math.max(0, granted - finalAssign.length)),
    ),
    Effect.let(
      'skippedForCap',
      ({ cappedAssign, cappedUnassign, finalAssign, finalUnassign }) =>
        cappedAssign.length + cappedUnassign.length - finalAssign.length - finalUnassign.length,
    ),
    Effect.tap(({ roleSyncEvents, finalAssign }) =>
      Effect.forEach(
        finalAssign,
        (role) =>
          roleSyncEvents.emitRoleAssigned(
            team.id,
            role.roleId,
            role.roleName,
            teamMember.id,
            discordId,
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.tap(({ roleSyncEvents, finalUnassign }) =>
      Effect.forEach(
        finalUnassign,
        (role) =>
          roleSyncEvents.emitRoleUnassigned(
            team.id,
            role.roleId,
            role.roleName,
            teamMember.id,
            discordId,
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.map(
      ({ finalAssign, finalUnassign, skippedForCap }): ReconcileMemberRolesResult => ({
        added: finalAssign.length,
        removed: finalUnassign.length,
        skippedForCap,
      }),
    ),
  );
