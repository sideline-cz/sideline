import { ActivityLog, ActivityLogApi, ActivityType, Team, TeamMember } from '@sideline/domain';
import { LogicError, Options } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { type LogScope, seasonScopeFilter } from '~/repositories/activitySeasonScope.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class StatsRow extends Schema.Class<StatsRow>('StatsRow')({
  activity_type_id: ActivityType.ActivityTypeId,
  activity_type_name: Schema.String,
  logged_at_date: Schema.String,
  duration_minutes: Schema.OptionFromNullOr(Schema.Int),
}) {}

const InsertInput = Schema.Struct({
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
  logged_at: Schema.Date,
  duration_minutes: Schema.OptionFromNullOr(
    Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
  ),
  note: Schema.OptionFromNullOr(Schema.String),
  source: ActivityLog.ActivitySource,
});

class InsertResult extends Schema.Class<InsertResult>('InsertResult')({
  id: ActivityLog.ActivityLogId,
  activity_type_id: ActivityType.ActivityTypeId,
  activity_type_name: Schema.String,
  activity_type_emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  logged_at: Schema.String,
  source: ActivityLog.ActivitySource,
}) {}

class LogRow extends Schema.Class<LogRow>('LogRow')({
  id: ActivityLog.ActivityLogId,
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
  activity_type_name: Schema.String,
  activity_type_emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  logged_at: Schema.String,
  duration_minutes: Schema.OptionFromNullOr(Schema.Int),
  note: Schema.OptionFromNullOr(Schema.String),
  source: ActivityLog.ActivitySource,
}) {}

class CurrentSeasonRow extends Schema.Class<CurrentSeasonRow>('CurrentSeasonRow')({
  id: Schema.OptionFromNullOr(ActivityLog.ActivitySeasonId),
}) {}

class SeasonRow extends Schema.Class<SeasonRow>('SeasonRow')({
  id: ActivityLog.ActivitySeasonId,
  starts_at: Schema.String,
  ends_at: Schema.OptionFromNullOr(Schema.String),
  is_current: Schema.Boolean,
}) {}

class MatrixRow extends Schema.Class<MatrixRow>('MatrixRow')({
  team_member_id: TeamMember.TeamMemberId,
  day: Schema.String,
  activity_type_name: Schema.String,
  activity_type_emoji: Schema.OptionFromNullOr(ActivityType.ActivityTypeEmoji),
  total_minutes: Schema.OptionFromNullOr(Schema.Int),
}) {}

const UpdateInput = Schema.Struct({
  id: ActivityLog.ActivityLogId,
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
  logged_at: Schema.NullOr(Schema.Date),
  duration_minutes: Schema.OptionFromNullOr(Schema.Int),
  note: Schema.OptionFromNullOr(Schema.String),
});

const FindByIdInput = Schema.Struct({
  id: ActivityLog.ActivityLogId,
  team_member_id: TeamMember.TeamMemberId,
});

