import { Elo, PlayerRatingApi, type Team, type TeamMember } from '@sideline/domain';
import { DateTime, Effect, Option, type ServiceMap } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { GLOBAL_ADMIN_SENTINEL_ID, hasPermission } from '~/api/permissions.js';
import { requireManageAccess } from '~/api/training-shared.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EventRsvpsRepository } from '~/repositories/EventRsvpsRepository.js';
import { EventsRepository } from '~/repositories/EventsRepository.js';
import { PlayerRatingsRepository } from '~/repositories/PlayerRatingsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TrainingGamesRepository } from '~/repositories/TrainingGamesRepository.js';
import { clampRating, LlmClient } from '~/services/LlmClient.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HISTORY_LIMIT = 50;
const RATING_MIN = 800;
const RATING_MAX = 1800;

const requirePlayerRatingManageAccess = (
  members: ServiceMap.Service.Shape<typeof TeamMembersRepository>,
  teamId: Team.TeamId,
) => requireManageAccess(members, teamId, new PlayerRatingApi.Forbidden());

// ---------------------------------------------------------------------------
// Helper: validate team composition (shared by applyGameResult + logTrainingGame)
// Checks non-empty teams, no intra-team duplicates, no cross-team overlap, and
// that every id belongs to the roster. Fails with the matching InvalidGameResult.
// ---------------------------------------------------------------------------

const validateGameComposition = (
  teamA: ReadonlyArray<TeamMember.TeamMemberId>,
  teamB: ReadonlyArray<TeamMember.TeamMemberId>,
  rosterIds: ReadonlySet<TeamMember.TeamMemberId>,
): Effect.Effect<void, PlayerRatingApi.InvalidGameResult> => {
  if (teamA.length === 0 || teamB.length === 0) {
    return Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'emptyTeam' }));
  }
  const setA = new Set(teamA);
  const setB = new Set(teamB);
  if (setA.size !== teamA.length || setB.size !== teamB.length) {
    return Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'overlap' }));
  }
  if (teamB.some((id) => setA.has(id))) {
    return Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'overlap' }));
  }
  if ([...teamA, ...teamB].some((id) => !rosterIds.has(id))) {
    return Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'unknownMember' }));
  }
  return Effect.void;
};

// ---------------------------------------------------------------------------
// Helper: build TeamRatingsResponse from rating rows
// ---------------------------------------------------------------------------

const buildTeamRatingsResponse = (
  rows: ReadonlyArray<{
    team_member_id: TeamMember.TeamMemberId;
    rating: number;
    games_played: number;
    prev_rating: Option.Option<number>;
    last_delta: Option.Option<number>;
    wins: number;
    losses: number;
    draws: number;
  }>,
  canManage: boolean,
) =>
  new PlayerRatingApi.TeamRatingsResponse({
    canManage,
    calibrationThreshold: Elo.CALIBRATION_GAMES,
    entries: rows.map(
      (row) =>
        new PlayerRatingApi.TeamRatingEntry({
          memberId: row.team_member_id,
          rating: row.rating,
          gamesPlayed: row.games_played,
          previousRating: row.prev_rating,
          lastDelta: row.last_delta,
          wins: row.wins,
          losses: row.losses,
          draws: row.draws,
        }),
    ),
  });

// ---------------------------------------------------------------------------
// API Live
// ---------------------------------------------------------------------------

