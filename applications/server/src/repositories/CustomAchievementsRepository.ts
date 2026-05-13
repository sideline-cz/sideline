import { CustomAchievement, Discord, Team } from '@sideline/domain';
import { LogicError, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class CustomAchievementNameTakenError extends Schema.TaggedErrorClass<CustomAchievementNameTakenError>()(
  'CustomAchievementNameTakenError',
  {},
) {}

export class CustomAchievementRow extends Schema.Class<CustomAchievementRow>(
  'CustomAchievementRow',
)({
  id: CustomAchievement.CustomAchievementId,
  team_id: Team.TeamId,
  name: Schema.String,
  description: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  rule_kind: CustomAchievement.CustomRuleKind,
  threshold: Schema.Int,
  activity_type_slug: Schema.OptionFromNullOr(Schema.String),
  discord_role_id: Schema.OptionFromNullOr(Schema.String),
}) {}

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.String,
  description: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  rule_kind: CustomAchievement.CustomRuleKind,
  threshold: Schema.Int,
  activity_type_slug: Schema.OptionFromNullOr(Schema.String),
  discord_role_id: Schema.OptionFromNullOr(Schema.String),
});

const SetRoleMappingInput = Schema.Struct({
  id: CustomAchievement.CustomAchievementId,
  team_id: Team.TeamId,
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: CustomAchievementRow,
    execute: (teamId) => sql`
      SELECT id, team_id, name, description, emoji, rule_kind, threshold, activity_type_slug, discord_role_id
      FROM custom_achievements
      WHERE team_id = ${teamId}
      ORDER BY created_at ASC
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({ id: CustomAchievement.CustomAchievementId, team_id: Team.TeamId }),
    Result: CustomAchievementRow,
    execute: (input) => sql`
      SELECT id, team_id, name, description, emoji, rule_kind, threshold, activity_type_slug, discord_role_id
      FROM custom_achievements
      WHERE id = ${input.id} AND team_id = ${input.team_id}
    `,
  });

  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: CustomAchievementRow,
    execute: (input) => sql`
      INSERT INTO custom_achievements (team_id, name, description, emoji, rule_kind, threshold, activity_type_slug, discord_role_id)
      VALUES (${input.team_id}, ${input.name}, ${input.description}, ${input.emoji}, ${input.rule_kind}, ${input.threshold}, ${input.activity_type_slug}, ${input.discord_role_id})
      RETURNING id, team_id, name, description, emoji, rule_kind, threshold, activity_type_slug, discord_role_id
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: Schema.Struct({ id: CustomAchievement.CustomAchievementId, team_id: Team.TeamId }),
    execute: (input) => sql`
      DELETE FROM custom_achievements WHERE id = ${input.id} AND team_id = ${input.team_id}
    `,
  });

  const setRoleMappingQuery = SqlSchema.void({
    Request: SetRoleMappingInput,
    execute: (input) => sql`
      UPDATE custom_achievements SET discord_role_id = ${input.discord_role_id}, updated_at = now()
      WHERE id = ${input.id} AND team_id = ${input.team_id}
    `,
  });

  const findByTeam = (teamId: Team.TeamId): Effect.Effect<ReadonlyArray<CustomAchievementRow>> =>
    findByTeamQuery(teamId).pipe(catchSqlErrors);

  const findById = (
    teamId: Team.TeamId,
    id: CustomAchievement.CustomAchievementId,
  ): Effect.Effect<Option.Option<CustomAchievementRow>> =>
    findByIdQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const insert = (input: {
    readonly team_id: Team.TeamId;
    readonly name: string;
    readonly description: string;
    readonly emoji: Option.Option<string>;
    readonly rule_kind: CustomAchievement.CustomRuleKind;
    readonly threshold: number;
    readonly activity_type_slug: Option.Option<string>;
    readonly discord_role_id: Option.Option<string>;
  }): Effect.Effect<CustomAchievementRow, CustomAchievementNameTakenError> =>
    insertQuery(input).pipe(
      SqlErrors.catchUniqueViolation(() => new CustomAchievementNameTakenError()),
      catchSqlErrors,
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die('Custom achievement insert returned no row'),
      ),
    );

  const update = (
    teamId: Team.TeamId,
    id: CustomAchievement.CustomAchievementId,
    input: {
      readonly name: Option.Option<string>;
      readonly description: Option.Option<string>;
      readonly emoji: Option.Option<string>;
      readonly rule_kind: Option.Option<CustomAchievement.CustomRuleKind>;
      readonly threshold: Option.Option<number>;
      readonly activity_type_slug: Option.Option<string>;
      readonly discord_role_id: Option.Option<string>;
    },
  ): Effect.Effect<CustomAchievementRow, CustomAchievementNameTakenError> =>
    Effect.Do.pipe(
      Effect.bind('existing', () =>
        findById(teamId, id).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => LogicError.die(`Custom achievement ${id} not found`),
              onSome: Effect.succeed,
            }),
          ),
        ),
      ),
      Effect.flatMap(({ existing }) =>
        sql`
          UPDATE custom_achievements SET
            name = COALESCE(${Option.getOrNull(input.name)}, name),
            description = COALESCE(${Option.getOrNull(input.description)}, description),
            emoji = CASE WHEN ${Option.isSome(input.emoji)} THEN ${Option.getOrNull(input.emoji)} ELSE emoji END,
            rule_kind = COALESCE(${Option.getOrNull(input.rule_kind)}, rule_kind),
            threshold = COALESCE(${Option.getOrNull(input.threshold)}, threshold),
            activity_type_slug = CASE WHEN ${Option.isSome(input.activity_type_slug)} THEN ${Option.getOrNull(input.activity_type_slug)} ELSE activity_type_slug END,
            discord_role_id = CASE WHEN ${Option.isSome(input.discord_role_id)} THEN ${Option.getOrNull(input.discord_role_id)} ELSE discord_role_id END,
            updated_at = now()
          WHERE id = ${existing.id} AND team_id = ${teamId}
          RETURNING id, team_id, name, description, emoji, rule_kind, threshold, activity_type_slug, discord_role_id
        `.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(CustomAchievementRow))),
          Effect.flatMap((rows) =>
            rows.length > 0
              ? Effect.succeed(rows[0])
              : LogicError.die(`Custom achievement update returned no row for id=${id}`),
          ),
        ),
      ),
      SqlErrors.catchUniqueViolation(() => new CustomAchievementNameTakenError()),
      catchSqlErrors,
    );

  const _delete = (
    teamId: Team.TeamId,
    id: CustomAchievement.CustomAchievementId,
  ): Effect.Effect<void> => deleteQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const setRoleMapping = (
    teamId: Team.TeamId,
    id: CustomAchievement.CustomAchievementId,
    roleId: Option.Option<Discord.Snowflake>,
  ): Effect.Effect<void> =>
    setRoleMappingQuery({
      id,
      team_id: teamId,
      discord_role_id: roleId,
    }).pipe(catchSqlErrors);

  return {
    findByTeam,
    findById,
    insert,
    update,
    delete: _delete,
    setRoleMapping,
  };
});

export class CustomAchievementsRepository extends ServiceMap.Service<
  CustomAchievementsRepository,
  Effect.Success<typeof make>
>()('api/CustomAchievementsRepository') {
  static readonly Default = Layer.effect(CustomAchievementsRepository, make);
}
