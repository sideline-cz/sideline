import { GroupModel, Role, Team } from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import { Array, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class RoleNameAlreadyTakenError extends Schema.TaggedErrorClass<RoleNameAlreadyTakenError>()(
  'RoleNameAlreadyTakenError',
  {},
) {}

class RoleWithPermissionCount extends Schema.Class<RoleWithPermissionCount>(
  'RoleWithPermissionCount',
)({
  id: Role.RoleId,
  team_id: Team.TeamId,
  name: Schema.String,
  is_built_in: Schema.Boolean,
  permission_count: Schema.Number,
}) {}

class RoleRow extends Schema.Class<RoleRow>('RoleRow')({
  id: Role.RoleId,
  team_id: Team.TeamId,
  name: Schema.String,
  is_built_in: Schema.Boolean,
}) {}

class PermissionRow extends Schema.Class<PermissionRow>('PermissionRow')({
  permission: Role.Permission,
}) {}

const RoleInsertInput = Schema.Struct({
  team_id: Schema.String,
  name: Schema.String,
  is_built_in: Schema.Boolean,
});

const RoleUpdateInput = Schema.Struct({
  id: Role.RoleId,
  name: Schema.OptionFromNullOr(Schema.String),
});

const InsertPermissionInput = Schema.Struct({
  role_id: Role.RoleId,
  permission: Role.Permission,
});

const FindByTeamAndNameInput = Schema.Struct({
  team_id: Schema.String,
  name: Schema.String,
});

const InitTeamRolesInput = Schema.Struct({
  team_id: Schema.String,
});

const RoleGroupInput = Schema.Struct({
  role_id: Role.RoleId,
  group_id: GroupModel.GroupId,
});

class RoleGroupRow extends Schema.Class<RoleGroupRow>('RoleGroupRow')({
  group_id: GroupModel.GroupId,
  group_name: Schema.String,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: RoleWithPermissionCount,
    execute: (teamId) => sql`
      SELECT r.id, r.team_id, r.name, r.is_built_in,
             (SELECT COUNT(*) FROM role_permissions rp WHERE rp.role_id = r.id)::int AS permission_count
      FROM roles r
      WHERE r.team_id = ${teamId} AND r.is_archived = false
      ORDER BY r.is_built_in DESC, r.name ASC
    `,
  });

  const findById = SqlSchema.findOneOption({
    Request: Role.RoleId,
    Result: RoleRow,
    execute: (id) =>
      sql`SELECT id, team_id, name, is_built_in FROM roles WHERE id = ${id} AND is_archived = false`,
  });

  const findPermissions = SqlSchema.findAll({
    Request: Role.RoleId,
    Result: PermissionRow,
    execute: (roleId) => sql`SELECT permission FROM role_permissions WHERE role_id = ${roleId}`,
  });

  const insertQuery = SqlSchema.findOne({
    Request: RoleInsertInput,
    Result: RoleRow,
    execute: (input) => sql`
      INSERT INTO roles (team_id, name, is_built_in)
      VALUES (${input.team_id}, ${input.name}, ${input.is_built_in})
      RETURNING id, team_id, name, is_built_in
    `,
  });

  const updateQuery = SqlSchema.findOne({
    Request: RoleUpdateInput,
    Result: RoleRow,
    execute: (input) => sql`
      UPDATE roles
      SET name = COALESCE(${input.name}, name)
      WHERE id = ${input.id}
      RETURNING id, team_id, name, is_built_in
    `,
  });

  const archiveRoleQuery = SqlSchema.void({
    Request: Role.RoleId,
    execute: (id) => sql`UPDATE roles SET is_archived = true WHERE id = ${id}`,
  });

  const deletePermissions = SqlSchema.void({
    Request: Role.RoleId,
    execute: (roleId) => sql`DELETE FROM role_permissions WHERE role_id = ${roleId}`,
  });

  const insertPermission = SqlSchema.void({
    Request: InsertPermissionInput,
    execute: (input) => sql`
      INSERT INTO role_permissions (role_id, permission)
      VALUES (${input.role_id}, ${input.permission})
      ON CONFLICT DO NOTHING
    `,
  });

  const findByTeamAndName = SqlSchema.findOneOption({
    Request: FindByTeamAndNameInput,
    Result: RoleRow,
    execute: (input) =>
      sql`SELECT id, team_id, name, is_built_in FROM roles WHERE team_id = ${input.team_id} AND name = ${input.name} AND is_archived = false`,
  });

  const countMembersForRole = SqlSchema.findOne({
    Request: Role.RoleId,
    Result: Schema.Struct({ count: Schema.Number }),
    execute: (roleId) =>
      sql`SELECT COUNT(*)::int AS count FROM member_roles WHERE role_id = ${roleId}`,
  });

  const initTeamRoles = SqlSchema.void({
    Request: InitTeamRolesInput,
    execute: (input) => sql`
      INSERT INTO roles (team_id, name, is_built_in)
      VALUES
        (${input.team_id}, 'Admin', true),
        (${input.team_id}, 'Captain', true),
        (${input.team_id}, 'Player', true),
        (${input.team_id}, 'Treasurer', true)
      ON CONFLICT (team_id, name) DO NOTHING
    `,
  });

  const findGroupsForRoleIdQuery = SqlSchema.findAll({
    Request: Role.RoleId,
    Result: RoleGroupRow,
    execute: (roleId) => sql`
      SELECT g.id AS group_id, g.name AS group_name
      FROM role_groups rg
      JOIN groups g ON g.id = rg.group_id
      WHERE rg.role_id = ${roleId}
      ORDER BY g.name ASC
    `,
  });

  const assignRoleGroupQuery = SqlSchema.void({
    Request: RoleGroupInput,
    execute: (input) => sql`
      INSERT INTO role_groups (role_id, group_id)
      VALUES (${input.role_id}, ${input.group_id})
      ON CONFLICT DO NOTHING
    `,
  });

  const unassignRoleGroupQuery = SqlSchema.void({
    Request: RoleGroupInput,
    execute: (input) => sql`
      DELETE FROM role_groups
      WHERE role_id = ${input.role_id} AND group_id = ${input.group_id}
    `,
  });

  const findRolesByTeamId = (teamId: Team.TeamId) => findByTeamId(teamId).pipe(catchSqlErrors);

  const findRoleById = (roleId: Role.RoleId) => findById(roleId).pipe(catchSqlErrors);

  const getPermissionsForRoleId = (roleId: Role.RoleId) =>
    findPermissions(roleId).pipe(Effect.map(Array.map((r) => r.permission)), catchSqlErrors);

  const insertRole = (teamId: Team.TeamId, name: string) =>
    insertQuery({ team_id: teamId, name, is_built_in: false }).pipe(
      SqlErrors.catchUniqueViolation(() => new RoleNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const updateRole = (roleId: Role.RoleId, name: Option.Option<string>) =>
    updateQuery({ id: roleId, name }).pipe(
      SqlErrors.catchUniqueViolation(() => new RoleNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const archiveRoleById = (roleId: Role.RoleId) => archiveRoleQuery(roleId).pipe(catchSqlErrors);

  const setRolePermissions = (roleId: Role.RoleId, permissions: ReadonlyArray<Role.Permission>) =>
    deletePermissions(roleId).pipe(
      Effect.flatMap(() =>
        Effect.all(
          Array.map(permissions, (p) => insertPermission({ role_id: roleId, permission: p })),
        ),
      ),
      Effect.asVoid,
      catchSqlErrors,
    );

  const initializeTeamRoles = (teamId: Team.TeamId) =>
    initTeamRoles({ team_id: teamId }).pipe(catchSqlErrors);

  const findRoleByTeamAndName = (teamId: Team.TeamId, name: string) =>
    findByTeamAndName({ team_id: teamId, name }).pipe(catchSqlErrors);

  const seedTeamRolesWithPermissions = (teamId: Team.TeamId) =>
    initializeTeamRoles(teamId).pipe(
      Effect.flatMap(() => findByTeamId(teamId)),
      Effect.tap((roles) =>
        Effect.all(
          Array.map(roles, (role) => {
            const perms = Role.defaultPermissions[role.name];
            return perms ? setRolePermissions(role.id, perms) : Effect.void;
          }),
        ),
      ),
      catchSqlErrors,
    );

  const getMemberCountForRole = (roleId: Role.RoleId) =>
    countMembersForRole(roleId).pipe(
      Effect.map((r) => r.count),
      catchSqlErrors,
    );

  const findGroupsForRole = (roleId: Role.RoleId) =>
    findGroupsForRoleIdQuery(roleId).pipe(catchSqlErrors);

  const assignRoleToGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
    assignRoleGroupQuery({ role_id: roleId, group_id: groupId }).pipe(catchSqlErrors);

  const unassignRoleFromGroup = (roleId: Role.RoleId, groupId: GroupModel.GroupId) =>
    unassignRoleGroupQuery({ role_id: roleId, group_id: groupId }).pipe(catchSqlErrors);

  return {
    findRolesByTeamId,
    findRoleById,
    getPermissionsForRoleId,
    insertRole,
    updateRole,
    archiveRoleById,
    setRolePermissions,
    initializeTeamRoles,
    findRoleByTeamAndName,
    seedTeamRolesWithPermissions,
    getMemberCountForRole,
    findGroupsForRole,
    assignRoleToGroup,
    unassignRoleFromGroup,
  };
});

export class RolesRepository extends ServiceMap.Service<
  RolesRepository,
  Effect.Success<typeof make>
>()('api/RolesRepository') {
  static readonly Default = Layer.effect(RolesRepository, make);
}
