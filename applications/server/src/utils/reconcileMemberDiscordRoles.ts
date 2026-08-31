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
 * - **granted** = `TeamMembersRepository.findGrantedRoleIds` — the role ids THIS member was
 *   actually given by Sideline (`member_role_grants`, written from the bot's own success path;
 *   see that table's migration and `unassignCandidates` below).
 * - `role_assigned` for every managed+desired role missing from `actual`.
 * - `role_unassigned` for every managed role present in `actual`, not desired, AND granted (see
 *   `unassignCandidates` below).
 * - **A Discord role with no `discord_role_mappings` row is never considered** — both candidate
 *   lists are filtered from `managed`, never from `actual` directly, so an unmapped role a captain
 *   granted by hand can never be stripped (the anti-stripping guard, CC-8).
 * - **`unassignCandidates` is restricted to roles `granted` records for THIS member (blocker,
 *   whole-series review of commit 46806427)** — not to non-`adopted` mappings. `adopted` is a
 *   MAPPING-level fact ("did Sideline create or adopt this Discord role at all") and cannot answer
 *   the MEMBER-level question this diff actually needs: did *this* member receive the role via
 *   Sideline. `46806427` excluded every `adopted` mapping from `unassignCandidates` wholesale,
 *   which also blocked stripping it from a member Sideline itself promoted into an adopted role
 *   and later demoted — nothing else in the system re-emits `role_unassigned` for a group-detach
 *   or group-removal, so that member kept Discord access forever. Keying on `granted` instead
 *   allows stripping a role this member received via Sideline (adopted mapping or not) while still
 *   never stripping a role held before/outside Sideline — a member with no grant row for a role is
 *   never in `unassignCandidates`, which is also the correct default for a member who predates
 *   `member_role_grants` and has no recorded provenance at all (no backfill exists; see the
 *   migration's doc comment).
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
    // Blocker (whole-series review of commit 46806427): per-member provenance for the removal
    // decision below — see `member_role_grants`'s migration and this file's top-of-file doc
    // comment for why `adopted` (a mapping-level fact) cannot answer this member-level question.
    Effect.bind('grantedRoleIds', ({ members }) =>
      members.findGrantedRoleIds(teamMember.id).pipe(Effect.map((ids) => new Set(ids))),
    ),
    Effect.let('desiredRoleIds', ({ desired }) => new Set(desired.map((r) => r.role_id))),
    Effect.let('actualRoleIds', () => new Set(actualDiscordRoleIds)),
    // Both candidate lists are filtered from `managed` — never from `actual` directly — so a
    // Discord role with no `discord_role_mappings` row is never considered, added, or removed
    // (the anti-stripping guard, CC-8).
    Effect.let('assignCandidates', ({ managed, desiredRoleIds, actualRoleIds }) =>
      managed.filter((m) => desiredRoleIds.has(m.role_id) && !actualRoleIds.has(m.discord_role_id)),
    ),
    // Blocker (whole-series review of commit 46806427): a mapping is only an unassign candidate
    // if `grantedRoleIds` says SIDELINE ITSELF gave *this* member the role (`member_role_grants`,
    // written from the bot's own successful `addGuildMemberRole` call — see that table's
    // migration). This replaces `46806427`'s blanket `!m.adopted` exclusion, which conflated a
    // MAPPING-level fact (did Sideline create/adopt this Discord role at all) with the
    // MEMBER-level question this diff actually needs (did *this* member get it from Sideline) —
    // see this file's top-of-file doc comment for the full rationale. A member with no grant row
    // for a role — because they hold it by hand, or because they predate `member_role_grants` and
    // have no recorded provenance — is never in `unassignCandidates`, matching the "no backfill,
    // default to not stripping" rule that table's migration documents.
    Effect.let('unassignCandidates', ({ managed, desiredRoleIds, actualRoleIds, grantedRoleIds }) =>
      managed.filter(
        (m) =>
          grantedRoleIds.has(m.role_id) &&
          actualRoleIds.has(m.discord_role_id) &&
          !desiredRoleIds.has(m.role_id),
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
