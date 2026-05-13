import { ActivityType, Team } from '@sideline/domain';
import { LogicError, SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

export class ActivityTypeNameAlreadyTakenError extends Schema.TaggedErrorClass<ActivityTypeNameAlreadyTakenError>()(
  'ActivityTypeNameAlreadyTakenError',
  {},
) {}

export class ActivityTypeRow extends Schema.Class<ActivityTypeRow>('ActivityTypeRow')({
  id: ActivityType.ActivityTypeId,
  team_id: Schema.OptionFromNullOr(Team.TeamId),
  name: Schema.String,
  slug: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityType.ActivityTypeDescription),
}) {}

export class ActivityTypeWithUsageRow extends Schema.Class<ActivityTypeWithUsageRow>(
  'ActivityTypeWithUsageRow',
)({
  id: ActivityType.ActivityTypeId,
  team_id: Schema.OptionFromNullOr(Team.TeamId),
  name: Schema.String,
  slug: Schema.OptionFromNullOr(Schema.String),
  emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityType.ActivityTypeDescription),
  usageCount: Schema.Int,
}) {}

const ScopedRequest = Schema.Struct({
  id: ActivityType.ActivityTypeId,
  team_id: Team.TeamId,
});

const NameScopedRequest = Schema.Struct({
  name: Schema.String,
  team_id: Team.TeamId,
});

const InsertCustomInput = Schema.Struct({
  team_id: Team.TeamId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityType.ActivityTypeDescription),
});

const UpdateCustomInput = Schema.Struct({
  id: ActivityType.ActivityTypeId,
  team_id: Team.TeamId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  description: Schema.OptionFromNullOr(ActivityType.ActivityTypeDescription),
});

