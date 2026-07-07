import { Discord, Team, TeamChallenge, TeamChallengeRpcGroup, TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { DateTime, Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { formatDateUtc, todayInTzString } from '~/helpers/teamChallenge.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const { TeamChallengeNotFound, TeamChallengeNotActive } = TeamChallengeRpcGroup;

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

const MAX_ATTEMPTS = 5;

class ChallengeRow extends Schema.Class<ChallengeRow>('TcChallengeRow')({
  id: TeamChallenge.TeamChallengeId,
  team_id: Team.TeamId,
  start_date: Schema.Date,
  end_date: Schema.Date,
  kind: TeamChallenge.TeamChallengeKind,
  title: TeamChallenge.TeamChallengeTitle,
  description: Schema.OptionFromNullOr(TeamChallenge.TeamChallengeDescription),
  created_by: TeamMember.TeamMemberId,
  created_at: Schema.Date,
  updated_at: Schema.Date,
}) {}

class CompletionRow extends Schema.Class<CompletionRow>('TcCompletionRow')({
  challenge_id: TeamChallenge.TeamChallengeId,
  member_id: TeamMember.TeamMemberId,
}) {}

class DateRangeRow extends Schema.Class<DateRangeRow>('TcDateRangeRow')({
  start_date: Schema.Date,
  end_date: Schema.Date,
}) {}

export class SyncEventRow extends Schema.Class<SyncEventRow>('TcSyncEventRow')({
  id: Schema.String,
  team_id: Team.TeamId,
  challenge_id: TeamChallenge.TeamChallengeId,
  channel_id: Discord.Snowflake,
  scheduled_for: Schema.Date,
  attempts: Schema.Int,
  last_error: Schema.OptionFromNullOr(Schema.String),
  created_at: Schema.Date,
  processed_at: Schema.OptionFromNullOr(Schema.Date),
  delivered_at: Schema.OptionFromNullOr(Schema.Date),
  // joined from team_challenges
  title: TeamChallenge.TeamChallengeTitle,
  kind: TeamChallenge.TeamChallengeKind,
  description: Schema.OptionFromNullOr(TeamChallenge.TeamChallengeDescription),
  start_date: Schema.Date,
  end_date: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// Helper: build TeamChallenge domain model from ChallengeRow
// ---------------------------------------------------------------------------

const toTeamChallenge = (row: ChallengeRow): TeamChallenge.TeamChallenge =>
  new TeamChallenge.TeamChallenge({
    id: row.id,
    team_id: row.team_id,
    start_date: row.start_date,
    end_date: row.end_date,
    kind: row.kind,
    title: row.title,
    description: row.description,
    created_by: row.created_by,
    created_at: DateTime.makeUnsafe(row.created_at.getTime()),
    updated_at: DateTime.makeUnsafe(row.updated_at.getTime()),
  });

// ---------------------------------------------------------------------------
// TeamChallengeRepository
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
      SELECT id, team_id, start_date, end_date, kind, title, description, created_by, created_at, updated_at
      FROM team_challenges
      WHERE team_id = ${input.team_id}
      ORDER BY start_date DESC, id DESC
      LIMIT ${input.limit}
    `,
  });

  const listCompletionsForChallengesQuery = SqlSchema.findAll({
    Request: Schema.Array(TeamChallenge.TeamChallengeId),
    Result: CompletionRow,
    execute: (ids) =>
      ids.length === 0
        ? sql`SELECT challenge_id, member_id FROM team_challenge_completions WHERE false`
        : sql`
      SELECT challenge_id, member_id
      FROM team_challenge_completions
      WHERE challenge_id IN ${sql.in([...ids])}
    `,
  });

  const findByIdQuery = SqlSchema.findOneOption({
    Request: TeamChallenge.TeamChallengeId,
    Result: ChallengeRow,
    execute: (id) => sql`
      SELECT id, team_id, start_date, end_date, kind, title, description, created_by, created_at, updated_at
      FROM team_challenges
      WHERE id = ${id}
    `,
  });

  const insertChallengeQuery = SqlSchema.findOne({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      start_date: Schema.Date,
      end_date: Schema.Date,
      kind: TeamChallenge.TeamChallengeKind,
      title: TeamChallenge.TeamChallengeTitle,
      description: Schema.OptionFromNullOr(TeamChallenge.TeamChallengeDescription),
      created_by: TeamMember.TeamMemberId,
    }),
    Result: ChallengeRow,
    execute: (input) => sql`
      INSERT INTO team_challenges (team_id, start_date, end_date, kind, title, description, created_by)
      VALUES (
        ${input.team_id},
        ${input.start_date},
        ${input.end_date},
        ${input.kind},
        ${input.title},
        ${input.description},
        ${input.created_by}
      )
      RETURNING id, team_id, start_date, end_date, kind, title, description, created_by, created_at, updated_at
    `,
  });

  const updateTitleDescriptionQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      id: TeamChallenge.TeamChallengeId,
      title: TeamChallenge.TeamChallengeTitle,
      description: Schema.OptionFromNullOr(TeamChallenge.TeamChallengeDescription),
    }),
    Result: ChallengeRow,
    execute: (input) => sql`
      UPDATE team_challenges
      SET title = ${input.title},
          description = ${input.description},
          updated_at = now()
      WHERE id = ${input.id}
      RETURNING id, team_id, start_date, end_date, kind, title, description, created_by, created_at, updated_at
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: TeamChallenge.TeamChallengeId,
    execute: (id) => sql`DELETE FROM team_challenges WHERE id = ${id}`,
  });

  const findDateRangeForUpdateQuery = SqlSchema.findOneOption({
    Request: TeamChallenge.TeamChallengeId,
    Result: DateRangeRow,
    execute: (id) =>
      sql`SELECT start_date, end_date FROM team_challenges WHERE id = ${id} FOR UPDATE`,
  });

  const insertCompletionQuery = SqlSchema.void({
    Request: Schema.Struct({
      challenge_id: TeamChallenge.TeamChallengeId,
      member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) => sql`
      INSERT INTO team_challenge_completions (challenge_id, member_id)
      VALUES (${input.challenge_id}, ${input.member_id})
      ON CONFLICT DO NOTHING
    `,
  });

  const deleteCompletionQuery = SqlSchema.void({
    Request: Schema.Struct({
      challenge_id: TeamChallenge.TeamChallengeId,
      member_id: TeamMember.TeamMemberId,
    }),
    execute: (input) => sql`
      DELETE FROM team_challenge_completions
      WHERE challenge_id = ${input.challenge_id} AND member_id = ${input.member_id}
    `,
  });

  const insertSyncEventQuery = SqlSchema.void({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      challenge_id: TeamChallenge.TeamChallengeId,
      channel_id: Discord.Snowflake,
      scheduled_for: Schema.Date,
    }),
    execute: (input) => sql`
      INSERT INTO team_challenge_sync_events (team_id, challenge_id, channel_id, scheduled_for)
      VALUES (${input.team_id}, ${input.challenge_id}, ${input.channel_id}, ${input.scheduled_for})
    `,
  });

  const findUnprocessedDueEventsQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SyncEventRow,
    execute: () => sql`
      SELECT
        tcse.id::text AS id,
        tcse.team_id,
        tcse.challenge_id,
        tcse.channel_id,
        tcse.scheduled_for,
        tcse.attempts,
        tcse.last_error,
        tcse.created_at,
        tcse.processed_at,
        tcse.delivered_at,
        tc.title,
        tc.kind,
        tc.description,
        tc.start_date,
        tc.end_date
      FROM team_challenge_sync_events tcse
      JOIN team_challenges tc ON tc.id = tcse.challenge_id
      WHERE tcse.processed_at IS NULL
        AND tcse.scheduled_for <= now()
      ORDER BY tcse.created_at ASC
    `,
  });

  const markEventProcessedQuery = SqlSchema.void({
    Request: Schema.Struct({
      id: Schema.String,
      delivered_at: Schema.Date,
    }),
    execute: (input) => sql`
      UPDATE team_challenge_sync_events
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
      UPDATE team_challenge_sync_events
      SET attempts = attempts + 1,
          last_error = ${input.error},
          processed_at = CASE WHEN attempts + 1 >= ${input.max_attempts} THEN now() ELSE NULL END
      WHERE id = ${input.id}::uuid AND processed_at IS NULL
    `,
  });

  // ---- Public methods ----

  const listForTeam = (teamId: Team.TeamId, teamTz: string, limit = 12) => {
    const todayStr = todayInTzString(teamTz);

    return listForTeamQuery({ team_id: teamId, limit }).pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        const ids = rows.map((r) => r.id);
        return listCompletionsForChallengesQuery(ids).pipe(
          catchSqlErrors,
          Effect.map((completions) => {
            const byChallenge = new Map<TeamChallenge.TeamChallengeId, TeamMember.TeamMemberId[]>();
            for (const c of completions) {
              const existing = byChallenge.get(c.challenge_id) ?? [];
              existing.push(c.member_id);
              byChallenge.set(c.challenge_id, existing);
            }
            const challenges = rows.map((row) => {
              // isActive: today (team-local calendar day) is within [start_date, end_date] inclusive.
              // start_date and end_date are Postgres DATE columns, read as UTC midnight.
              const startStr = formatDateUtc(row.start_date);
              const endStr = formatDateUtc(row.end_date);
              const isActive = todayStr >= startStr && todayStr <= endStr;
              return new TeamChallenge.TeamChallengeView({
                challenge: toTeamChallenge(row),
                completedMemberIds: byChallenge.get(row.id) ?? [],
                isActive,
              });
            });
            return { team: { id: teamId, timezone: teamTz }, challenges };
          }),
        );
      }),
    );
  };

  const findById = (challengeId: TeamChallenge.TeamChallengeId) =>
    findByIdQuery(challengeId).pipe(catchSqlErrors, Effect.map(Option.map(toTeamChallenge)));

  const create = (input: {
    readonly team_id: Team.TeamId;
    readonly start_date: Date;
    readonly end_date: Date;
    readonly kind: TeamChallenge.TeamChallengeKind;
    readonly title: TeamChallenge.TeamChallengeTitle;
    readonly description: Option.Option<TeamChallenge.TeamChallengeDescription>;
    readonly created_by: TeamMember.TeamMemberId;
  }): Effect.Effect<TeamChallenge.TeamChallenge, never> =>
    insertChallengeQuery(input).pipe(
      catchSqlErrors,
      // INSERT ... RETURNING always returns exactly one row; treat NoSuchElement as a defect.
      Effect.catchTag('NoSuchElementError', () =>
        LogicError.die('Team challenge insert returned no row'),
      ),
      Effect.map(toTeamChallenge),
    );

  const updateTitleDescription = (
    challengeId: TeamChallenge.TeamChallengeId,
    title: TeamChallenge.TeamChallengeTitle,
    description: Option.Option<TeamChallenge.TeamChallengeDescription>,
  ) =>
    updateTitleDescriptionQuery({ id: challengeId, title, description }).pipe(
      catchSqlErrors,
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(new TeamChallengeNotFound()),
          onSome: (row) => Effect.succeed(toTeamChallenge(row)),
        }),
      ),
    );

  const deleteFn = (challengeId: TeamChallenge.TeamChallengeId) =>
    deleteQuery(challengeId).pipe(catchSqlErrors);

  type MarkErr =
    | TeamChallengeRpcGroup.TeamChallengeNotFound
    | TeamChallengeRpcGroup.TeamChallengeNotActive;

  const markCompleted = (
    challengeId: TeamChallenge.TeamChallengeId,
    memberId: TeamMember.TeamMemberId,
    teamTz: string,
  ): Effect.Effect<void, MarkErr> =>
    sql
      .withTransaction(
        findDateRangeForUpdateQuery(challengeId).pipe(
          catchSqlErrors,
          Effect.flatMap((opt): Effect.Effect<void, MarkErr, never> => {
            if (Option.isNone(opt)) {
              return Effect.fail(new TeamChallengeNotFound());
            }
            const todayStr = todayInTzString(teamTz);
            const startStr = formatDateUtc(opt.value.start_date);
            const endStr = formatDateUtc(opt.value.end_date);
            if (todayStr < startStr || todayStr > endStr) {
              return Effect.fail(new TeamChallengeNotActive());
            }
            return insertCompletionQuery({ challenge_id: challengeId, member_id: memberId }).pipe(
              catchSqlErrors,
            );
          }),
        ),
      )
      .pipe(catchSqlErrors);

  const unmarkCompleted = (
    challengeId: TeamChallenge.TeamChallengeId,
    memberId: TeamMember.TeamMemberId,
    teamTz: string,
  ): Effect.Effect<void, MarkErr> =>
    sql
      .withTransaction(
        findDateRangeForUpdateQuery(challengeId).pipe(
          catchSqlErrors,
          Effect.flatMap((opt): Effect.Effect<void, MarkErr, never> => {
            if (Option.isNone(opt)) {
              return Effect.fail(new TeamChallengeNotFound());
            }
            const todayStr = todayInTzString(teamTz);
            const startStr = formatDateUtc(opt.value.start_date);
            const endStr = formatDateUtc(opt.value.end_date);
            if (todayStr < startStr || todayStr > endStr) {
              return Effect.fail(new TeamChallengeNotActive());
            }
            return deleteCompletionQuery({ challenge_id: challengeId, member_id: memberId }).pipe(
              catchSqlErrors,
            );
          }),
        ),
      )
      .pipe(catchSqlErrors);

  const enqueueAnnouncementEvent = (
    challengeId: TeamChallenge.TeamChallengeId,
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

export class TeamChallengeRepository extends ServiceMap.Service<
  TeamChallengeRepository,
  Effect.Success<typeof make>
>()('api/TeamChallengeRepository') {
  static readonly Default = Layer.effect(TeamChallengeRepository, make);
}
