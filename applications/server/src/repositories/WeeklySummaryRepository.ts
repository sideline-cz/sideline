import { ActivityType, Discord, Team, TeamMember } from '@sideline/domain';
import { type DateTime, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class PlayerWeekActivityRow extends Schema.Class<PlayerWeekActivityRow>('PlayerWeekActivityRow')({
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
  activity_type_name: Schema.String,
  logged_at: Schema.DateTimeUtc,
  duration_minutes: Schema.OptionFromNullOr(Schema.Int),
}) {}

class TeamWeekActivityRow extends Schema.Class<TeamWeekActivityRow>('TeamWeekActivityRow')({
  team_member_id: TeamMember.TeamMemberId,
  activity_type_id: ActivityType.ActivityTypeId,
  activity_type_name: Schema.String,
  logged_at: Schema.DateTimeUtc,
  duration_minutes: Schema.OptionFromNullOr(Schema.Int),
}) {}

class ActivityCountRow extends Schema.Class<ActivityCountRow>('WeekActivityCountRow')({
  count: Schema.Int,
}) {}

class NewAchievementRow extends Schema.Class<NewAchievementRow>('WeekNewAchievementRow')({
  slug: Schema.String,
  earned_at: Schema.DateTimeUtc,
}) {}

class TeamAchievementCountRow extends Schema.Class<TeamAchievementCountRow>(
  'TeamWeekAchievementCountRow',
)({
  count: Schema.Int,
}) {}

class AllTimeLogRow extends Schema.Class<AllTimeLogRow>('WeekAllTimeLogRow')({
  team_member_id: TeamMember.TeamMemberId,
  logged_at: Schema.DateTimeUtc,
}) {}

class DeliveredCheckRow extends Schema.Class<DeliveredCheckRow>('WeekDeliveredCheckRow')({
  delivered: Schema.Boolean,
}) {}

// ---------------------------------------------------------------------------
// WeeklySummaryRepository
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findPlayerWeekActivityQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      member_id: TeamMember.TeamMemberId,
      week_start: Schema.DateTimeUtc,
      week_end: Schema.DateTimeUtc,
    }),
    Result: PlayerWeekActivityRow,
    execute: (input) => sql`
      SELECT
        al.team_member_id,
        al.activity_type_id,
        at.name AS activity_type_name,
        al.logged_at,
        al.duration_minutes
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      JOIN team_members tm ON tm.id = al.team_member_id
      WHERE tm.team_id = ${input.team_id}
        AND al.team_member_id = ${input.member_id}
        AND al.logged_at >= ${input.week_start}
        AND al.logged_at <= ${input.week_end}
      ORDER BY al.logged_at ASC
    `,
  });

  const findPlayerActivityCountQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      member_id: TeamMember.TeamMemberId,
      start: Schema.DateTimeUtc,
      end: Schema.DateTimeUtc,
    }),
    Result: ActivityCountRow,
    execute: (input) => sql`
      SELECT COUNT(*)::int AS count
      FROM activity_logs al
      WHERE al.team_member_id = ${input.member_id}
        AND al.logged_at >= ${input.start}
        AND al.logged_at <= ${input.end}
    `,
  });

  const findTeamWeekActivityQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      week_start: Schema.DateTimeUtc,
      week_end: Schema.DateTimeUtc,
    }),
    Result: TeamWeekActivityRow,
    execute: (input) => sql`
      SELECT
        al.team_member_id,
        al.activity_type_id,
        at.name AS activity_type_name,
        al.logged_at,
        al.duration_minutes
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      JOIN team_members tm ON tm.id = al.team_member_id
      WHERE tm.team_id = ${input.team_id}
        AND al.logged_at >= ${input.week_start}
        AND al.logged_at <= ${input.week_end}
      ORDER BY al.logged_at ASC
    `,
  });

  const findTeamActivityCountQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      start: Schema.DateTimeUtc,
      end: Schema.DateTimeUtc,
    }),
    Result: ActivityCountRow,
    execute: (input) => sql`
      SELECT COUNT(*)::int AS count
      FROM activity_logs al
      JOIN team_members tm ON tm.id = al.team_member_id
      WHERE tm.team_id = ${input.team_id}
        AND al.logged_at >= ${input.start}
        AND al.logged_at <= ${input.end}
    `,
  });

  const findNewAchievementsQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      start: Schema.DateTimeUtc,
      end: Schema.DateTimeUtc,
    }),
    Result: NewAchievementRow,
    execute: (input) => sql`
      SELECT ea.achievement_slug AS slug, ea.earned_at
      FROM earned_achievements ea
      JOIN team_members tm ON tm.id = ea.team_member_id
      WHERE tm.team_id = ${input.team_id}
        AND ea.earned_at >= ${input.start}
        AND ea.earned_at <= ${input.end}
      ORDER BY ea.earned_at ASC
    `,
  });

  const findTeamAchievementCountQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      start: Schema.DateTimeUtc,
      end: Schema.DateTimeUtc,
    }),
    Result: TeamAchievementCountRow,
    execute: (input) => sql`
      SELECT COUNT(*)::int AS count
      FROM earned_achievements ea
      JOIN team_members tm ON tm.id = ea.team_member_id
      WHERE tm.team_id = ${input.team_id}
        AND ea.earned_at >= ${input.start}
        AND ea.earned_at <= ${input.end}
    `,
  });

  const findAllTimeLogsQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: AllTimeLogRow,
    execute: (memberId) => sql`
      SELECT al.team_member_id, al.logged_at
      FROM activity_logs al
      WHERE al.team_member_id = ${memberId}
      ORDER BY al.logged_at ASC
    `,
  });

  const hasDeliveredQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      week_start: Schema.String,
    }),
    Result: DeliveredCheckRow,
    execute: (input) => sql`
      SELECT EXISTS(
        SELECT 1 FROM weekly_summary_sync_events
        WHERE team_id = ${input.team_id}
          AND week_start::text = ${input.week_start}
          AND delivered_at IS NOT NULL
      ) AS delivered
    `,
  });

  const findPlayerWeekActivity = (
    teamId: Team.TeamId,
    memberId: TeamMember.TeamMemberId,
    weekStart: DateTime.Utc,
    weekEnd: DateTime.Utc,
  ) =>
    findPlayerWeekActivityQuery({
      team_id: teamId,
      member_id: memberId,
      week_start: weekStart,
      week_end: weekEnd,
    }).pipe(catchSqlErrors);

  const findPlayerActivityCountInRange = (
    memberId: TeamMember.TeamMemberId,
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) =>
    findPlayerActivityCountQuery({ member_id: memberId, start, end }).pipe(
      catchSqlErrors,
      Effect.map((r) => r.count),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(0)),
    );

  const findTeamWeekActivity = (
    teamId: Team.TeamId,
    weekStart: DateTime.Utc,
    weekEnd: DateTime.Utc,
  ) =>
    findTeamWeekActivityQuery({ team_id: teamId, week_start: weekStart, week_end: weekEnd }).pipe(
      catchSqlErrors,
    );

  const findTeamActivityCountInRange = (
    teamId: Team.TeamId,
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) =>
    findTeamActivityCountQuery({ team_id: teamId, start, end }).pipe(
      catchSqlErrors,
      Effect.map((r) => r.count),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(0)),
    );

  const findNewAchievementsInRange = (
    teamId: Team.TeamId,
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) => findNewAchievementsQuery({ team_id: teamId, start, end }).pipe(catchSqlErrors);

  const findTeamNewAchievementCountInRange = (
    teamId: Team.TeamId,
    start: DateTime.Utc,
    end: DateTime.Utc,
  ) =>
    findTeamAchievementCountQuery({ team_id: teamId, start, end }).pipe(
      catchSqlErrors,
      Effect.map((r) => r.count),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(0)),
    );

  const findAllTimeLogsForMember = (memberId: TeamMember.TeamMemberId) =>
    findAllTimeLogsQuery(memberId).pipe(catchSqlErrors);

  const hasDeliveredSummaryForWeek = (teamId: Team.TeamId, weekStart: string) =>
    hasDeliveredQuery({ team_id: teamId, week_start: weekStart }).pipe(
      catchSqlErrors,
      Effect.map((r) => r.delivered),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(false)),
    );

  return {
    findPlayerWeekActivity,
    findPlayerActivityCountInRange,
    findTeamWeekActivity,
    findTeamActivityCountInRange,
    findNewAchievementsInRange,
    findTeamNewAchievementCountInRange,
    findAllTimeLogsForMember,
    hasDeliveredSummaryForWeek,
  };
});

