import {
  Discord,
  Team,
  TeamMember,
  WeeklyChallenge,
  WeeklyChallengeRpcGroup,
} from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import {
  currentTeamMondayDateString,
  formatDateUtc,
  weekStartDateString,
} from '~/helpers/weeklyChallenge.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const { WeeklyChallengeNotFound, WeeklyChallengeNotActive, WeeklyChallengeAlreadyExistsForWeek } =
  WeeklyChallengeRpcGroup;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;

class ChallengeRow extends Schema.Class<ChallengeRow>('WcChallengeRow')({
  id: WeeklyChallenge.WeeklyChallengeId,
  team_id: Team.TeamId,
  week_start_date: Schema.Date,
  kind: WeeklyChallenge.WeeklyChallengeKind,
  title: WeeklyChallenge.WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallenge.WeeklyChallengeDescription),
  created_by: TeamMember.TeamMemberId,
  created_at: Schema.Date,
  updated_at: Schema.Date,
}) {}

class CompletionRow extends Schema.Class<CompletionRow>('WcCompletionRow')({
  challenge_id: WeeklyChallenge.WeeklyChallengeId,
  member_id: TeamMember.TeamMemberId,
}) {}

class WeekStartRow extends Schema.Class<WeekStartRow>('WcWeekStartRow')({
  week_start_date: Schema.Date,
}) {}