const DeleteCustomInput = Schema.Struct({
  id: ActivityType.ActivityTypeId,
  team_id: Team.TeamId,
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findBySlugQuery = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: ActivityTypeRow,
    execute: (slug) =>
      sql`SELECT id, team_id, name, slug, emoji, description FROM activity_types WHERE slug = ${slug} AND team_id IS NULL`,
  });

  const findByTeamIdQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: ActivityTypeWithUsageRow,
    execute: (teamId) => sql`
      SELECT t.id, t.team_id, t.name, t.slug, t.emoji, t.description,
             COALESCE(c.cnt, 0)::int AS "usageCount"
      FROM activity_types t
      LEFT JOIN (
        SELECT al.activity_type_id, COUNT(*)::int AS cnt
        FROM activity_logs al
        JOIN team_members tm ON tm.id = al.team_member_id
        WHERE tm.team_id = ${teamId}
        GROUP BY al.activity_type_id
      ) c ON c.activity_type_id = t.id
      WHERE t.team_id IS NULL OR t.team_id = ${teamId}
      ORDER BY (t.team_id IS NULL) DESC, LOWER(t.name) ASC
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: ActivityType.ActivityTypeId,
    Result: ActivityTypeRow,
    execute: (id) =>
      sql`SELECT id, team_id, name, slug, emoji, description FROM activity_types WHERE id = ${id}`,
  });

  const findByIdScopedQuery = SqlSchema.findOneOption({
    Request: ScopedRequest,
    Result: ActivityTypeRow,
    execute: (input) =>
      sql`SELECT id, team_id, name, slug, emoji, description FROM activity_types WHERE id = ${input.id} AND (team_id IS NULL OR team_id = ${input.team_id}) LIMIT 1`,
  });

  const findByNameInScopeQuery = SqlSchema.findOneOption({
    Request: NameScopedRequest,
    Result: ActivityTypeRow,
    execute: (input) =>
      sql`SELECT id, team_id, name, slug, emoji, description FROM activity_types WHERE LOWER(name) = LOWER(${input.name}) AND (team_id IS NULL OR team_id = ${input.team_id}) LIMIT 1`,
  });

  const insertCustomQuery = SqlSchema.findOneOption({
    Request: InsertCustomInput,
    Result: ActivityTypeRow,
    execute: (input) => sql`
      INSERT INTO activity_types (team_id, name, emoji, description)
      VALUES (${input.team_id}, ${input.name}, ${input.emoji}, ${input.description})
      RETURNING id, team_id, name, slug, emoji, description
    `,
  });

  const updateCustomQuery = SqlSchema.findOneOption({
    Request: UpdateCustomInput,
    Result: ActivityTypeRow,
    execute: (input) => sql`
      UPDATE activity_types
      SET name = ${input.name}, emoji = ${input.emoji}, description = ${input.description}
      WHERE id = ${input.id} AND team_id = ${input.team_id} AND team_id IS NOT NULL
      RETURNING id, team_id, name, slug, emoji, description
    `,
  });

  const deleteCustomQuery = SqlSchema.void({
    Request: DeleteCustomInput,
    execute: (input) =>
      sql`DELETE FROM activity_types WHERE id = ${input.id} AND team_id = ${input.team_id} AND team_id IS NOT NULL`,
  });

  const countLogsQuery = SqlSchema.findOneOption({
    Request: ScopedRequest,
    Result: Schema.Struct({ count: Schema.Int }),
    execute: (input) =>
      sql`SELECT COUNT(*)::int AS count
          FROM activity_logs al
          JOIN team_members tm ON tm.id = al.team_member_id
          WHERE al.activity_type_id = ${input.id} AND tm.team_id = ${input.team_id}`,
  });

  const findBySlug = (slug: string) => findBySlugQuery(slug).pipe(catchSqlErrors);

  const findByTeamId = (teamId: Team.TeamId) => findByTeamIdQuery(teamId).pipe(catchSqlErrors);

  const findById = (id: ActivityType.ActivityTypeId) => findByIdQuery(id).pipe(catchSqlErrors);

  const findByIdScoped = (id: ActivityType.ActivityTypeId, teamId: Team.TeamId) =>
    findByIdScopedQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const findByNameInScope = (name: string, teamId: Team.TeamId) =>
    findByNameInScopeQuery({ name, team_id: teamId }).pipe(catchSqlErrors);

  const insertCustom = (input: {
    team_id: Team.TeamId;
    name: string;
    emoji: Option.Option<ActivityType.ActivityTypeEmoji>;
    description: Option.Option<ActivityType.ActivityTypeDescription>;
  }) =>
    insertCustomQuery(input).pipe(
      SqlErrors.catchUniqueViolation(() => new ActivityTypeNameAlreadyTakenError()),
      catchSqlErrors,
      Effect.flatMap(
        Option.match({
          onNone: () => LogicError.die('insertCustom returned no row'),
          onSome: Effect.succeed,
        }),
      ),
    );

  const updateCustom = (input: {
    id: ActivityType.ActivityTypeId;
    team_id: Team.TeamId;
    name: string;
    emoji: Option.Option<ActivityType.ActivityTypeEmoji>;
    description: Option.Option<ActivityType.ActivityTypeDescription>;
  }) =>
    updateCustomQuery(input).pipe(
      SqlErrors.catchUniqueViolation(() => new ActivityTypeNameAlreadyTakenError()),
      catchSqlErrors,
    );

  const deleteCustom = (id: ActivityType.ActivityTypeId, teamId: Team.TeamId) =>
    deleteCustomQuery({ id, team_id: teamId }).pipe(catchSqlErrors);

  const countLogsForType = (activityTypeId: ActivityType.ActivityTypeId, teamId: Team.TeamId) =>
    countLogsQuery({ id: activityTypeId, team_id: teamId }).pipe(
      catchSqlErrors,
      Effect.flatMap((result) =>
        Option.match(result, {
          onNone: () => LogicError.die('countLogsForType returned no row'),
          onSome: (row) => Effect.succeed(row.count),
        }),
      ),
    );

  return {
    findBySlug,
    findByTeamId,
    findById,
    findByIdScoped,
    findByNameInScope,
    insertCustom,
    updateCustom,
    deleteCustom,
    countLogsForType,
  };
});

export class ActivityTypesRepository extends ServiceMap.Service<
  ActivityTypesRepository,
  Effect.Success<typeof make>
>()('api/ActivityTypesRepository') {
  static readonly Default = Layer.effect(ActivityTypesRepository, make);
}
