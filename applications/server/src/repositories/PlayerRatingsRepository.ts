import { Elo, Team, TeamMember, type TrainingGame } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

// ---------------------------------------------------------------------------
// Row schemas
// ---------------------------------------------------------------------------

class RatingWithHistoryRow extends Schema.Class<RatingWithHistoryRow>('RatingWithHistoryRow')({
  team_member_id: TeamMember.TeamMemberId,
  team_id: Team.TeamId,
  rating: Schema.Int,
  games_played: Schema.Int,
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
  prev_rating: Schema.OptionFromNullOr(Schema.Int),
  last_delta: Schema.OptionFromNullOr(Schema.Int),
}) {}

class RatingRow extends Schema.Class<RatingRow>('RatingRow')({
  id: Schema.String,
  team_member_id: TeamMember.TeamMemberId,
  team_id: Team.TeamId,
  rating: Schema.Int,
  games_played: Schema.Int,
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
}) {}

class HistoryRow extends Schema.Class<HistoryRow>('HistoryRow')({
  id: Schema.String,
  team_member_id: TeamMember.TeamMemberId,
  team_id: Team.TeamId,
  rating_before: Schema.Int,
  rating_after: Schema.Int,
  delta: Schema.Int,
  result: Schema.Literals(['win', 'loss', 'draw']),
  game_id: Schema.OptionFromNullOr(Schema.String),
  submitted_by: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  created_at: Schema.Date,
}) {}

// ---------------------------------------------------------------------------
// Exported type for applyGameUpdates params
// ---------------------------------------------------------------------------

export interface ApplyGameUpdatesParams {
  readonly teamId: Team.TeamId;
  readonly teamAMemberIds: ReadonlyArray<TeamMember.TeamMemberId>;
  readonly teamBMemberIds: ReadonlyArray<TeamMember.TeamMemberId>;
  readonly outcome: Elo.GameOutcome;
  readonly submittedBy: Option.Option<TeamMember.TeamMemberId>;
  readonly gameId?: Option.Option<TrainingGame.TrainingGameId>;
}

// ---------------------------------------------------------------------------
// Re-export row types for tests and handlers
// ---------------------------------------------------------------------------

