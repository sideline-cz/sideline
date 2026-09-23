import type { Discord, GroupModel, Team, TeamMember } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { ChannelSyncEventsRepository } from '~/repositories/ChannelSyncEventsRepository.js';
import { DiscordChannelMappingRepository } from '~/repositories/DiscordChannelMappingRepository.js';
import { GroupsRepository } from '~/repositories/GroupsRepository.js';

/**
 * bug fix-group-channel-discord-join (PR 1) — closes the gap where a member who accepts a
 * group-scoped invite but joins Discord late (past `InviteAcceptancesRepository.ts:343`'s
 * 15-minute recency window) or manually never gets the group's own Discord channel role, because
 * `applyInviteGroup` only runs when `resolveInviteContext` resolves an invite.
 *
 * Called from `observeGuildMembership` (`rpc/guild/index.ts`) on EVERY `GUILD_MEMBER_ADD`
 * observation — `GUILD_MEMBER_ADD` IS the first-sighting signal, so no separate gate is needed
 * (see that call site's comment). It diffs the member's DESIRED groups
 * (`GroupsRepository.findActiveGroupsWithAncestorsForMember` — the member's non-archived
 * `group_members` groups plus every active ancestor, severing identically to
 * `effectiveRoles.ts`/`getActiveAncestors`) against `payload.roles` (the Discord roles the
 * member ACTUALLY holds right now, sent by the bot on this same dispatch) and enqueues
 * `member_added` only for the delta, applied to the group's OWN Discord role.
 *
 * **Only groups whose `discord_channel_mappings` row has `discord_role_id IS NOT NULL` are ever
 * considered.** A group with a channel but no role yet (or no mapping row at all) must NOT be
 * emitted for: the bot's `handleMemberAdded.ts` has no way to attach a member to a role that does
 * not exist, so it falls to `createRoleOnly(event.guild_id, event.group_name)` — the role-less-
 * mapping branch at `:38-52` (`createRoleOnly` `:40`) or the no-mapping branch at `:53-64`
 * (`createRoleOnly` `:55`) — which creates a Discord role with the RAW `group_name` and NO
 * colour, bypassing the formatted name/colour a real provisioning flow would give it. Worse,
 * once that role exists, `DiscordChannelMappingRepository.findGroupsMissingRole`'s selection
 * predicate (`m.id IS NULL OR m.discord_role_id IS NULL`, `:366`) excludes the group FOREVER —
 * `Channel/BackfillMissingGroupRoles` will never revisit it to give it a proper name/colour. This
 * is exactly the group-role backfill's job (`utils/emitGroupRoleBackfill.ts`), not this file's;
 * a role-less group is left for it.
 *
 * **`alreadyEmittedGroupIds` (the caller's `boundGroupIds`) is subtracted from the desired set**
 * because `applyInviteGroup`, bound earlier in the same `Guild/RegisterMember` call, may have
 * already emitted `member_added` for the invite's group and its active ancestors in this exact
 * call. Without the subtraction a group-scoped invite accepted and joined in the same call would
 * be double-emitted — `channel_sync_events` has no uniqueness constraint, so that would be a
 * real, avoidable duplicate row, not merely an idempotent one.
 *
 * **This only runs when `payload.source === Some('member_add')`** (gated by the caller, not this
 * function) — `Guild/ReconcileMembers` deliberately does NOT call this, to avoid the N+1 fan-out
 * §2 of the implementation plan rejects (a page of already-active members re-emitting their
 * entire group tree on every bot reconnect). The accepted consequence: a member who joins the
 * guild while the bot is disconnected past the gateway resume window is first observed by
 * reconcile, not `GUILD_MEMBER_ADD`, and gets nothing from this file — see
 * `applications/server/AGENTS.md`'s "group channel role sync" section for the trigger condition
 * and the persisted-per-guild-disconnect-signal prerequisite that would let that cohort be
 * covered automatically.
 *
 * **Add-only, deliberately.** There is no `member_removed` counterpart here — removal already has
 * owners (`api/group.ts`'s `syncRoleMembers`, `deactivateMemberAndCascade`), and this file only
 * ever fires on a join. Mirrors the add-only scope of `applyInviteGroup`.
 *
 * **The `MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER` cap is PERMANENTLY LOSSY on this path** — this
 * function only ever fires once, on the member's join, with no later re-derive to catch what the
 * cap dropped. Whatever `pending` entries fall past the cap here are never revisited. The
 * ordering `findActiveGroupsWithAncestorsForMember` returns therefore matters — see that query's
 * `ORDER BY` in `GroupsRepository.ts` for which groups are kept nearest-first.
 */
