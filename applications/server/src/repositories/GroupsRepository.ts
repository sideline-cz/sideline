import { Discord, GroupModel, Role, Team, TeamMember } from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class GroupNameAlreadyTakenError extends Schema.TaggedErrorClass<GroupNameAlreadyTakenError>()(
  'GroupNameAlreadyTakenError',
  {},
) {}

class GroupWithCount extends Schema.Class<GroupWithCount>('GroupWithCount')({
  id: GroupModel.GroupId,
  team_id: Team.TeamId,
  parent_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(Schema.String),
  created_at: Schema.Date,
  member_count: Schema.Number,
}) {}

class GroupRow extends Schema.Class<GroupRow>('GroupRow')({
  id: GroupModel.GroupId,
  team_id: Team.TeamId,
  parent_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(Schema.String),
}) {}

class GroupMemberRow extends Schema.Class<GroupMemberRow>('GroupMemberRow')({
  member_id: TeamMember.TeamMemberId,
  name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.String,
  nickname: Schema.OptionFromNullOr(Schema.String),
  display_name: Schema.OptionFromNullOr(Schema.String),
}) {}

class GroupRoleRow extends Schema.Class<GroupRoleRow>('GroupRoleRow')({
  role_id: Role.RoleId,
  role_name: Schema.String,
}) {}

const GroupInsertInput = Schema.Struct({
  team_id: Schema.String,
  parent_id: Schema.OptionFromNullOr(Schema.String),
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(Schema.String),
});

const GroupUpdateInput = Schema.Struct({
  id: GroupModel.GroupId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(Schema.String),
});

const GroupMemberInput = Schema.Struct({
  group_id: GroupModel.GroupId,
  team_member_id: TeamMember.TeamMemberId,
});

const MoveGroupInput = Schema.Struct({
  id: GroupModel.GroupId,
  parent_id: Schema.OptionFromNullOr(GroupModel.GroupId),
});

class DescendantMemberRow extends Schema.Class<DescendantMemberRow>('DescendantMemberRow')({
  team_member_id: TeamMember.TeamMemberId,
}) {}

class GroupMemberWithDiscordRow extends Schema.Class<GroupMemberWithDiscordRow>(
  'GroupMemberWithDiscordRow',
)({
  team_member_id: TeamMember.TeamMemberId,
  discord_user_id: Schema.NullOr(Discord.Snowflake),
}) {}