export class WeeklySummaryRepository extends ServiceMap.Service<
  WeeklySummaryRepository,
  Effect.Success<typeof make>
>()('api/WeeklySummaryRepository') {
  static readonly Default = Layer.effect(WeeklySummaryRepository, make);
}

// ---------------------------------------------------------------------------
// WeeklySummarySyncEventsRepository
// ---------------------------------------------------------------------------

class SyncEventRow extends Schema.Class<SyncEventRow>('WeeklySyncEventRow')({
  id: Schema.String,
  team_id: Team.TeamId,
  channel_id: Discord.Snowflake,
  week_start: Schema.String,
  week_end: Schema.String,
  payload: Schema.Unknown,
  attempts: Schema.Int,
  last_error: Schema.OptionFromNullOr(Schema.String),
  created_at: Schema.String,
  processed_at: Schema.OptionFromNullOr(Schema.String),
  delivered_at: Schema.OptionFromNullOr(Schema.String),
}) {}

const InsertSyncEventInput = Schema.Struct({
  team_id: Team.TeamId,
  channel_id: Discord.Snowflake,
  week_start: Schema.DateTimeUtc,
  week_end: Schema.DateTimeUtc,
  payload: Schema.Unknown,
});

const makeSyncEvents = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertQuery = SqlSchema.void({
    Request: InsertSyncEventInput,
    execute: (input) => sql`
      INSERT INTO weekly_summary_sync_events (team_id, channel_id, week_start, week_end, payload)
      VALUES (
        ${input.team_id},
        ${input.channel_id},
        ${input.week_start},
        ${input.week_end},
        ${JSON.stringify(input.payload)}::jsonb
      )
      ON CONFLICT (team_id, week_start) DO NOTHING
    `,
  });

  const findUnprocessedQuery = SqlSchema.findAll({
    Request: Schema.Number,
    Result: SyncEventRow,
    execute: (limit) => sql`
      SELECT
        id::text AS id,
        team_id,
        channel_id,
        week_start::text AS week_start,
        week_end::text AS week_end,
        payload,
        attempts,
        last_error,
        created_at::text AS created_at,
        processed_at::text AS processed_at,
        delivered_at::text AS delivered_at
      FROM weekly_summary_sync_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  const markProcessedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      delivered_at: Schema.OptionFromNullOr(Schema.DateTimeUtc),
    }),
    execute: (input) => sql`
      UPDATE weekly_summary_sync_events
      SET processed_at = now(), delivered_at = ${input.delivered_at}
      WHERE id = ${input.id}::uuid
    `,
  });

  const markFailedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      error: Schema.String,
      max_attempts: Schema.Int,
    }),
    execute: (input) => sql`
      UPDATE weekly_summary_sync_events
      SET attempts = attempts + 1,
          last_error = ${input.error},
          processed_at = CASE WHEN attempts + 1 >= ${input.max_attempts} THEN now() ELSE NULL END
      WHERE id = ${input.id}::uuid
    `,
  });

  const insert = (input: {
    readonly team_id: Team.TeamId;
    readonly channel_id: Discord.Snowflake;
    readonly week_start: DateTime.Utc;
    readonly week_end: DateTime.Utc;
    readonly payload: unknown;
  }) => insertQuery(input).pipe(catchSqlErrors);

  const findUnprocessed = (limit = 50) => findUnprocessedQuery(limit).pipe(catchSqlErrors);

  const markProcessed = (id: string, deliveredAt: Option.Option<DateTime.Utc>) =>
    markProcessedQuery({ id, delivered_at: deliveredAt }).pipe(catchSqlErrors);

  const markFailed = (id: string, error: string) =>
    markFailedQuery({ id, error, max_attempts: 3 }).pipe(catchSqlErrors);

  return {
    insert,
    findUnprocessed,
    markProcessed,
    markFailed,
  };
});

export class WeeklySummarySyncEventsRepository extends ServiceMap.Service<
  WeeklySummarySyncEventsRepository,
  Effect.Success<typeof makeSyncEvents>
>()('api/WeeklySummarySyncEventsRepository') {
  static readonly Default = Layer.effect(WeeklySummarySyncEventsRepository, makeSyncEvents);
}