const DeleteInput = Schema.Struct({
  id: ActivityLog.ActivityLogId,
  team_member_id: TeamMember.TeamMemberId,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.findOne({
    Request: InsertInput,
    Result: InsertResult,
    execute: (input) => sql`
      INSERT INTO activity_logs (team_member_id, activity_type_id, logged_at, duration_minutes, note, source)
      VALUES (
        ${input.team_member_id},
        ${input.activity_type_id},
        ${input.logged_at},
        ${input.duration_minutes},
        ${input.note},
        ${input.source}
      )
      RETURNING id, activity_type_id,
        (SELECT name FROM activity_types WHERE id = activity_type_id) AS activity_type_name,
        (SELECT emoji FROM activity_types WHERE id = activity_type_id) AS activity_type_emoji,
        logged_at::text, source
    `,
  });

  // teamMemberId is the encoded request value (SqlSchema passes the encoded side to execute)
  const memberScope = (teamMemberId: string, scope: LogScope) =>
    seasonScopeFilter(
      sql,
      'al',
      scope,
      sql`(SELECT tm.team_id FROM team_members tm WHERE tm.id = ${teamMemberId})`,
    );

  const findAllQuery = (scope: LogScope) =>
    SqlSchema.findAll({
      Request: TeamMember.TeamMemberId,
      Result: StatsRow,
      execute: (teamMemberId) => sql`
      SELECT
        al.activity_type_id,
        at.name AS activity_type_name,
        (al.logged_at AT TIME ZONE 'Europe/Prague')::date::text AS logged_at_date,
        al.duration_minutes
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.team_member_id = ${teamMemberId}
        ${memberScope(teamMemberId, scope)}
      ORDER BY al.logged_at, al.id
    `,
    });

  const findByMemberQuery = (scope: LogScope) =>
    SqlSchema.findAll({
      Request: TeamMember.TeamMemberId,
      Result: LogRow,
      execute: (teamMemberId) => sql`
      SELECT al.id, al.team_member_id, al.activity_type_id, at.name AS activity_type_name,
             at.emoji AS activity_type_emoji,
             al.logged_at::text AS logged_at, al.duration_minutes, al.note, al.source
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.team_member_id = ${teamMemberId}
        ${memberScope(teamMemberId, scope)}
      ORDER BY al.logged_at DESC, al.id DESC
      LIMIT 100
    `,
    });

  const findCurrentSeasonQuery = SqlSchema.findOne({
    Request: Team.TeamId,
    Result: CurrentSeasonRow,
    execute: (teamId) => sql`SELECT current_season_id(${teamId})::text AS id`,
  });

  // Seasons that started (same Prague-date rule as season_at, so a season that starts later
  // today is listed and current), newest first. ends_at = expires_at, else the next season's
  // start, else NULL (open).
  const findSeasonsQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: SeasonRow,
    execute: (teamId) => sql`
      SELECT id::text AS id,
             to_char(starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS starts_at,
             to_char(ends_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS ends_at,
             COALESCE(id = current_season_id(${teamId}), false) AS is_current
      FROM (
        SELECT s.id, s.starts_at,
               COALESCE(s.expires_at, LEAD(s.starts_at) OVER (ORDER BY s.starts_at)) AS ends_at
        FROM seasons s
        WHERE s.team_id = ${teamId}
      ) x
      WHERE (starts_at AT TIME ZONE 'Europe/Prague')::date <= (now() AT TIME ZONE 'Europe/Prague')::date
      ORDER BY starts_at DESC
    `,
  });

  // One row per active member x Prague day x activity type, last 30 Prague days (today
  // included). No note column: the matrix is visible to every member:view holder.
  const findTeamMatrixQuery = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: MatrixRow,
    execute: (teamId) => sql`
      SELECT al.team_member_id,
             (al.logged_at AT TIME ZONE 'Europe/Prague')::date::text AS day,
             at.name AS activity_type_name,
             at.emoji AS activity_type_emoji,
             SUM(al.duration_minutes)::int AS total_minutes
      FROM activity_logs al
      JOIN team_members tm ON tm.id = al.team_member_id AND tm.team_id = ${teamId} AND tm.active = true
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.logged_at >= (((now() AT TIME ZONE 'Europe/Prague')::date - 29)::timestamp AT TIME ZONE 'Europe/Prague')
        AND al.logged_at < (((now() AT TIME ZONE 'Europe/Prague')::date + 1)::timestamp AT TIME ZONE 'Europe/Prague')
      GROUP BY 1, 2, 3, 4
      ORDER BY 1, 2, 3
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: FindByIdInput,
    Result: LogRow,
    execute: (input) => sql`
      SELECT al.id, al.team_member_id, al.activity_type_id, at.name AS activity_type_name,
             at.emoji AS activity_type_emoji,
             al.logged_at::text AS logged_at, al.duration_minutes, al.note, al.source
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.id = ${input.id}
        AND al.team_member_id = ${input.team_member_id}
    `,
  });

  const updateQuery = SqlSchema.findOne({
    Request: UpdateInput,
    Result: LogRow,
    execute: (input) => sql`
      UPDATE activity_logs
      SET
        activity_type_id = ${input.activity_type_id},
        logged_at = COALESCE(${input.logged_at}, logged_at),
        duration_minutes = ${input.duration_minutes},
        note = ${input.note}
      WHERE id = ${input.id}
        AND team_member_id = ${input.team_member_id}
      RETURNING id, team_member_id, activity_type_id,
        (SELECT name FROM activity_types WHERE id = activity_type_id) AS activity_type_name,
        (SELECT emoji FROM activity_types WHERE id = activity_type_id) AS activity_type_emoji,
        logged_at::text AS logged_at, duration_minutes, note, source
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: DeleteInput,
    execute: (input) => sql`
      DELETE FROM activity_logs WHERE id = ${input.id} AND team_member_id = ${input.team_member_id}
    `,
  });

  const findByTeamMember = (teamMemberId: TeamMember.TeamMemberId, scope: LogScope = 'lifetime') =>
    findAllQuery(scope)(teamMemberId).pipe(catchSqlErrors);

  const findByMember = (teamMemberId: TeamMember.TeamMemberId, scope: LogScope = 'lifetime') =>
    findByMemberQuery(scope)(teamMemberId).pipe(catchSqlErrors);

  const findCurrentSeasonId = (teamId: Team.TeamId) =>
    findCurrentSeasonQuery(teamId).pipe(
      Effect.map((row) => row.id),
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'current_season_id returned no row'),
      ),
    );

  const findSeasons = (teamId: Team.TeamId) => findSeasonsQuery(teamId).pipe(catchSqlErrors);

  const findTeamMatrix = (teamId: Team.TeamId) => findTeamMatrixQuery(teamId).pipe(catchSqlErrors);

  const findById = (id: ActivityLog.ActivityLogId, memberId: TeamMember.TeamMemberId) =>
    findByIdQuery({ id, team_member_id: memberId }).pipe(catchSqlErrors);

  const insert = (input: {
    team_member_id: TeamMember.TeamMemberId;
    activity_type_id: ActivityType.ActivityTypeId;
    logged_at: Date;
    duration_minutes: Option.Option<number>;
    note: Option.Option<string>;
    source: ActivityLog.ActivitySource;
  }) =>
    insertQuery(input).pipe(
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => 'Activity log insert returned no row'),
      ),
    );

  const update = (
    id: ActivityLog.ActivityLogId,
    memberId: TeamMember.TeamMemberId,
    input: {
      activity_type_id: Option.Option<ActivityType.ActivityTypeId>;
      logged_at: Option.Option<Date>;
      duration_minutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
    },
  ): Effect.Effect<LogRow, ActivityLogApi.LogNotFound | ActivityLogApi.AutoSourceForbidden> =>
    Effect.Do.pipe(
      Effect.bind('existing', () =>
        findById(id, memberId).pipe(
          Effect.flatMap(Options.toEffect(() => new ActivityLogApi.LogNotFound())),
        ),
      ),
      Effect.tap(({ existing }) =>
        existing.source === 'auto'
          ? Effect.fail(new ActivityLogApi.AutoSourceForbidden())
          : Effect.void,
      ),
      Effect.flatMap(({ existing }) =>
        updateQuery({
          id,
          team_member_id: memberId,
          activity_type_id: Option.getOrElse(
            input.activity_type_id,
            () => existing.activity_type_id,
          ),
          logged_at: Option.getOrNull(input.logged_at),
          duration_minutes: Option.getOrElse(
            input.duration_minutes,
            () => existing.duration_minutes,
          ),
          note: Option.getOrElse(input.note, () => existing.note),
        }).pipe(
          catchSqlErrors,
          Effect.catchTag(
            'NoSuchElementError',
            LogicError.withMessage(() => 'Activity log update returned no row'),
          ),
        ),
      ),
    );

  const _delete = (
    id: ActivityLog.ActivityLogId,
    memberId: TeamMember.TeamMemberId,
  ): Effect.Effect<void, ActivityLogApi.LogNotFound | ActivityLogApi.AutoSourceForbidden> =>
    Effect.Do.pipe(
      Effect.bind('existing', () =>
        findById(id, memberId).pipe(
          Effect.flatMap(Options.toEffect(() => new ActivityLogApi.LogNotFound())),
        ),
      ),
      Effect.tap(({ existing }) =>
        existing.source === 'auto'
          ? Effect.fail(new ActivityLogApi.AutoSourceForbidden())
          : Effect.void,
      ),
      Effect.flatMap(() => deleteQuery({ id, team_member_id: memberId }).pipe(catchSqlErrors)),
      Effect.asVoid,
    );

  /**
   * Insert a training attendance auto-log, ignoring conflicts (idempotent).
   * Looks up the 'training' activity type internally; does nothing if not found.
   * Logs a warning if zero rows were inserted (likely missing 'training' activity type slug).
   */
  const insertAutoIgnoreConflict = (input: {
    team_member_id: TeamMember.TeamMemberId;
    logged_at: Date;
  }): Effect.Effect<void> =>
    sql<{ id: string }[]>`
      INSERT INTO activity_logs (team_member_id, activity_type_id, logged_at, source)
      SELECT
        ${input.team_member_id},
        at.id,
        ${input.logged_at},
        'auto'
      FROM activity_types at
      WHERE at.slug = 'training'
      ON CONFLICT (team_member_id, activity_type_id, ((logged_at AT TIME ZONE 'UTC')::date))
      WHERE source = 'auto'
      DO NOTHING
      RETURNING id
    `.pipe(
      catchSqlErrors,
      Effect.flatMap((rows) =>
        rows.length === 0
          ? Effect.logWarning(
              'insertAutoIgnoreConflict: zero rows inserted — training activity type slug may be missing',
            )
          : Effect.void,
      ),
    );

  return {
    findByTeamMember,
    findByMember,
    findCurrentSeasonId,
    findSeasons,
    findTeamMatrix,
    findById,
    insert,
    update,
    delete: _delete,
    insertAutoIgnoreConflict,
  };
});

export class ActivityLogsRepository extends ServiceMap.Service<
  ActivityLogsRepository,
  Effect.Success<typeof make>
>()('api/ActivityLogsRepository') {
  static readonly Default = Layer.effect(ActivityLogsRepository, make);
}
