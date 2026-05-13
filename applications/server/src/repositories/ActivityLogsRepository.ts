import { ActivityLog, ActivityLogApi, ActivityType, TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
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

const UpdateInput = Schema.Struct({
  id: ActivityLog.ActivityLogId,
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
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

  const findAllQuery = SqlSchema.findAll({
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
      ORDER BY al.logged_at
    `,
  });

  const findByMemberQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: LogRow,
    execute: (teamMemberId) => sql`
      SELECT al.id, al.team_member_id, al.activity_type_id, at.name AS activity_type_name,
             at.emoji AS activity_type_emoji,
             al.logged_at::text AS logged_at, al.duration_minutes, al.note, al.source
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.team_member_id = ${teamMemberId}
      ORDER BY al.logged_at DESC
      LIMIT 100
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

  const findByTeamMember = (teamMemberId: TeamMember.TeamMemberId) =>
    findAllQuery(teamMemberId).pipe(catchSqlErrors);

  const findByMember = (teamMemberId: TeamMember.TeamMemberId) =>
    findByMemberQuery(teamMemberId).pipe(catchSqlErrors);

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
      duration_minutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
    },
  ): Effect.Effect<LogRow, ActivityLogApi.LogNotFound | ActivityLogApi.AutoSourceForbidden> =>
    Effect.Do.pipe(
      Effect.bind('existing', () =>
        findById(id, memberId).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ActivityLogApi.LogNotFound()),
              onSome: Effect.succeed,
            }),
          ),
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
          duration_minutes: Option.match(input.duration_minutes, {
            onNone: () => existing.duration_minutes,
            onSome: (v) => v,
          }),
          note: Option.match(input.note, {
            onNone: () => existing.note,
            onSome: (v) => v,
          }),
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
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new ActivityLogApi.LogNotFound()),
              onSome: Effect.succeed,
            }),
          ),
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

  return {
    findByTeamMember,
    findByMember,
    findById,
    insert,
    update,
    delete: _delete,
  };
});

export class ActivityLogsRepository extends ServiceMap.Service<
  ActivityLogsRepository,
  Effect.Success<typeof make>
>()('api/ActivityLogsRepository') {
  static readonly Default = Layer.effect(ActivityLogsRepository, make);
}