export const MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER = 25;

export type EmitMemberGroupChannelRolesResult = {
  readonly emitted: number;
};

export const emitMemberGroupChannelRoles = (
  team: { readonly id: Team.TeamId },
  teamMember: { readonly id: TeamMember.TeamMemberId },
  discordId: Discord.Snowflake,
  actualDiscordRoleIds: ReadonlyArray<string>,
  alreadyEmittedGroupIds: ReadonlyArray<GroupModel.GroupId>,
): Effect.Effect<
  EmitMemberGroupChannelRolesResult,
  never,
  GroupsRepository | DiscordChannelMappingRepository | ChannelSyncEventsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('groups', () => GroupsRepository.asEffect()),
    Effect.bind('channelMappings', () => DiscordChannelMappingRepository.asEffect()),
    Effect.bind('channelSync', () => ChannelSyncEventsRepository.asEffect()),
    Effect.bind('desired', ({ groups }) =>
      groups.findActiveGroupsWithAncestorsForMember(teamMember.id, team.id),
    ),
    Effect.bind('mappings', ({ channelMappings }) => channelMappings.findAllByTeam(team.id)),
    // Only `discord_role_id IS NOT NULL` mappings — see this file's header for why a role-less
    // mapping (or no mapping at all) must never reach the bot's `createRoleOnly` branch.
    Effect.let('roleIdByGroupId', ({ mappings }) => {
      const entries: Array<readonly [GroupModel.GroupId, Discord.Snowflake]> = [];
      for (const m of mappings) {
        if (Option.isSome(m.group_id) && Option.isSome(m.discord_role_id)) {
          entries.push([m.group_id.value, m.discord_role_id.value] as const);
        }
      }
      return new Map(entries);
    }),
    Effect.let('alreadyEmitted', () => new Set<GroupModel.GroupId>(alreadyEmittedGroupIds)),
    Effect.let('actualRoleIds', () => new Set(actualDiscordRoleIds)),
    // desired ∖ alreadyEmitted ∖ (unmapped/role-less) ∖ (role already held).
    Effect.let(
      'pending',
      ({
        desired,
        alreadyEmitted,
        roleIdByGroupId,
        actualRoleIds,
      }): ReadonlyArray<{
        readonly id: GroupModel.GroupId;
        readonly name: string;
        readonly roleId: Discord.Snowflake;
      }> => {
        const result: Array<{
          readonly id: GroupModel.GroupId;
          readonly name: string;
          readonly roleId: Discord.Snowflake;
        }> = [];
        for (const group of desired) {
          if (alreadyEmitted.has(group.id)) continue;
          const roleId = roleIdByGroupId.get(group.id);
          if (roleId === undefined) continue;
          if (actualRoleIds.has(roleId)) continue;
          result.push({ id: group.id, name: group.name, roleId });
        }
        return result;
      },
    ),
    Effect.let('capped', ({ pending }) => pending.slice(0, MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER)),
    Effect.tap(({ pending, capped }) =>
      capped.length < pending.length
        ? Effect.logWarning('emitMemberGroupChannelRoles: per-member fan-out cap reached', {
            teamId: team.id,
            teamMemberId: teamMember.id,
            total: pending.length,
            capped: capped.length,
            max: MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER,
          })
        : Effect.void,
    ),
    Effect.let('entries', ({ capped }) =>
      capped.map((group) => ({
        groupId: group.id,
        groupName: group.name,
        teamMemberId: teamMember.id,
        discordUserId: discordId,
      })),
    ),
    Effect.tap(({ channelSync, entries }) =>
      entries.length > 0
        ? channelSync.emitMembersAddedBatch({ teamId: team.id, entries })
        : Effect.void,
    ),
    // Only observability this producer has — the caller's `Effect.tap` discards the result, so
    // log the count here rather than let it disappear silently.
    Effect.tap(({ entries }) =>
      Effect.logDebug('emitMemberGroupChannelRoles: emitted group-channel roles', {
        teamId: team.id,
        teamMemberId: teamMember.id,
        emitted: entries.length,
      }),
    ),
    Effect.map(({ entries }): EmitMemberGroupChannelRolesResult => ({ emitted: entries.length })),
  );