export class SyncEventRow extends Schema.Class<SyncEventRow>('WcSyncEventRow')({
  id: Schema.String,
  team_id: Team.TeamId,
  challenge_id: WeeklyChallenge.WeeklyChallengeId,
  channel_id: Discord.Snowflake,
  scheduled_for: Schema.Date,
  attempts: Schema.Int,
  last_error: Schema.OptionFromNullOr(Schema.String),
  created_at: Schema.Date,
  processed_at: Schema.OptionFromNullOr(Schema.Date),
  delivered_at: Schema.OptionFromNullOr(Schema.Date),
  // joined from weekly_challenges
  title: WeeklyChallenge.WeeklyChallengeTitle,
  kind: WeeklyChallenge.WeeklyChallengeKind,
  description: Schema.OptionFromNullOr(WeeklyChallenge.WeeklyChallengeDescription),
  week_start_date: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// Helper: build WeeklyChallenge domain model from ChallengeRow
// ---------------------------------------------------------------------------

const toWeeklyChallenge = (row: ChallengeRow): WeeklyChallenge.WeeklyChallenge =>
  new WeeklyChallenge.WeeklyChallenge({
    id: row.id,
    team_id: row.team_id,
    week_start_date: row.week_start_date,
    kind: row.kind,
    title: row.title,
    description: row.description,
    created_by: row.created_by,
    created_at: DateTime.makeUnsafe(row.created_at.getTime()),
    updated_at: DateTime.makeUnsafe(row.updated_at.getTime()),
  });

// ---------------------------------------------------------------------------
// WeeklyChallengeRepository
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---- Queries ----

  const listForTeamQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      limit: Schema.Int,
    }),
    Result: ChallengeRow,
    execute: (input) => sql`
      SELECT id, team_id, week_start_date, kind, title, description, created_by, created_at, updated_at
      FROM weekly_challenges
      WHERE team_id = ${input.team_id}
      ORDER BY week_start_date DESC, id DESC
      LIMIT ${input.limit}
    `,
  });

  const listCompletionsForChallengesQuery = SqlSchema.findAll({
    Request: Schema.Array(WeeklyChallenge.WeeklyChallengeId),
    Result: CompletionRow,
    execute: (ids) =>
      ids.length === 0
        ? sql`SELECT challenge_id, member_id FROM weekly_challenge_completions WHERE false`
        : sql`
      SELECT challenge_id, member_id
      FROM weekly_challenge_completions
      WHERE challenge_id IN ${sql.in([...ids])}
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: WeeklyChallenge.WeeklyChallengeId,
    Result: ChallengeRow,
    execute: (id) => sql`
      SELECT id, team_id, week_start_date, kind, title, description, created_by, created_at, updated_at
      FROM weekly_challenges
      WHERE id = ${id}
    `,
  });

  const insertChallengeQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      week_start_date: Schema.Date,
      kind: WeeklyChallenge.WeeklyChallengeKind,
      title: WeeklyChallenge.WeeklyChallengeTitle,
      description: Schema.OptionFromNullOr(WeeklyChallenge.WeeklyChallengeDescription),
      created_by: TeamMember.TeamMemberId,
    }),
    Result: ChallengeRow,
    execute: (input) => sql`
      INSERT INTO weekly_challenges (team_id, week_start_date, kind, title, description, created_by)
      VALUES (
        ${input.team_id},
        ${input.week_start_date},
        ${input.kind},
        ${input.title},
        ${input.description},
        ${input.created_by}
      )
      RETURNING id, team_id, week_start_date, kind, title, description, created_by, created_at, updated_at
    `,
  });

  const updateTitleDescriptionQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: WeeklyChallenge.WeeklyChallengeId,
      title: WeeklyChallenge.WeeklyChallengeTitle,
      description: Schema.OptionFromNullOr(WeeklyChallenge.WeeklyChallengeDescription),
    }),
    Result: ChallengeRow,
    execute: (input) => sql`
      UPDATE weekly_challenges
      SET title = ${input.title},
          description = ${input.description},
          updated_at = now()
      WHERE id = ${input.id}
      RETURNING id, team_id, week_start_date, kind, title, description, created_by, created_at, updated_at
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: WeeklyChallenge.WeeklyChallengeId,
    execute: (id) => sql`DELETE FROM weekly_challenges WHERE id = ${id}`,
  });

  const findWeekStartForUpdateQuery = SqlSchema.findOneOption({
    Request: WeeklyChallenge.WeeklyChallengeId,
    Result: WeekStartRow,
    execute: (id) => sql`SELECT week_start_date FROM weekly_challenges WHERE id = ${id} FOR UPDATE`,
  });

  const insertCompletionQuery = SqlSchema.void({
    Request: Schema.Struct({
      challenge_id: WeeklyChallenge.WeeklyChallengeId,
      member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) => sql`
      INSERT INTO weekly_challenge_completions (challenge_id, member_id)
      VALUES (${input.challenge_id}, ${input.member_id})
      ON CONFLICT DO NOTHING
    `,
  });

  const deleteCompletionQuery = SqlSchema.void({
    Request: Schema.Struct({
      challenge_id: WeeklyChallenge.WeeklyChallengeId,
      member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) => sql`
      DELETE FROM weekly_challenge_completions
      WHERE challenge_id = ${input.challenge_id} AND member_id = ${input.member_id}
    `,
  });

  const insertSyncEventQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      challenge_id: WeeklyChallenge.WeeklyChallengeId,
      channel_id: Discord.Snowflake,
      scheduled_for: Schema.Date,
    }),
    execute: (input) => sql`
      INSERT INTO weekly_challenge_sync_events (team_id, challenge_id, channel_id, scheduled_for)
      VALUES (${input.team_id}, ${input.challenge_id}, ${input.channel_id}, ${input.scheduled_for})
    `,
  });

  const findUnprocessedDueEventsQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SyncEventRow,
    execute: () => sql`
      SELECT
        wcse.id::text AS id,
        wcse.team_id,
        wcse.challenge_id,
        wcse.channel_id,
        wcse.scheduled_for,
        wcse.attempts,
        wcse.last_error,
        wcse.created_at,
        wcse.processed_at,
        wcse.delivered_at,
        wc.title,
        wc.kind,
        wc.description,
        wc.week_start_date
      FROM weekly_challenge_sync_events wcse
      JOIN weekly_challenges wc ON wc.id = wcse.challenge_id
      WHERE wcse.processed_at IS NULL
        AND wcse.scheduled_for <= now()
      ORDER BY wcse.created_at ASC
    `,
  });

  const markEventProcessedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      delivered_at: Schema.Date,
    }),
    execute: (input) => sql`
      UPDATE weekly_challenge_sync_events
      SET processed_at = now(), delivered_at = ${input.delivered_at}
      WHERE id = ${input.id}::uuid AND processed_at IS NULL
    `,
  });

  const markEventFailedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      error: Schema.String,
      max_attempts: Schema.Int,
    }),
    execute: (input) => sql`
      UPDATE weekly_challenge_sync_events
      SET attempts = attempts + 1,
          last_error = ${input.error},
          processed_at = CASE WHEN attempts + 1 >= ${input.max_attempts} THEN now() ELSE NULL END
      WHERE id = ${input.id}::uuid AND processed_at IS NULL
    `,
  });

  // ---- Public methods ----

  const listForTeam = (teamId: Team.TeamId, teamTz: string, limit = 12) => {
    const currentMonday = currentTeamMondayDateString(teamTz);

    return listForTeamQuery({ team_id: teamId, limit }).pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        const ids = rows.map((r) => r.id);
        return listCompletionsForChallengesQuery(ids).pipe(
          catchSqlErrors,
          Effect.map((completions) => {
            const byChallenge = new Map<
              WeeklyChallenge.WeeklyChallengeId,
              TeamMember.TeamMemberId[]
            >();
            for (const c of completions) {
              const existing = byChallenge.get(c.challenge_id) ?? [];
              existing.push(c.member_id);
              byChallenge.set(c.challenge_id, existing);
            }
            return rows.map((row) => {
              // `week_start_date` is a Postgres `DATE` (UTC-midnight when
              // materialised as a JS Date). Compare its UTC calendar day to
              // the team's current Monday — using the team timezone here
              // would shift the day for western offsets.
              const rowDateStr = formatDateUtc(row.week_start_date);
              const isActive = rowDateStr === currentMonday;
              return new WeeklyChallenge.WeeklyChallengeView({
                challenge: toWeeklyChallenge(row),
                completedMemberIds: byChallenge.get(row.id) ?? [],
                isActive,
              });
            });
          }),
        );
      }),
    );
  };

  const findById = (challengeId: WeeklyChallenge.WeeklyChallengeId) =>
    findByIdQuery(challengeId).pipe(catchSqlErrors, Effect.map(Option.map(toWeeklyChallenge)));

  const create = (input: {
    readonly team_id: Team.TeamId;
    readonly week_start_date: Date;
    readonly kind: WeeklyChallenge.WeeklyChallengeKind;
    readonly title: WeeklyChallenge.WeeklyChallengeTitle;
    readonly description: Option.Option<WeeklyChallenge.WeeklyChallengeDescription>;
    readonly created_by: TeamMember.TeamMemberId;
  }): Effect.Effect<
    WeeklyChallenge.WeeklyChallenge,
    WeeklyChallengeRpcGroup.WeeklyChallengeAlreadyExistsForWeek
  > =>
    insertChallengeQuery(input).pipe(
      SqlErrors.catchUniqueViolation(() => new WeeklyChallengeAlreadyExistsForWeek()),
      catchSqlErrors,
      // INSERT ... RETURNING always returns exactly one row; treat NoSuchElement as a defect.
      Effect.orDie,
      Effect.map(toWeeklyChallenge),
    );

  const updateTitleDescription = (
    challengeId: WeeklyChallenge.WeeklyChallengeId,
    title: WeeklyChallenge.WeeklyChallengeTitle,
    description: Option.Option<WeeklyChallenge.WeeklyChallengeDescription>,
  ) =>
    updateTitleDescriptionQuery({ id: challengeId, title, description }).pipe(
      catchSqlErrors,
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(new WeeklyChallengeNotFound()) as Effect.Effect<
              WeeklyChallenge.WeeklyChallenge,
              WeeklyChallengeRpcGroup.WeeklyChallengeNotFound
            >,
          onSome: (row) =>
            Effect.succeed(toWeeklyChallenge(row)) as Effect.Effect<
              WeeklyChallenge.WeeklyChallenge,
              WeeklyChallengeRpcGroup.WeeklyChallengeNotFound
            >,
        }),
      ),
    );

  const deleteFn = (challengeId: WeeklyChallenge.WeeklyChallengeId) =>
    deleteQuery(challengeId).pipe(catchSqlErrors);

  type MarkErr =
    | WeeklyChallengeRpcGroup.WeeklyChallengeNotFound
    | WeeklyChallengeRpcGroup.WeeklyChallengeNotActive;

  const markCompleted = (
    challengeId: WeeklyChallenge.WeeklyChallengeId,
    memberId: TeamMember.TeamMemberId,
    teamTz: string,
  ): Effect.Effect<void, MarkErr> =>
    sql
      .withTransaction(
        findWeekStartForUpdateQuery(challengeId).pipe(
          catchSqlErrors,
          Effect.flatMap((opt): Effect.Effect<void, MarkErr, never> => {
            if (Option.isNone(opt)) {
              return Effect.fail(new WeeklyChallengeNotFound());
            }
            const rowDateStr = weekStartDateString(opt.value.week_start_date, teamTz);
            const currentMonday = currentTeamMondayDateString(teamTz);
            if (rowDateStr !== currentMonday) {
              return Effect.fail(new WeeklyChallengeNotActive());
            }
            return insertCompletionQuery({ challenge_id: challengeId, member_id: memberId }).pipe(
              catchSqlErrors,
            );
          }),
        ),
      )
      .pipe(catchSqlErrors);

  const unmarkCompleted = (
    challengeId: WeeklyChallenge.WeeklyChallengeId,
    memberId: TeamMember.TeamMemberId,
    teamTz: string,
  ): Effect.Effect<void, MarkErr> =>
    sql
      .withTransaction(
        findWeekStartForUpdateQuery(challengeId).pipe(
          catchSqlErrors,
          Effect.flatMap((opt): Effect.Effect<void, MarkErr, never> => {
            if (Option.isNone(opt)) {
              return Effect.fail(new WeeklyChallengeNotFound());
            }
            const rowDateStr = weekStartDateString(opt.value.week_start_date, teamTz);
            const currentMonday = currentTeamMondayDateString(teamTz);
            if (rowDateStr !== currentMonday) {
              return Effect.fail(new WeeklyChallengeNotActive());
            }
            return deleteCompletionQuery({ challenge_id: challengeId, member_id: memberId }).pipe(
              catchSqlErrors,
            );
          }),
        ),
      )
      .pipe(catchSqlErrors);

  const enqueueAnnouncementEvent = (
    challengeId: WeeklyChallenge.WeeklyChallengeId,
    teamId: Team.TeamId,
    channelId: Discord.Snowflake,
    scheduledFor: Date,
  ) =>
    insertSyncEventQuery({
      team_id: teamId,
      challenge_id: challengeId,
      channel_id: channelId,
      scheduled_for: scheduledFor,
    }).pipe(catchSqlErrors);

  const listUnprocessedDueEvents = () =>
    findUnprocessedDueEventsQuery(undefined).pipe(catchSqlErrors);

  const markProcessed = (eventId: string, deliveredAt: Date) =>
    markEventProcessedQuery({ id: eventId, delivered_at: deliveredAt }).pipe(catchSqlErrors);

  const markFailed = (eventId: string, error: string) =>
    markEventFailedQuery({ id: eventId, error, max_attempts: MAX_ATTEMPTS }).pipe(catchSqlErrors);

  return {
    listForTeam,
    findById,
    create,
    updateTitleDescription,
    delete: deleteFn,
    markCompleted,
    unmarkCompleted,
    enqueueAnnouncementEvent,
    listUnprocessedDueEvents,
    markProcessed,
    markFailed,
  };
});

export class WeeklyChallengeRepository extends ServiceMap.Service<
  WeeklyChallengeRepository,
  Effect.Success<typeof make>
>()('api/WeeklyChallengeRepository') {
  static readonly Default = Layer.effect(WeeklyChallengeRepository, make);
}
