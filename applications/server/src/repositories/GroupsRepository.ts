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
              SELECT g.id, g.team_id FROM groups g WHERE g.id = ${groupId} AND g.is_archived = false
              UNION ALL
              SELECT g.id, g.team_id FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id
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

  const findAncestors = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupRow,
    execute: (groupId) => sql`
            WITH RECURSIVE ancestors AS (
              SELECT parent_id AS id FROM groups WHERE id = ${groupId} AND parent_id IS NOT NULL
              UNION ALL
              SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
            )
            SELECT g.id, g.team_id, g.parent_id, g.name, g.emoji, g.color FROM groups g JOIN ancestors a ON g.id = a.id
          `,
  });

  const findDescendantMembers = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: DescendantMemberRow,
    execute: (groupId) => sql`
            WITH RECURSIVE descendants AS (
              SELECT g.id, g.team_id FROM groups g WHERE g.id = ${groupId}
              UNION ALL
              SELECT g.id, g.team_id FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id
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

  const findDescendantMembersWithDiscordIdQuery = SqlSchema.findAll({
    Request: GroupModel.GroupId,
    Result: GroupMemberWithDiscordRow,
    execute: (groupId) => sql`
            WITH RECURSIVE descendants AS (
              SELECT g.id, g.team_id FROM groups g WHERE g.id = ${groupId} AND g.is_archived = false
              UNION ALL
              SELECT g.id, g.team_id FROM groups g JOIN descendants d ON g.parent_id = d.id WHERE g.is_archived = false AND g.team_id = d.team_id
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

  const getAncestors = (groupId: GroupModel.GroupId) => findAncestors(groupId).pipe(catchSqlErrors);

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
    getAncestors,
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