export const PlayerRatingApiLive = HttpApiBuilder.group(Api, 'playerRating', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('ratings', () => PlayerRatingsRepository.asEffect()),
    Effect.map(({ members, ratings }) =>
      handlers
        // ------------------------------------------------------------------
        // GET /teams/:teamId/ratings
        // ------------------------------------------------------------------
        .handle('getTeamRatings', ({ params: { teamId } }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requirePlayerRatingManageAccess(members, teamId)),
            Effect.bind('rows', () => ratings.getTeamRatings(teamId)),
            Effect.map(({ gate: { currentUser, membership }, rows }) => {
              const canManage =
                currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');
              return buildTeamRatingsResponse(rows, canManage);
            }),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/members/:memberId/rating
        // ------------------------------------------------------------------
        .handle('getMemberRating', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requirePlayerRatingManageAccess(members, teamId)),
            // Verify member belongs to this team
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('row', () => ratings.getMemberRating(teamId, memberId)),
            Effect.map(({ row }) => {
              if (Option.isNone(row)) {
                // Member exists but has never played — return defaults
                return new PlayerRatingApi.MemberRatingResponse({
                  memberId,
                  rating: Elo.DEFAULT_RATING,
                  gamesPlayed: 0,
                  previousRating: Option.none(),
                  lastDelta: Option.none(),
                  wins: 0,
                  losses: 0,
                  draws: 0,
                  isCalibrating: true,
                  calibrationThreshold: Elo.CALIBRATION_GAMES,
                });
              }

              const r = row.value;
              return new PlayerRatingApi.MemberRatingResponse({
                memberId: r.team_member_id,
                rating: r.rating,
                gamesPlayed: r.games_played,
                previousRating: r.prev_rating,
                lastDelta: r.last_delta,
                wins: r.wins,
                losses: r.losses,
                draws: r.draws,
                isCalibrating: r.games_played < Elo.CALIBRATION_GAMES,
                calibrationThreshold: Elo.CALIBRATION_GAMES,
              });
            }),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/members/:memberId/rating/history
        // ------------------------------------------------------------------
        .handle('getMemberRatingHistory', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requirePlayerRatingManageAccess(members, teamId)),
            // Verify member belongs to this team
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('history', () =>
              ratings.findHistoryByMember(teamId, memberId, HISTORY_LIMIT),
            ),
            Effect.map(
              ({ history }) =>
                new PlayerRatingApi.RatingHistoryResponse({
                  entries: history.map(
                    (h) =>
                      new PlayerRatingApi.RatingHistoryEntry({
                        id: h.id,
                        ratingBefore: h.rating_before,
                        ratingAfter: h.rating_after,
                        delta: h.delta,
                        result: h.result,
                        gameId: h.game_id,
                        submittedBy: h.submitted_by,
                        createdAt: DateTime.formatIso(DateTime.makeUnsafe(h.created_at.getTime())),
                      }),
                  ),
                }),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/ratings/games
        // ------------------------------------------------------------------
        .handle('applyGameResult', ({ params: { teamId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requirePlayerRatingManageAccess(members, teamId)),
            // Verify all member ids belong to the team
            Effect.bind('rosterIds', () =>
              members
                .findRosterByTeam(teamId)
                .pipe(
                  Effect.map(
                    (roster) => new Set<TeamMember.TeamMemberId>(roster.map((r) => r.member_id)),
                  ),
                ),
            ),
            // Validate team composition (non-empty, no dups, no overlap, known members)
            Effect.tap(({ rosterIds }) =>
              validateGameComposition(payload.teamA, payload.teamB, rosterIds),
            ),
            // Apply updates — read+compute+write is atomic inside the transaction
            Effect.tap(({ gate }) => {
              // submittedBy: the current user's membership id if they are a real member
              const submittedBy =
                gate.membership.id === GLOBAL_ADMIN_SENTINEL_ID
                  ? Option.none<TeamMember.TeamMemberId>()
                  : Option.some(gate.membership.id);

              return ratings.applyGameUpdates({
                teamId,
                teamAMemberIds: payload.teamA,
                teamBMemberIds: payload.teamB,
                outcome: payload.outcome,
                submittedBy,
                gameId: Option.none(),
              });
            }),
            // Return updated team ratings
            Effect.bind('updatedRows', () => ratings.getTeamRatings(teamId)),
            Effect.map(({ gate: { currentUser, membership }, updatedRows }) => {
              const canManage =
                currentUser.isGlobalAdmin || hasPermission(membership, 'member:edit');
              return buildTeamRatingsResponse(updatedRows, canManage);
            }),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/events/:eventId/training-games
        // ------------------------------------------------------------------
        .handle('logTrainingGame', ({ params: { teamId, eventId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requirePlayerRatingManageAccess(members, teamId)),
            // Acquire lazily to avoid requiring these services in the old test layer
            Effect.bind('trainingGames', () => TrainingGamesRepository.asEffect()),
            Effect.bind('events', () => EventsRepository.asEffect()),
            Effect.bind('eventRsvps', () => EventRsvpsRepository.asEffect()),
            Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
            // Load event (scoped to team)
            Effect.bind('event', ({ events }) =>
              events.findEventByIdWithDetails(eventId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.EventNotLoggable()),
                    onSome: Effect.succeed,
                  }),
                ),
              ),
            ),
            // Validate event belongs to the requested team (cross-team scoping guard)
            Effect.tap(({ event }) =>
              event.team_id !== teamId
                ? Effect.fail(new PlayerRatingApi.EventNotLoggable())
                : Effect.void,
            ),
            // Validate event is not cancelled and is of type training
            Effect.tap(({ event }) =>
              event.status === 'cancelled' || event.event_type !== 'training'
                ? Effect.fail(new PlayerRatingApi.EventNotLoggable())
                : Effect.void,
            ),
            // Verify all member ids belong to the team roster
            Effect.bind('rosterIds', () =>
              members
                .findRosterByTeam(teamId)
                .pipe(
                  Effect.map(
                    (roster) => new Set<TeamMember.TeamMemberId>(roster.map((r) => r.member_id)),
                  ),
                ),
            ),
            // Validate team composition (non-empty, no dups, no overlap, known members)
            Effect.tap(({ rosterIds }) =>
              validateGameComposition(payload.teamA, payload.teamB, rosterIds),
            ),
            // Verify all members have an attending RSVP (yes / coming later) for this event
            Effect.bind('yesRsvpIds', ({ eventRsvps }) =>
              eventRsvps
                .findYesRsvpMemberIdsByEventId(eventId)
                .pipe(
                  Effect.map(
                    (rows) => new Set<TeamMember.TeamMemberId>(rows.map((r) => r.team_member_id)),
                  ),
                ),
            ),
            Effect.tap(({ yesRsvpIds }) => {
              const allIds = [...payload.teamA, ...payload.teamB];
              const notYes = allIds.find((id) => !yesRsvpIds.has(id));
              return notYes !== undefined
                ? Effect.fail(new PlayerRatingApi.InvalidGameResult({ reason: 'notRsvpYes' }))
                : Effect.void;
            }),
            // Determine submittedBy
            Effect.let('submittedBy', ({ gate }) =>
              gate.membership.id === GLOBAL_ADMIN_SENTINEL_ID
                ? Option.none<TeamMember.TeamMemberId>()
                : Option.some(gate.membership.id),
            ),
            // Insert the game (includes Elo rating updates inside the transaction)
            Effect.bind('gameResult', ({ trainingGames, submittedBy }) =>
              trainingGames.insertGame({
                teamId,
                eventId,
                teamAMemberIds: payload.teamA,
                teamBMemberIds: payload.teamB,
                outcome: payload.outcome,
                submittedBy,
              }),
            ),
            // BEST-EFFORT attendance auto-logging (after insertGame tx has committed)
            // insertAutoIgnoreConflict handles the 'training' activity type lookup internally
            Effect.tap(({ event, activityLogs, yesRsvpIds }) =>
              Effect.forEach(
                Array.from(yesRsvpIds),
                (memberId) =>
                  activityLogs.insertAutoIgnoreConflict({
                    team_member_id: memberId,
                    logged_at: new Date(DateTime.toEpochMillis(event.start_at)),
                  }),
                { concurrency: 1, discard: true },
              ).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning('training attendance auto-log failed', cause),
                ),
              ),
            ),
            // Return the game result
            Effect.map(({ gameResult }) => gameResult),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/events/:eventId/training-games
        // ------------------------------------------------------------------
        .handle('getTrainingGames', ({ params: { teamId, eventId } }) =>
          Effect.Do.pipe(
            Effect.tap(() => requirePlayerRatingManageAccess(members, teamId)),
            Effect.bind('trainingGames', () => TrainingGamesRepository.asEffect()),
            Effect.bind('games', ({ trainingGames }) =>
              trainingGames.listGamesByEvent(teamId, eventId),
            ),
            Effect.map(
              ({ games }) => new PlayerRatingApi.LoggedGamesResponse({ games: [...games] }),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // GET /teams/:teamId/members/:memberId/rating/insight
        // ------------------------------------------------------------------
        .handle('getRatingInsight', ({ params: { teamId, memberId } }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requirePlayerRatingManageAccess(members, teamId)),
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('llm', () => LlmClient.asEffect()),
            Effect.bind('row', () => ratings.getMemberRating(teamId, memberId)),
            Effect.bind('history', () =>
              ratings.findHistoryByMember(teamId, memberId, HISTORY_LIMIT),
            ),
            Effect.flatMap(({ gate: { currentUser }, llm, row, history }) => {
              const locale: 'en' | 'cs' = currentUser.locale === 'cs' ? 'cs' : 'en';
              const recentDeltas = history.map((h) => h.delta);
              const ratingData = Option.isNone(row)
                ? {
                    rating: Elo.DEFAULT_RATING,
                    gamesPlayed: 0,
                    wins: 0,
                    losses: 0,
                    draws: 0,
                    isCalibrating: true,
                  }
                : {
                    rating: row.value.rating,
                    gamesPlayed: row.value.games_played,
                    wins: row.value.wins,
                    losses: row.value.losses,
                    draws: row.value.draws,
                    isCalibrating: row.value.games_played < Elo.CALIBRATION_GAMES,
                  };
              return llm.generateRatingInsight({
                ...ratingData,
                calibrationThreshold: Elo.CALIBRATION_GAMES,
                recentDeltas,
                locale,
              });
            }),
            Effect.map(
              ({ insight, generated }) =>
                new PlayerRatingApi.RatingInsightResponse({ insight, generated }),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/members/:memberId/rating/estimate
        // ------------------------------------------------------------------
        .handle('estimateRatingFromDescription', ({ params: { teamId, memberId }, payload }) =>
          Effect.Do.pipe(
            Effect.bind('gate', () => requirePlayerRatingManageAccess(members, teamId)),
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('llm', () => LlmClient.asEffect()),
            Effect.flatMap(({ gate: { currentUser }, llm }) => {
              const locale: 'en' | 'cs' = currentUser.locale === 'cs' ? 'cs' : 'en';
              return llm.estimateRatingFromDescription({
                description: payload.description,
                defaultRating: Elo.DEFAULT_RATING,
                minRating: RATING_MIN,
                maxRating: RATING_MAX,
                locale,
              });
            }),
            Effect.map(
              ({ suggestedRating, rationale, generated }) =>
                new PlayerRatingApi.EstimateRatingResponse({
                  suggestedRating,
                  rationale,
                  minRating: RATING_MIN,
                  maxRating: RATING_MAX,
                  generated,
                }),
            ),
          ),
        )
        // ------------------------------------------------------------------
        // POST /teams/:teamId/members/:memberId/rating/seed
        // ------------------------------------------------------------------
        .handle('applySeedRating', ({ params: { teamId, memberId }, payload }) =>
          Effect.Do.pipe(
            Effect.tap(() => requirePlayerRatingManageAccess(members, teamId)),
            Effect.tap(() =>
              members.findRosterMemberByIds(teamId, memberId).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.fail(new PlayerRatingApi.PlayerNotFound()),
                    onSome: () => Effect.void,
                  }),
                ),
              ),
            ),
            Effect.bind('result', () => {
              const clamped = clampRating(payload.rating, RATING_MIN, RATING_MAX);
              return ratings.seedRating(teamId, memberId, clamped);
            }),
            Effect.flatMap(({ result }) =>
              Option.match(result, {
                onNone: () => Effect.fail(new PlayerRatingApi.SeedNotAllowed()),
                onSome: (row) =>
                  Effect.succeed(
                    new PlayerRatingApi.MemberRatingResponse({
                      memberId: row.team_member_id,
                      rating: row.rating,
                      gamesPlayed: 0,
                      previousRating: Option.none(),
                      lastDelta: Option.none(),
                      wins: 0,
                      losses: 0,
                      draws: 0,
                      isCalibrating: true,
                      calibrationThreshold: Elo.CALIBRATION_GAMES,
                    }),
                  ),
              }),
            ),
          ),
        ),
    ),
  ),
);
