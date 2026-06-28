import { Discord, Role, Team, TeamMember, User } from '@sideline/domain';
import { Schemas, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, type Option, pipe, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class MemberAlreadyExistsError extends Schema.TaggedErrorClass<MemberAlreadyExistsError>()(
  'MemberAlreadyExistsError',
  {},
) {}

const MembershipQuery = Schema.Struct({
  team_id: Schema.String,
  user_id: Schema.String,
  include_inactive: Schema.Boolean,
});

const MembershipByDiscordQuery = Schema.Struct({
  team_id: Team.TeamId,
  discord_id: Discord.Snowflake,
});

const RosterMemberQuery = Schema.Struct({
  team_id: Schema.String,
  member_id: Schema.String,
});

const MemberRoleInput = Schema.Struct({
  team_member_id: Schema.String,
  role_id: Schema.String,
});

export class MembershipWithRole extends Schema.Class<MembershipWithRole>('MembershipWithRole')({
  id: TeamMember.TeamMemberId,
  team_id: Team.TeamId,
  user_id: User.UserId,
  active: Schema.Boolean,
  role_names: Schemas.ArrayFromSplitString(),
  permissions: pipe(Schemas.ArrayFromSplitString(), Schema.decodeTo(Schema.Array(Role.Permission))),
}) {}

export class RosterEntry extends Schema.Class<RosterEntry>('RosterEntry')({
  member_id: TeamMember.TeamMemberId,
  user_id: User.UserId,
  discord_id: Discord.Snowflake,
  role_names: Schemas.ArrayFromSplitString(),
  permissions: pipe(Schemas.ArrayFromSplitString(), Schema.decodeTo(Schema.Array(Role.Permission))),
  name: Schema.OptionFromNullOr(Schema.String),
  birth_date: Schema.OptionFromNullOr(Schema.String),
  gender: Schema.OptionFromNullOr(User.Gender),
  jersey_number: Schema.OptionFromNullOr(Schema.Number),
  username: Schema.String,
  avatar: Schema.OptionFromNullOr(Schema.String),
  discord_nickname: Schema.OptionFromNullOr(Schema.String),
  discord_display_name: Schema.OptionFromNullOr(Schema.String),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const addMemberQuery = SqlSchema.findOne({
    Request: TeamMember.TeamMember.insert,
    Result: TeamMember.TeamMember,
    execute: (input) => sql`
      INSERT INTO team_members (team_id, user_id, active)
      VALUES (${input.team_id}, ${input.user_id}, ${input.active})
      RETURNING *
    `,
  });

  const addMember = (input: typeof TeamMember.TeamMember.insert.Type) =>
    addMemberQuery(input).pipe(
      SqlErrors.catchUniqueViolation(() => new MemberAlreadyExistsError()),
      catchSqlErrors,
    );

  const assignRoleToMemberQuery = SqlSchema.void({
    Request: MemberRoleInput,
    execute: (input) => sql`
      INSERT INTO member_roles (team_member_id, role_id)
      VALUES (${input.team_member_id}, ${input.role_id})
      ON CONFLICT DO NOTHING
    `,
  });

  const unassignRoleFromMemberQuery = SqlSchema.void({
    Request: MemberRoleInput,
    execute: (input) => sql`
      DELETE FROM member_roles
      WHERE team_member_id = ${input.team_member_id} AND role_id = ${input.role_id}
    `,
  });

  const findMembershipQuery = SqlSchema.findOneOption({
    Request: MembershipQuery,
    Result: MembershipWithRole,
    execute: (input) =>
      sql`SELECT tm.id, tm.team_id, tm.user_id, tm.active,
                   COALESCE(
                     (SELECT string_agg(DISTINCT name, ',' ORDER BY name) FROM (
                       SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT r.name FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN roles r ON r.id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_roles), ''
                   ) AS role_names,
                   COALESCE(
                     (SELECT string_agg(DISTINCT perm, ',') FROM (
                       SELECT rp.permission AS perm
                       FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                       WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT rp.permission AS perm
                       FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN role_permissions rp ON rp.role_id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_perms), ''
                   ) AS permissions
            FROM team_members tm
            WHERE tm.team_id = ${input.team_id}
              AND tm.user_id = ${input.user_id}
              AND (${input.include_inactive} OR tm.active = true)`,
  });

  const findMembershipByDiscordQuery = SqlSchema.findOneOption({
    Request: MembershipByDiscordQuery,
    Result: MembershipWithRole,
    execute: (input) =>
      sql`SELECT tm.id, tm.team_id, tm.user_id, tm.active,
                   COALESCE(
                     (SELECT string_agg(DISTINCT name, ',' ORDER BY name) FROM (
                       SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT r.name FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN roles r ON r.id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_roles), ''
                   ) AS role_names,
                   COALESCE(
                     (SELECT string_agg(DISTINCT perm, ',') FROM (
                       SELECT rp.permission AS perm
                       FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                       WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT rp.permission AS perm
                       FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN role_permissions rp ON rp.role_id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_perms), ''
                   ) AS permissions
            FROM team_members tm
            JOIN users u ON u.id = tm.user_id
            WHERE tm.team_id = ${input.team_id}
              AND u.discord_id = ${input.discord_id}
              AND tm.active = true`,
  });

  const findByTeamQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: TeamMember.TeamMember,
    execute: (teamId) =>
      sql`SELECT * FROM team_members WHERE team_id = ${teamId} AND active = true`,
  });

  const findByTeam = (teamId: string) => findByTeamQuery(teamId).pipe(catchSqlErrors);

  const TeamMemberWithNameRow = Schema.Struct({
    member_id: TeamMember.TeamMemberId,
    name: Schema.OptionFromNullOr(Schema.String),
    discord_nickname: Schema.OptionFromNullOr(Schema.String),
    discord_display_name: Schema.OptionFromNullOr(Schema.String),
    username: Schema.String,
  });

  const findTeamMembersWithNamesQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: TeamMemberWithNameRow,
    execute: (teamId) => sql`
      SELECT tm.id AS member_id, u.name, u.discord_nickname, u.discord_display_name, u.username
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${teamId} AND tm.active = true
    `,
  });

  const findTeamMembersWithNames = (teamId: string) =>
    findTeamMembersWithNamesQuery(teamId).pipe(catchSqlErrors);

  const findByUserQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: MembershipWithRole,
    execute: (userId) =>
      sql`SELECT tm.id, tm.team_id, tm.user_id, tm.active,
                   COALESCE(
                     (SELECT string_agg(DISTINCT name, ',' ORDER BY name) FROM (
                       SELECT r.name FROM member_roles mr JOIN roles r ON r.id = mr.role_id WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT r.name FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN roles r ON r.id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_roles), ''
                   ) AS role_names,
                   COALESCE(
                     (SELECT string_agg(DISTINCT perm, ',') FROM (
                       SELECT rp.permission AS perm
                       FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                       WHERE mr.team_member_id = tm.id
                       UNION
                       SELECT rp.permission AS perm
                       FROM group_members gm
                       JOIN LATERAL (
                         WITH RECURSIVE ancestors AS (
                           SELECT gm.group_id AS id
                           UNION ALL
                           SELECT g.parent_id FROM groups g JOIN ancestors a ON g.id = a.id WHERE g.parent_id IS NOT NULL
                         )
                         SELECT id FROM ancestors
                       ) anc ON true
                       JOIN role_groups rg ON rg.group_id = anc.id
                       JOIN role_permissions rp ON rp.role_id = rg.role_id
                       WHERE gm.team_member_id = tm.id
                     ) all_perms), ''
                   ) AS permissions
            FROM team_members tm
            WHERE tm.user_id = ${userId} AND tm.active = true`,
  });

  const findByUser = (userId: string) => findByUserQuery(userId).pipe(catchSqlErrors);

  const findRosterByTeamQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: RosterEntry,
    execute: (teamId) => sql`
      SELECT tm.id as member_id, tm.user_id, u.discord_id,
             COALESCE(
               (SELECT string_agg(DISTINCT r.name, ',' ORDER BY r.name)
                FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                WHERE mr.team_member_id = tm.id), ''
             ) AS role_names,
             COALESCE(
               (SELECT string_agg(DISTINCT rp.permission, ',')
                FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                WHERE mr.team_member_id = tm.id), ''
             ) AS permissions,
             u.name, u.birth_date::text AS birth_date, u.gender, tm.jersey_number,
             u.username, u.avatar, u.discord_nickname, u.discord_display_name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${teamId} AND tm.active = true
    `,
  });

  const findRosterByTeam = (teamId: string) => findRosterByTeamQuery(teamId).pipe(catchSqlErrors);

  const findRosterMemberQuery = SqlSchema.findOneOption({
    Request: RosterMemberQuery,
    Result: RosterEntry,
    execute: (input) => sql`
      SELECT tm.id as member_id, tm.user_id, u.discord_id,
             COALESCE(
               (SELECT string_agg(DISTINCT r.name, ',' ORDER BY r.name)
                FROM member_roles mr JOIN roles r ON r.id = mr.role_id
                WHERE mr.team_member_id = tm.id), ''
             ) AS role_names,
             COALESCE(
               (SELECT string_agg(DISTINCT rp.permission, ',')
                FROM member_roles mr JOIN role_permissions rp ON rp.role_id = mr.role_id
                WHERE mr.team_member_id = tm.id), ''
             ) AS permissions,
             u.name, u.birth_date::text AS birth_date, u.gender, tm.jersey_number,
             u.username, u.avatar, u.discord_nickname, u.discord_display_name
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${input.team_id} AND tm.id = ${input.member_id} AND tm.active = true
    `,
  });

  const deactivateMemberQuery = SqlSchema.findOne({
    Request: RosterMemberQuery,
    Result: TeamMember.TeamMember,
    execute: (input) => sql`
      UPDATE team_members SET active = false
      WHERE id = ${input.member_id} AND team_id = ${input.team_id}
      RETURNING *
    `,
  });

  const reactivateMemberQuery = SqlSchema.findOne({
    Request: Schema.Struct({ member_id: TeamMember.TeamMemberId }),
    Result: TeamMember.TeamMember,
    execute: (input) => sql`
      UPDATE team_members SET active = true
      WHERE id = ${input.member_id}
      RETURNING *
    `,
  });

  const updateJerseyNumberQuery = SqlSchema.void({
    Request: Schema.Struct({
      member_id: TeamMember.TeamMemberId,
      jersey_number: Schema.OptionFromNullOr(Schema.Number),
    }),
    execute: (input) => sql`
      UPDATE team_members SET jersey_number = ${input.jersey_number}
      WHERE id = ${input.member_id}
    `,
  });

  const findPlayerRoleIdQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: Schema.Struct({ id: Role.RoleId }),
    execute: (teamId) =>
      sql`SELECT id FROM roles WHERE team_id = ${teamId} AND name = 'Player' AND is_built_in = true`,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: TeamMember.TeamMemberId,
    Result: TeamMember.TeamMember,
    execute: (id) => sql`SELECT * FROM team_members WHERE id = ${id}`,
  });

  const findById = (id: TeamMember.TeamMemberId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findMembershipByIds = (
    teamId: Team.TeamId,
    userId: User.UserId,
    options?: { includeInactive?: boolean },
  ) =>
    findMembershipQuery({
      team_id: teamId,
      user_id: userId,
      include_inactive: options?.includeInactive === true,
    }).pipe(catchSqlErrors);

  const findMembershipByDiscordAndTeam = (discordId: Discord.Snowflake, teamId: Team.TeamId) =>
    findMembershipByDiscordQuery({
      team_id: teamId,
      discord_id: discordId,
    }).pipe(catchSqlErrors);

  const findRosterMemberByIds = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
    findRosterMemberQuery({ team_id: teamId, member_id: memberId }).pipe(catchSqlErrors);

  const deactivateMemberByIds = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
    deactivateMemberQuery({ team_id: teamId, member_id: memberId }).pipe(catchSqlErrors);

  const reactivateMember = (memberId: TeamMember.TeamMemberId) =>
    reactivateMemberQuery({ member_id: memberId }).pipe(catchSqlErrors);

  const getPlayerRoleId = (teamId: Team.TeamId) =>
    findPlayerRoleIdQuery(teamId).pipe(catchSqlErrors);

  const assignRole = (teamMemberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
    assignRoleToMemberQuery({ team_member_id: teamMemberId, role_id: roleId }).pipe(catchSqlErrors);

  const unassignRole = (teamMemberId: TeamMember.TeamMemberId, roleId: Role.RoleId) =>
    unassignRoleFromMemberQuery({ team_member_id: teamMemberId, role_id: roleId }).pipe(
      catchSqlErrors,
    );

  const setJerseyNumber = (
    memberId: TeamMember.TeamMemberId,
    jerseyNumber: Option.Option<number>,
  ) =>
    updateJerseyNumberQuery({ member_id: memberId, jersey_number: jerseyNumber }).pipe(
      catchSqlErrors,
    );

  const resetMissedRsvpsQuery = SqlSchema.void({
    Request: TeamMember.TeamMemberId,
    execute: (id) => sql`UPDATE team_members SET missed_rsvps = 0 WHERE id = ${id}`,
  });

  const resetMissedRsvps = (teamMemberId: TeamMember.TeamMemberId) =>
    resetMissedRsvpsQuery(teamMemberId).pipe(catchSqlErrors);

  // Test helper — bypasses soft-delete to exercise FK constraints.
  // Intentionally does NOT use catchSqlErrors so FK violations propagate as Effect failures.
  const hardDelete = (id: TeamMember.TeamMemberId) =>
    SqlSchema.void({
      Request: TeamMember.TeamMemberId,
      execute: (memberId) => sql`DELETE FROM team_members WHERE id = ${memberId}`,
    })(id);

  return {
    addMember,
    findById,
    findByTeam,
    findByUser,
    findRosterByTeam,
    findTeamMembersWithNames,
    findMembershipByIds,
    findMembershipByDiscordAndTeam,
    findRosterMemberByIds,
    deactivateMemberByIds,
    reactivateMember,
    getPlayerRoleId,
    assignRole,
    unassignRole,
    setJerseyNumber,
    resetMissedRsvps,
    // test helper
    hardDelete,
  };
});

export class TeamMembersRepository extends ServiceMap.Service<
  TeamMembersRepository,
  Effect.Success<typeof make>
>()('api/TeamMembersRepository') {
  static readonly Default = Layer.effect(TeamMembersRepository, make);
}