class GroupIdRow extends Schema.Class<GroupIdRow>('GroupIdRow')({
  group_id: GroupModel.GroupId,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: GroupWithCount,
    execute: (teamId) => sql`
            WITH RECURSIVE group_tree AS (
              SELECT g.id AS root_id, g.id AS descendant_id
              FROM groups g
              WHERE g.team_id = ${teamId} AND g.is_archived = false
              UNION ALL
              SELECT gt.root_id, child.id
              FROM group_tree gt
              JOIN groups child ON child.parent_id = gt.descendant_id AND child.is_archived = false AND child.team_id = ${teamId}
            ),
            member_counts AS (
              SELECT gt.root_id, COUNT(DISTINCT gm.team_member_id)::int AS member_count
              FROM group_tree gt
              LEFT JOIN group_members gm ON gm.group_id = gt.descendant_id
              GROUP BY gt.root_id
            )
            SELECT g.id, g.team_id, g.parent_id, g.name, g.emoji, g.color, g.created_at,
                   COALESCE(mc.member_count, 0) AS member_count
            FROM groups g
            LEFT JOIN member_counts mc ON mc.root_id = g.id
            WHERE g.team_id = ${teamId} AND g.is_archived = false
            ORDER BY g.name ASC
          `,
  });

  const findById = SqlSchema.findOneOption({
    Request: GroupModel.GroupId,
    Result: GroupRow,
    execute: (id) =>
      sql`SELECT id, team_id, parent_id, name, emoji, color FROM groups WHERE id = ${id} AND is_archived = false`,
  });

  const insert = SqlSchema.findOne({
    Request: GroupInsertInput,
    Result: GroupRow,
    execute: (input) => sql`
            INSERT INTO groups (team_id, parent_id, name, emoji, color)
            VALUES (${input.team_id}, ${input.parent_id}, ${input.name}, ${input.emoji}, ${input.color})
            RETURNING id, team_id, parent_id, name, emoji, color
          `,
  });

  const update = SqlSchema.findOne({
    Request: GroupUpdateInput,
    Result: GroupRow,
    execute: (input) => sql`
            UPDATE groups SET name = ${input.name}, emoji = ${input.emoji}, color = ${input.color}
            WHERE id = ${input.id}
            RETURNING id, team_id, parent_id, name, emoji, color
          `,
  });

  const archiveGroup = SqlSchema.void({
    Request: GroupModel.GroupId,
    execute: (id) => sql`UPDATE groups SET is_archived = true WHERE id = ${id}`,
  });

  const moveGroupParent = SqlSchema.findOne({
    Request: MoveGroupInput,
    Result: GroupRow,
    execute: (input) => sql`
            UPDATE groups SET parent_id = ${input.parent_id}
            WHERE id = ${input.id}
            RETURNING id, team_id, parent_id, name, emoji, color
          `,
  });

  const findMembers = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupMemberRow,
    execute: (groupId) => sql`
            SELECT tm.id AS member_id, u.name, u.username,
                   u.discord_nickname AS nickname, u.discord_display_name AS display_name
            FROM group_members gm
            JOIN team_members tm ON tm.id = gm.team_member_id
            JOIN users u ON u.id = tm.user_id
            WHERE gm.group_id = ${groupId}
            ORDER BY u.username ASC
          `,
  });

  const addMember = SqlSchema.void({
    Request: GroupMemberInput,
    execute: (input) => sql`
            INSERT INTO group_members (group_id, team_member_id)
            VALUES (${input.group_id}, ${input.team_member_id})
            ON CONFLICT DO NOTHING
          `,
  });

  const removeMember = SqlSchema.void({
    Request: GroupMemberInput,
    execute: (input) => sql`
            DELETE FROM group_members
            WHERE group_id = ${input.group_id} AND team_member_id = ${input.team_member_id}
          `,
  });

  const removeAllForMemberQuery = SqlSchema.void({
    Request: TeamMember.TeamMemberId,
    execute: (memberId) => sql`DELETE FROM group_members WHERE team_member_id = ${memberId}`,
  });

  const findRolesForGroup = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupRoleRow,
    execute: (groupId) => sql`
            SELECT r.id AS role_id, r.name AS role_name
            FROM role_groups rg
            JOIN roles r ON r.id = rg.role_id
            WHERE rg.group_id = ${groupId}
            ORDER BY r.name ASC
          `,
  });

  const countMembersForGroup = SqlSchema.findOne({
    Request: GroupModel.GroupId,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (groupId) => sql`
            WITH RECURSIVE descendants AS (
              SELECT g.id, g.team_id, 0 AS depth FROM groups g WHERE g.id = ${groupId} AND g.is_archived = false
              UNION ALL
              SELECT g.id, g.team_id, d.depth + 1 FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id AND d.depth < 32
            )
            SELECT COUNT(DISTINCT gm.team_member_id)::int AS count
            FROM descendants d
            LEFT JOIN group_members gm ON gm.group_id = d.id
          `,
  });

  const findChildren = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupRow,
    execute: (groupId) =>
      sql`SELECT id, team_id, parent_id, name, emoji, color FROM groups WHERE parent_id = ${groupId} AND is_archived = false`,
  });

  // Cycle guard: `groups.parent_id` has no DB-level acyclicity constraint (see
  // `effectiveRoles.ts`'s header for the same decision made there), and this walk is
  // ALSO `moveGroup`'s own cycle check (`api/group.ts`'s `getAncestorIds` call) — the one
  // thing that stops a cycle from being created in the first place. That check is now
  // atomic (transaction + per-team advisory lock, see its call site), so no API path
  // builds a cycle any more; rows predating that fix, or written by direct SQL, still can
  // be cyclic. Without the `depth < 32` guard, such a chain would hang this query forever,
  // which would also make `moveGroup` unusable to repair it.
  const findAncestors = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupRow,
    execute: (groupId) => sql`
            WITH RECURSIVE ancestors AS (
              SELECT parent_id AS id, 0 AS depth FROM groups WHERE id = ${groupId} AND parent_id IS NOT NULL
              UNION ALL
              SELECT g.parent_id, a.depth + 1
              FROM groups g
              JOIN ancestors a ON g.id = a.id
              WHERE g.parent_id IS NOT NULL AND a.depth < 32
            )
            SELECT g.id, g.team_id, g.parent_id, g.name, g.emoji, g.color FROM groups g JOIN ancestors a ON g.id = a.id
          `,
  });

  /**
   * Archived-aware sibling of `findAncestors`. The `is_archived = false` / `team_id` predicates
   * sit in the RECURSIVE TERM — so an archived ancestor SEVERS the chain and nothing above it is
   * ever reached — AND on the final join, so the archived node's own row is excluded too. The
   * SEVERING SEMANTICS here must match the ancestor walk in `repositories/effectiveRoles.ts`
   * (see its header, decision 1): the effective-roles walk and the `member_added` channel-sync
   * emit must agree about which ancestors still grant, or the two contradict each other on the
   * same tree.
   *
   * The recursive term is textually identical to that walk. Two differences are deliberate and
   * do NOT affect severing — do not "fix" them into a literal match:
   *   1. The final join spells the predicates as a trailing `WHERE` rather than inside the
   *      `JOIN … ON`. Identical for an inner join.
   *   2. The `depth < 32` guard counts from a different seed. `effectiveRolesFrom` seeds the
   *      member's OWN group at depth 0; this query seeds that group's PARENT at depth 0, so it
   *      reaches one level further up a pathological chain. The seed matches `findAncestors`
   *      above, which is the more useful consistency — both are ancestor queries over the same
   *      shape, and 32 levels of subgroup nesting is already far beyond anything real.
   *
   * `findAncestors` above deliberately does NOT filter and must stay that way. It backs
   * `getAncestorIds` (`moveGroup`'s cycle check, see that query's comment) and
   * `getAncestorsIncludingArchived` (the full-revoke path in `deactivateMemberCascade.ts`) —
   * archived-blind by design, for cycle checks and full-revoke paths only. Never use it to back
   * a channel-sync `member_added` emit — use `getActiveAncestors` for that.
   *
   * The seed does not re-check the starting group itself; every caller has already resolved it
   * through a query that filters `is_archived = false`.
   *
   * `findActiveGroupsWithAncestorsForMember` (below) walks the SAME shape from a different seed
   * (a member's own `group_members` rows instead of one already-known group), for the same
   * reason: it backs `emitMemberGroupChannelRoles`, which must agree with this query and with
   * `effectiveRoles.ts` about which ancestors still grant. It seeds the member's OWN group at
   * depth 0, one level short of this query's seed (that group's PARENT) — see its own header for
   * why that difference is deliberate.
   */
  const findActiveAncestors = SqlSchema.findAll({
    Request: Schema.Struct({ group_id: GroupModel.GroupId, team_id: Team.TeamId }),
    Result: GroupRow,
    execute: ({ group_id, team_id }) => sql`
            WITH RECURSIVE ancestors AS (
              SELECT parent_id AS id, 0 AS depth FROM groups WHERE id = ${group_id} AND parent_id IS NOT NULL
              UNION ALL
              SELECT anc_g.parent_id, a.depth + 1
              FROM groups anc_g
              JOIN ancestors a ON anc_g.id = a.id
              WHERE anc_g.parent_id IS NOT NULL
                AND anc_g.is_archived = false
                AND anc_g.team_id = ${team_id}
                AND a.depth < 32
            )
            SELECT g.id, g.team_id, g.parent_id, g.name, g.emoji, g.color
            FROM groups g
            JOIN ancestors a ON g.id = a.id
            WHERE g.is_archived = false AND g.team_id = ${team_id}
          `,
  });

  /**
   * Backs `emitMemberGroupChannelRoles` (`utils/emitMemberGroupChannelRoles.ts`): the member's
   * own non-archived `group_members` groups PLUS every active ancestor of each — the exact
   * "desired" set the group-channel-role sync diffs `discord_channel_mappings.discord_role_id`
   * against. The SEVERING SEMANTICS here MUST match `findActiveAncestors` above (see its header)
   * and the ancestor walk in `repositories/effectiveRoles.ts` (see its header, decision 1): role
   * sync and channel sync must never disagree about which ancestors still grant.
   *
   * `UNION ALL` in the recursive term plus a final `SELECT DISTINCT` — NOT `UNION` inside the
   * CTE — because two DIFFERENT seed groups (the member can belong to more than one) can share
   * an ancestor at two different depths; deduping inside the CTE would only catch an exact
   * `(id, depth)` collision, not this cross-seed one. `depth < 32` is the same cycle guard every
   * `groups.parent_id` walk in this codebase carries (`applications/server/AGENTS.md`, "Recursive
   * `groups.parent_id` Walks Must Carry a `depth < 32` Guard").
   *
   * `JOIN team_members tm ON tm.id = gm.team_member_id AND tm.active = true` on the seed is a PK
   * join (no row multiplication) that keeps this query from depending on
   * `deactivateMemberCascade.ts`'s hard delete of `group_members` rows — an invariant held in a
   * different file. A `group_members` row for a currently-inactive membership yields nothing.
   *
   * Seed depth note (mirrors `findActiveAncestors`'s header): this query seeds the member's OWN
   * group at depth 0, so on a >32-deep chain it reaches one level further than
   * `findActiveAncestors`, which seeds the PARENT at depth 0. Both are correct for what they walk
   * — the seed choice here is dictated by starting from `group_members`, not from an
   * already-resolved group id.
   *
   * `ORDER BY min(depth), name, id` — deterministic and NEAREST-FIRST. Without an `ORDER BY`,
   * Postgres returns `reachable` in arbitrary order; `emitMemberGroupChannelRoles.ts`'s
   * `MAX_GROUP_CHANNEL_EMISSIONS_PER_MEMBER` cap then truncates whatever `slice(0, …)` happens to
   * land on — and that truncation on this path is PERMANENT (this query only ever runs once, on
   * the member's join, with no later re-derive to catch it), so an arbitrary order
   * would nondeterministically and permanently lose groups for a member in >25 mapped, unheld
   * groups. Ordering nearest-first means the member's own groups (depth 0) and closest ancestors
   * are the ones kept when the cap bites, which is the more defensible loss. A group can be
   * reached at more than one depth (two different seed groups sharing an ancestor at different
   * depths — see the `UNION ALL` + outer `DISTINCT` note above), so this aggregates to that
   * group's MINIMUM depth rather than `SELECT DISTINCT`, which cannot express "which depth to keep
   * without picking a row nondeterministically" itself, and `DISTINCT ON (id)` is unusable here —
   * it requires the `ORDER BY` to start with `id`, which would defeat depth-based ordering
   * entirely.
   */
  const findActiveGroupsWithAncestorsForMemberQuery = SqlSchema.findAll({
    Request: Schema.Struct({ member_id: TeamMember.TeamMemberId, team_id: Team.TeamId }),
    Result: Schema.Struct({ id: GroupModel.GroupId, name: Schema.String }),
    execute: ({ member_id, team_id }) => sql`
            WITH RECURSIVE reachable AS (
              SELECT g.id, g.name, g.parent_id, 0 AS depth
              FROM group_members gm
              JOIN team_members tm ON tm.id = gm.team_member_id AND tm.active = true
              JOIN groups g ON g.id = gm.group_id
              WHERE gm.team_member_id = ${member_id} AND g.is_archived = false AND g.team_id = ${team_id}
              UNION ALL
              SELECT anc.id, anc.name, anc.parent_id, r.depth + 1
              FROM reachable r
              JOIN groups anc ON anc.id = r.parent_id
              WHERE r.depth < 32 AND anc.is_archived = false AND anc.team_id = ${team_id}
            )
            SELECT id, name
            FROM reachable
            GROUP BY id, name
            ORDER BY min(depth), name, id
          `,
  });

  const findDescendantMembers = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: DescendantMemberRow,
    execute: (groupId) => sql`
            WITH RECURSIVE descendants AS (
              SELECT g.id, g.team_id, 0 AS depth FROM groups g WHERE g.id = ${groupId}
              UNION ALL
              SELECT g.id, g.team_id, d.depth + 1 FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id AND d.depth < 32
            )
            SELECT DISTINCT gm.team_member_id
            FROM descendants d
            JOIN group_members gm ON gm.group_id = d.id
          `,
  });

  const findMembersWithDiscordId = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupMemberWithDiscordRow,
    execute: (groupId) => sql`
            SELECT gm.team_member_id, u.discord_id AS discord_user_id
            FROM group_members gm
            JOIN team_members tm ON tm.id = gm.team_member_id
            JOIN users u ON u.id = tm.user_id
            WHERE gm.group_id = ${groupId}
          `,
  });

  // `fix/group-role-discord-sync`: added the `depth < 32` cycle guard per
  // `applications/server/AGENTS.md` → "Recursive `groups.parent_id` Walks Must Carry a `depth < 32`
  // Guard" — this walk was on that doc's "not yet guarded" list, and this change makes it
  // load-bearing on six new group-role-sync paths (including `moveGroup`, the very operation that
  // can create a cycle).
  const findDescendantMembersWithDiscordIdQuery = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupMemberWithDiscordRow,
    execute: (groupId) => sql`
            WITH RECURSIVE descendants AS (
              SELECT g.id, g.team_id, 0 AS depth FROM groups g WHERE g.id = ${groupId} AND g.is_archived = false
              UNION ALL
              SELECT g.id, g.team_id, d.depth + 1 FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id AND d.depth < 32
            )
            SELECT DISTINCT gm.team_member_id, u.discord_id AS discord_user_id
            FROM descendants d
            JOIN group_members gm ON gm.group_id = d.id
            JOIN team_members tm ON tm.id = gm.team_member_id
            JOIN users u ON u.id = tm.user_id
          `,
  });

  const findGroupsByTeamId = (teamId: Team.TeamId) => findByTeamId(teamId).pipe(catchSqlErrors);

  const findGroupById = (groupId: GroupModel.GroupId) => findById(groupId).pipe(catchSqlErrors);

  const insertGroup = (
    teamId: Team.TeamId,
    name: string,
    parentId: Option.Option<string>,
    emoji: Option.Option<string>,
    color: Option.Option<string>,
  ) =>
    insert({ team_id: teamId, parent_id: parentId, name, emoji, color }).pipe(
      SqlErrors.catchUniqueViolation(() => new GroupNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const updateGroupById = (
    groupId: GroupModel.GroupId,
    name: string,
    emoji: Option.Option<string>,
    color: Option.Option<string>,
  ) =>
    update({ id: groupId, name, emoji, color }).pipe(
      SqlErrors.catchUniqueViolation(() => new GroupNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const archiveGroupById = (groupId: GroupModel.GroupId) =>
    archiveGroup(groupId).pipe(catchSqlErrors);

  const moveGroup = (groupId: GroupModel.GroupId, parentId: Option.Option<GroupModel.GroupId>) =>
    moveGroupParent({ id: groupId, parent_id: parentId }).pipe(catchSqlErrors);

  const findMembersByGroupId = (groupId: GroupModel.GroupId) =>
    findMembers(groupId).pipe(catchSqlErrors);

  const addMemberById = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
    addMember({ group_id: groupId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  const removeMemberById = (groupId: GroupModel.GroupId, teamMemberId: TeamMember.TeamMemberId) =>
    removeMember({ group_id: groupId, team_member_id: teamMemberId }).pipe(catchSqlErrors);

  const removeAllForMember = (memberId: TeamMember.TeamMemberId) =>
    removeAllForMemberQuery(memberId).pipe(catchSqlErrors);

  const getRolesForGroup = (groupId: GroupModel.GroupId) =>
    findRolesForGroup(groupId).pipe(catchSqlErrors);

  const getMemberCount = (groupId: GroupModel.GroupId) =>
    countMembersForGroup(groupId).pipe(
      Effect.map((r) => r.count),
      catchSqlErrors,
    );

  const getChildren = (groupId: GroupModel.GroupId) => findChildren(groupId).pipe(catchSqlErrors);

  const getAncestorIds = (groupId: GroupModel.GroupId) =>
    findAncestors(groupId).pipe(
      Effect.map((rows) => rows.map((r) => r.id)),
      catchSqlErrors,
    );

  const getAncestorsIncludingArchived = (groupId: GroupModel.GroupId) =>
    findAncestors(groupId).pipe(catchSqlErrors);

  const getActiveAncestors = (groupId: GroupModel.GroupId, teamId: Team.TeamId) =>
    findActiveAncestors({ group_id: groupId, team_id: teamId }).pipe(catchSqlErrors);

  const findActiveGroupsWithAncestorsForMember = (
    memberId: TeamMember.TeamMemberId,
    teamId: Team.TeamId,
  ) =>
    findActiveGroupsWithAncestorsForMemberQuery({ member_id: memberId, team_id: teamId }).pipe(
      catchSqlErrors,
    );

  const getDescendantMemberIds = (groupId: GroupModel.GroupId) =>
    findDescendantMembers(groupId).pipe(
      Effect.map((rows) => rows.map((r) => r.team_member_id)),
      catchSqlErrors,
    );

  const findMembersWithDiscordIdByGroupId = (groupId: GroupModel.GroupId) =>
    findMembersWithDiscordId(groupId).pipe(
      Effect.map((rows) =>
        rows.map((r) => ({
          teamMemberId: r.team_member_id,
          discordUserId: r.discord_user_id,
        })),
      ),
      catchSqlErrors,
    );

  const findDescendantMembersWithDiscordIdByGroupId = (groupId: GroupModel.GroupId) =>
    findDescendantMembersWithDiscordIdQuery(groupId).pipe(
      Effect.map((rows) =>
        rows.map((r) => ({
          teamMemberId: r.team_member_id,
          discordUserId: r.discord_user_id,
        })),
      ),
      catchSqlErrors,
    );

  const findGroupIdsByMemberQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: GroupIdRow,
    execute: (memberId) => sql`
      SELECT group_id FROM group_members WHERE team_member_id = ${memberId}
    `,
  });

  const findGroupIdsByMember = (memberId: TeamMember.TeamMemberId) =>
    findGroupIdsByMemberQuery(memberId).pipe(
      Effect.map((rows) => rows.map((r) => r.group_id)),
      catchSqlErrors,
    );

  return {
    findGroupsByTeamId,
    findGroupById,
    insertGroup,
    updateGroupById,
    archiveGroupById,
    moveGroup,
    findMembersByGroupId,
    addMemberById,
    removeMemberById,
    getRolesForGroup,
    getMemberCount,
    getChildren,
    getAncestorIds,
    getAncestorsIncludingArchived,
    getActiveAncestors,
    findActiveGroupsWithAncestorsForMember,
    getDescendantMemberIds,
    findMembersWithDiscordIdByGroupId,
    findDescendantMembersWithDiscordIdByGroupId,
    findGroupIdsByMember,
    removeAllForMember,
  };
});

export class GroupsRepository extends ServiceMap.Service<
  GroupsRepository,
  Effect.Success<typeof make>
>()('api/GroupsRepository') {
  static readonly Default = Layer.effect(GroupsRepository, make);
}
