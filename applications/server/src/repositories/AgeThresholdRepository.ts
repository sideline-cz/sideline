import {
  AgeThresholdRule as AgeThreshold,
  Discord,
  GroupModel,
  Team,
  TeamMember,
  User,
} from '@sideline/domain';
import { Schemas, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class AgeThresholdAlreadyExistsError extends Schema.TaggedErrorClass<AgeThresholdAlreadyExistsError>()(
  'AgeThresholdAlreadyExistsError',
  {},
) {}

export class AgeThresholdWithGroupName extends Schema.Class<AgeThresholdWithGroupName>(
  'AgeThresholdWithGroupName',
)({
  id: AgeThreshold.AgeThresholdRuleId,
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  group_name: Schema.String,
  min_age: Schema.OptionFromNullOr(Schema.Number),
  max_age: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(User.Gender),
  required_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
}) {}

export class AgeThresholdRow extends Schema.Class<AgeThresholdRow>('AgeThresholdRow')({
  id: AgeThreshold.AgeThresholdRuleId,
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  min_age: Schema.OptionFromNullOr(Schema.Number),
  max_age: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(User.Gender),
  required_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
}) {}

const InsertInput = Schema.Struct({
  team_id: Schema.String,
  group_id: Schema.String,
  min_age: Schema.OptionFromNullOr(Schema.Number),
  max_age: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(User.Gender),
  required_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
});

const UpdateInput = Schema.Struct({
  id: AgeThreshold.AgeThresholdRuleId,
  min_age: Schema.OptionFromNullOr(Schema.Number),
  max_age: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(User.Gender),
  required_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
});

class TeamIdResult extends Schema.Class<TeamIdResult>('TeamIdResult')({
  team_id: Team.TeamId,
}) {}

export class MemberForAutoAssignment extends Schema.Class<MemberForAutoAssignment>(
  'MemberForAutoAssignment',
)({
  member_id: TeamMember.TeamMemberId,
  user_id: User.UserId,
  member_name: Schema.OptionFromNullOr(Schema.String),
  username: Schema.String,
  discord_id: Discord.Snowflake,
  birth_date: Schema.OptionFromNullOr(Schema.String),
  gender: Schema.OptionFromNullOr(User.Gender),
  is_admin: Schema.Boolean,
  group_ids: Schemas.ArrayFromSplitString(),
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamIdQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: AgeThresholdWithGroupName,
    execute: (teamId) => sql`
      SELECT atr.id, atr.team_id, atr.group_id, g.name AS group_name,
             atr.min_age, atr.max_age, atr.gender, atr.required_group_id
      FROM age_threshold_rules atr
      JOIN groups g ON g.id = atr.group_id
      WHERE atr.team_id = ${teamId}
      ORDER BY g.name ASC
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: AgeThreshold.AgeThresholdRuleId,
    Result: AgeThresholdRow,
    execute: (id) => sql`
      SELECT id, team_id, group_id, min_age, max_age, gender, required_group_id
      FROM age_threshold_rules WHERE id = ${id}
    `,
  });

  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: AgeThresholdWithGroupName,
    execute: (input) => sql`
      WITH inserted AS (
        INSERT INTO age_threshold_rules (team_id, group_id, min_age, max_age, gender, required_group_id)
        VALUES (${input.team_id}, ${input.group_id}, ${input.min_age}, ${input.max_age}, ${input.gender}, ${input.required_group_id})
        RETURNING *
      )
      SELECT i.id, i.team_id, i.group_id, g.name AS group_name, i.min_age, i.max_age, i.gender, i.required_group_id
      FROM inserted i
      JOIN groups g ON g.id = i.group_id
    `,
  });

  const updateQuery = SqlSchema.findOne({
    Request: UpdateInput,
    Result: AgeThresholdWithGroupName,
    execute: (input) => sql`
      WITH updated AS (
        UPDATE age_threshold_rules
        SET min_age = ${input.min_age}, max_age = ${input.max_age}, gender = ${input.gender}, required_group_id = ${input.required_group_id}
        WHERE id = ${input.id}
        RETURNING *
      )
      SELECT u.id, u.team_id, u.group_id, g.name AS group_name, u.min_age, u.max_age, u.gender, u.required_group_id
      FROM updated u
      JOIN groups g ON g.id = u.group_id
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: AgeThreshold.AgeThresholdRuleId,
    execute: (id) => sql`DELETE FROM age_threshold_rules WHERE id = ${id}`,
  });

  const findAllTeamsWithRulesQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: TeamIdResult,
    execute: () => sql`SELECT DISTINCT team_id FROM age_threshold_rules`,
  });

  const findMembersForAutoAssignmentQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: MemberForAutoAssignment,
    execute: (teamId) => sql`
      SELECT tm.id AS member_id, tm.user_id,
             u.name AS member_name, u.username, u.discord_id,
             u.birth_date::text AS birth_date,
             u.gender,
             COALESCE(
               (SELECT string_agg(gm.group_id::text, ',')
                FROM group_members gm WHERE gm.team_member_id = tm.id), ''
             ) AS group_ids,
              (SELECT count(*)
                FROM member_roles mr
                JOIN roles r ON r.id = mr.role_id
                WHERE mr.team_member_id = tm.id
                AND r.name = 'Admin') > 0 AS is_admin
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ${teamId} AND tm.active = true
    `,
  });

  const findRulesByTeamId = (teamId: Team.TeamId) => findByTeamIdQuery(teamId).pipe(catchSqlErrors);

  const findRuleById = (ruleId: AgeThreshold.AgeThresholdRuleId) =>
    findByIdQuery(ruleId).pipe(catchSqlErrors);

  const insertRule = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    minAge: Option.Option<number>,
    maxAge: Option.Option<number>,
    gender: Option.Option<User.Gender>,
    requiredGroupId: Option.Option<GroupModel.GroupId>,
  ) =>
    insertQuery({
      team_id: teamId,
      group_id: groupId,
      min_age: minAge,
      max_age: maxAge,
      gender,
      required_group_id: requiredGroupId,
    }).pipe(
      SqlErrors.catchUniqueViolation(() => new AgeThresholdAlreadyExistsError()),
      catchSqlErrors,
    );

  const updateRuleById = (
    ruleId: AgeThreshold.AgeThresholdRuleId,
    minAge: Option.Option<number>,
    maxAge: Option.Option<number>,
    gender: Option.Option<User.Gender>,
    requiredGroupId: Option.Option<GroupModel.GroupId>,
  ) =>
    updateQuery({
      id: ruleId,
      min_age: minAge,
      max_age: maxAge,
      gender,
      required_group_id: requiredGroupId,
    }).pipe(
      SqlErrors.catchUniqueViolation(() => new AgeThresholdAlreadyExistsError()),
      catchSqlErrors,
    );

  const deleteRuleById = (ruleId: AgeThreshold.AgeThresholdRuleId) =>
    deleteQuery(ruleId).pipe(catchSqlErrors);

  const getAllTeamsWithRules = () =>
    findAllTeamsWithRulesQuery(void 0).pipe(
      Effect.map((rows) => rows.map((r) => r.team_id)),
      catchSqlErrors,
    );

  const getMembersForAutoAssignment = (teamId: Team.TeamId) =>
    findMembersForAutoAssignmentQuery(teamId).pipe(catchSqlErrors);

  return {
    findRulesByTeamId,
    findRuleById,
    insertRule,
    updateRuleById,
    deleteRuleById,
    getAllTeamsWithRules,
    getMembersForAutoAssignment,
  };
});

export class AgeThresholdRepository extends ServiceMap.Service<
  AgeThresholdRepository,
  Effect.Success<typeof make>
>()('api/AgeThresholdRepository') {
  static readonly Default = Layer.effect(AgeThresholdRepository, make);
}