export type { HistoryRow, RatingRow, RatingWithHistoryRow };

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // ---- Queries ----

  const getMemberRatingQuery = SqlSchema.findOneOption({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      team_member_id: TeamMember.TeamMemberId,
    }),
    Result: RatingWithHistoryRow,
    execute: (input) => sql`
      SELECT
        pr.team_member_id,
        pr.team_id,
        pr.rating,
        pr.games_played,
        pr.wins,
        pr.losses,
        pr.draws,
        lh.rating_before AS prev_rating,
        lh.delta AS last_delta
      FROM player_ratings pr
      LEFT JOIN LATERAL (
        SELECT rating_before, delta
        FROM player_rating_history
        WHERE team_member_id = pr.team_member_id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) lh ON true
      WHERE pr.team_id = ${input.team_id}
        AND pr.team_member_id = ${input.team_member_id}
    `,
  });

  const getTeamRatingsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ team_id: Team.TeamId }),
    Result: RatingWithHistoryRow,
    execute: (input) => sql`
      SELECT
        pr.team_member_id,
        pr.team_id,
        pr.rating,
        pr.games_played,
        pr.wins,
        pr.losses,
        pr.draws,
        lh.rating_before AS prev_rating,
        lh.delta AS last_delta
      FROM player_ratings pr
      LEFT JOIN LATERAL (
        SELECT rating_before, delta
        FROM player_rating_history
        WHERE team_member_id = pr.team_member_id
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      ) lh ON true
      WHERE pr.team_id = ${input.team_id}
      ORDER BY pr.rating DESC, pr.team_member_id ASC
    `,
  });

  const findHistoryByMemberQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      team_member_id: TeamMember.TeamMemberId,
      limit: Schema.Int,
    }),
    Result: HistoryRow,
    execute: (input) => sql`
      SELECT id, team_member_id, team_id, rating_before, rating_after, delta, result, game_id, submitted_by, created_at
      FROM player_rating_history
      WHERE team_id = ${input.team_id}
        AND team_member_id = ${input.team_member_id}
      ORDER BY created_at DESC, id DESC
      LIMIT ${input.limit}
    `,
  });

  const getRatingRowsQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_id: Team.TeamId,
      member_ids: Schema.Array(TeamMember.TeamMemberId),
    }),
    Result: RatingRow,
    execute: (input) =>
      input.member_ids.length === 0
        ? sql`SELECT id, team_member_id, team_id, rating, games_played, wins, losses, draws FROM player_ratings WHERE false`
        : sql`
          SELECT id, team_member_id, team_id, rating, games_played, wins, losses, draws
          FROM player_ratings
          WHERE team_id = ${input.team_id}
            AND team_member_id IN ${sql.in([...input.member_ids])}
        `,
  });

  // Raw: insert with ON CONFLICT DO NOTHING (returns SqlFragment, use with pipe)
  const ensureRatingsExist = (
    teamId: Team.TeamId,
    memberIds: ReadonlyArray<TeamMember.TeamMemberId>,
  ): Effect.Effect<void> => {
    if (memberIds.length === 0) return Effect.void;
    return sql`
      INSERT INTO player_ratings (team_id, team_member_id, rating, games_played, wins, losses, draws)
      SELECT
        ${teamId},
        m.id,
        ${Elo.DEFAULT_RATING},
        0, 0, 0, 0
      FROM (
        SELECT unnest(${memberIds}::uuid[]) AS id
      ) m
      ON CONFLICT (team_id, team_member_id) DO NOTHING
    `.pipe(catchSqlErrors, Effect.asVoid);
  };

  // ---- Public methods ----

  const getMemberRating = (teamId: Team.TeamId, memberId: TeamMember.TeamMemberId) =>
    getMemberRatingQuery({ team_id: teamId, team_member_id: memberId }).pipe(catchSqlErrors);

  const getTeamRatings = (teamId: Team.TeamId) =>
    getTeamRatingsQuery({ team_id: teamId }).pipe(catchSqlErrors);

  const findHistoryByMember = (
    teamId: Team.TeamId,
    memberId: TeamMember.TeamMemberId,
    limit = 50,
  ) =>
    findHistoryByMemberQuery({ team_id: teamId, team_member_id: memberId, limit }).pipe(
      catchSqlErrors,
    );

  const getOrInitMany = (
    teamId: Team.TeamId,
    memberIds: ReadonlyArray<TeamMember.TeamMemberId>,
  ): Effect.Effect<ReadonlyArray<RatingRow>> => {
    if (memberIds.length === 0) {
      return Effect.succeed([]);
    }
    return ensureRatingsExist(teamId, memberIds).pipe(
      Effect.andThen(() =>
        getRatingRowsQuery({ team_id: teamId, member_ids: memberIds }).pipe(catchSqlErrors),
      ),
    );
  };

  const applyGameUpdatesTx = (params: ApplyGameUpdatesParams) => {
    const { teamId, teamAMemberIds, teamBMemberIds, outcome, submittedBy } = params;
    const gameId = params.gameId ?? Option.none<TrainingGame.TrainingGameId>();

    // Dedupe + sort union of all member ids by team_member_id for consistent lock ordering
    const allMemberIdSet = new Set<TeamMember.TeamMemberId>([...teamAMemberIds, ...teamBMemberIds]);
    const allMemberIds = Array.from(allMemberIdSet).sort();

    if (allMemberIds.length === 0) {
      return Effect.void;
    }

    // Determine per-player result from outcome
    const teamASet = new Set<string>(teamAMemberIds);
    const teamBSet = new Set<string>(teamBMemberIds);
    const getResult = (memberId: string): 'win' | 'loss' | 'draw' => {
      if (outcome === 'teamA') {
        return teamASet.has(memberId) ? 'win' : 'loss';
      } else if (outcome === 'teamB') {
        return teamBSet.has(memberId) ? 'win' : 'loss';
      } else {
        return 'draw';
      }
    };

    const submittedByVal = Option.getOrNull(submittedBy);
    const gameIdVal = Option.getOrNull(gameId);

    // Build PlayerRatingInput array from locked rows, failing if any member is missing
    const buildSide = (
      rowMap: Map<string, RatingRow>,
      ids: ReadonlyArray<TeamMember.TeamMemberId>,
    ): Effect.Effect<
      ReadonlyArray<{ teamMemberId: string; rating: number; gamesPlayed: number }>
    > =>
      Effect.forEach(ids, (id) => {
        const row = rowMap.get(id);
        if (row === undefined) {
          return LogicError.die(
            `applyGameUpdates: locked rows missing member ${id} — invariant violation`,
          );
        }
        return Effect.succeed({
          teamMemberId: row.team_member_id,
          rating: row.rating,
          gamesPlayed: row.games_played,
        });
      });

    return Effect.Do.pipe(
      // Step 1: Ensure rows exist (INSERT ... ON CONFLICT DO NOTHING)
      Effect.tap(() => ensureRatingsExist(teamId, allMemberIds)),
      // Step 2: Lock rows in sorted order (FOR UPDATE)
      Effect.bind('lockedRows', () =>
        sql`
          SELECT id, team_member_id, team_id, rating, games_played, wins, losses, draws
          FROM player_ratings
          WHERE team_id = ${teamId}
            AND team_member_id IN ${sql.in([...allMemberIds])}
          ORDER BY team_member_id
          FOR UPDATE
        `.pipe(catchSqlErrors, Effect.flatMap(Schema.decodeUnknownEffect(Schema.Array(RatingRow)))),
      ),
      // Step 3: Build per-side PlayerRatingInput arrays from locked rows
      Effect.let(
        'rowMap',
        ({ lockedRows }) =>
          new Map<string, RatingRow>(lockedRows.map((r) => [r.team_member_id, r])),
      ),
      Effect.bind('teamAInput', ({ rowMap }) => buildSide(rowMap, teamAMemberIds)),
      Effect.bind('teamBInput', ({ rowMap }) => buildSide(rowMap, teamBMemberIds)),
      // Step 4: Compute Elo updates inside the transaction on locked values
      Effect.let('engineResult', ({ teamAInput, teamBInput }) =>
        Elo.computeTeamGameUpdate({
          teamA: teamAInput,
          teamB: teamBInput,
          outcome,
        }),
      ),
      // Step 5: Apply updates sequentially (concurrency:1)
      Effect.tap(({ engineResult, rowMap }) => {
        const allUpdates = [...engineResult.teamA, ...engineResult.teamB];

        return Effect.forEach(
          allUpdates,
          (update): Effect.Effect<void> => {
            const oldRow = rowMap.get(update.teamMemberId);
            if (!oldRow) {
              return LogicError.die(
                `applyGameUpdates: missing locked row for ${update.teamMemberId} during write`,
              );
            }

            const result = getResult(update.teamMemberId);
            const winsIncr = result === 'win' ? 1 : 0;
            const lossesIncr = result === 'loss' ? 1 : 0;
            const drawsIncr = result === 'draw' ? 1 : 0;

            return sql`
              UPDATE player_ratings
              SET rating = ${update.newRating},
                  games_played = games_played + 1,
                  wins = wins + ${winsIncr},
                  losses = losses + ${lossesIncr},
                  draws = draws + ${drawsIncr},
                  updated_at = now()
              WHERE team_id = ${teamId}
                AND team_member_id = ${update.teamMemberId}
            `.pipe(
              Effect.andThen(
                sql`
                  INSERT INTO player_rating_history
                    (team_id, team_member_id, rating_before, rating_after, delta, result, game_id, submitted_by)
                  VALUES (
                    ${teamId},
                    ${update.teamMemberId},
                    ${update.oldRating},
                    ${update.newRating},
                    ${update.delta},
                    ${result},
                    ${gameIdVal},
                    ${submittedByVal}
                  )
                `,
              ),
              catchSqlErrors,
              Effect.asVoid,
            );
          },
          { concurrency: 1, discard: true },
        );
      }),
      Effect.asVoid,
    );
  };

  const applyGameUpdates = (params: ApplyGameUpdatesParams): Effect.Effect<void> =>
    applyGameUpdatesTx(params).pipe(sql.withTransaction, catchSqlErrors);

  const seedRating = (
    teamId: Team.TeamId,
    memberId: TeamMember.TeamMemberId,
    rating: number,
  ): Effect.Effect<Option.Option<RatingWithHistoryRow>> =>
    sql<{
      team_member_id: TeamMember.TeamMemberId;
      team_id: Team.TeamId;
      rating: number;
      games_played: number;
      wins: number;
      losses: number;
      draws: number;
      prev_rating: number | null;
      last_delta: number | null;
    }>`
      INSERT INTO player_ratings (team_id, team_member_id, rating, games_played, wins, losses, draws)
      VALUES (${teamId}, ${memberId}, ${rating}, 0, 0, 0, 0)
      ON CONFLICT (team_id, team_member_id) DO UPDATE
        SET rating = EXCLUDED.rating, updated_at = now()
        WHERE player_ratings.games_played = 0
      RETURNING
        team_member_id,
        team_id,
        rating,
        games_played,
        wins,
        losses,
        draws,
        NULL::int AS prev_rating,
        NULL::int AS last_delta
    `.pipe(
      catchSqlErrors,
      Effect.flatMap((rows) => {
        const row = rows[0];
        if (row === undefined) {
          return Effect.succeed(Option.none<RatingWithHistoryRow>());
        }
        return Schema.decodeUnknownEffect(RatingWithHistoryRow)(row).pipe(
          catchSqlErrors,
          Effect.map(Option.some),
        );
      }),
    );

  return {
    getMemberRating,
    getTeamRatings,
    findHistoryByMember,
    getOrInitMany,
    applyGameUpdates,
    applyGameUpdatesTx,
    seedRating,
  };
});

export class PlayerRatingsRepository extends ServiceMap.Service<
  PlayerRatingsRepository,
  Effect.Success<typeof make>
>()('api/PlayerRatingsRepository') {
  static readonly Default = Layer.effect(PlayerRatingsRepository, make);
}
