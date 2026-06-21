import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { EventId } from '~/models/Event.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';
import { TrainingGameId, TrainingGameOutcome } from '~/models/TrainingGame.js';

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('PlayerRatingForbidden', {}) {}

export class PlayerNotFound extends Schema.TaggedErrorClass<PlayerNotFound>()(
  'PlayerRatingPlayerNotFound',
  {},
) {}

export class InvalidGameResult extends Schema.TaggedErrorClass<InvalidGameResult>()(
  'PlayerRatingInvalidGameResult',
  {
    reason: Schema.Literals(['emptyTeam', 'overlap', 'unknownMember', 'notRsvpYes']),
  },
) {}

export class EventNotLoggable extends Schema.TaggedErrorClass<EventNotLoggable>()(
  'PlayerRatingEventNotLoggable',
  {},
) {}

export class MemberRatingResponse extends Schema.Class<MemberRatingResponse>(
  'MemberRatingResponse',
)({
  memberId: TeamMemberId,
  rating: Schema.Int,
  gamesPlayed: Schema.Int,
  previousRating: Schema.OptionFromNullOr(Schema.Int),
  lastDelta: Schema.OptionFromNullOr(Schema.Int),
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
  isCalibrating: Schema.Boolean,
  calibrationThreshold: Schema.Int,
}) {}

export class TeamRatingEntry extends Schema.Class<TeamRatingEntry>('TeamRatingEntry')({
  memberId: TeamMemberId,
  rating: Schema.Int,
  gamesPlayed: Schema.Int,
  previousRating: Schema.OptionFromNullOr(Schema.Int),
  lastDelta: Schema.OptionFromNullOr(Schema.Int),
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
}) {}

export class TeamRatingsResponse extends Schema.Class<TeamRatingsResponse>('TeamRatingsResponse')({
  canManage: Schema.Boolean,
  calibrationThreshold: Schema.Int,
  entries: Schema.Array(TeamRatingEntry),
}) {}

export class RatingHistoryEntry extends Schema.Class<RatingHistoryEntry>('RatingHistoryEntry')({
  id: Schema.String,
  ratingBefore: Schema.Int,
  ratingAfter: Schema.Int,
  delta: Schema.Int,
  result: Schema.Literals(['win', 'loss', 'draw']),
  gameId: Schema.OptionFromNullOr(Schema.String),
  submittedBy: Schema.OptionFromNullOr(TeamMemberId),
  createdAt: Schema.String,
}) {}

export class RatingHistoryResponse extends Schema.Class<RatingHistoryResponse>(
  'RatingHistoryResponse',
)({
  entries: Schema.Array(RatingHistoryEntry),
}) {}

export class RatingInsightResponse extends Schema.Class<RatingInsightResponse>(
  'RatingInsightResponse',
)({
  insight: Schema.String,
  generated: Schema.Boolean,
}) {}

export const EstimateRatingRequest = Schema.Struct({
  description: Schema.String.pipe(Schema.check(Schema.isMaxLength(2000))),
});
export type EstimateRatingRequest = Schema.Schema.Type<typeof EstimateRatingRequest>;

export class EstimateRatingResponse extends Schema.Class<EstimateRatingResponse>(
  'EstimateRatingResponse',
)({
  suggestedRating: Schema.Int,
  rationale: Schema.String,
  minRating: Schema.Int,
  maxRating: Schema.Int,
  generated: Schema.Boolean,
}) {}

export const ApplySeedRatingRequest = Schema.Struct({
  rating: Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 800, maximum: 1800 }))),
});
export type ApplySeedRatingRequest = Schema.Schema.Type<typeof ApplySeedRatingRequest>;

export class SeedNotAllowed extends Schema.TaggedErrorClass<SeedNotAllowed>()(
  'PlayerRatingSeedNotAllowed',
  {},
) {}

export const GameResultRequest = Schema.Struct({
  teamA: Schema.Array(TeamMemberId),
  teamB: Schema.Array(TeamMemberId),
  outcome: Schema.Literals(['teamA', 'teamB', 'draw']),
});
export type GameResultRequest = Schema.Schema.Type<typeof GameResultRequest>;

export const LogTrainingGamePayload = Schema.Struct({
  teamA: Schema.Array(TeamMemberId),
  teamB: Schema.Array(TeamMemberId),
  outcome: TrainingGameOutcome,
});
export type LogTrainingGamePayload = Schema.Schema.Type<typeof LogTrainingGamePayload>;

export class TrainingGameResult extends Schema.Class<TrainingGameResult>('TrainingGameResult')({
  id: TrainingGameId,
  round: Schema.Int,
  teamA: Schema.Array(TeamMemberId),
  teamB: Schema.Array(TeamMemberId),
  outcome: TrainingGameOutcome,
  created_at: Schema.String,
  ratings: TeamRatingsResponse,
}) {}

export class LoggedGameEntry extends Schema.Class<LoggedGameEntry>('LoggedGameEntry')({
  id: TrainingGameId,
  round: Schema.Int,
  teamA: Schema.Array(TeamMemberId),
  teamB: Schema.Array(TeamMemberId),
  outcome: TrainingGameOutcome,
  created_at: Schema.String,
}) {}

export class LoggedGamesResponse extends Schema.Class<LoggedGamesResponse>('LoggedGamesResponse')({
  games: Schema.Array(LoggedGameEntry),
}) {}

export class PlayerRatingApiGroup extends HttpApiGroup.make('playerRating')
  .add(
    HttpApiEndpoint.get('getTeamRatings', '/teams/:teamId/ratings', {
      success: TeamRatingsResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getMemberRating', '/teams/:teamId/members/:memberId/rating', {
      success: MemberRatingResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get(
      'getMemberRatingHistory',
      '/teams/:teamId/members/:memberId/rating/history',
      {
        success: RatingHistoryResponse,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          PlayerNotFound.pipe(HttpApiSchema.status(404)),
        ],
        params: { teamId: TeamId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('applyGameResult', '/teams/:teamId/ratings/games', {
      success: TeamRatingsResponse.pipe(HttpApiSchema.status(200)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        InvalidGameResult.pipe(HttpApiSchema.status(422)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      payload: GameResultRequest,
      params: { teamId: TeamId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('logTrainingGame', '/teams/:teamId/events/:eventId/training-games', {
      success: TrainingGameResult.pipe(HttpApiSchema.status(200)),
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        EventNotLoggable.pipe(HttpApiSchema.status(409)),
        InvalidGameResult.pipe(HttpApiSchema.status(422)),
      ],
      payload: LogTrainingGamePayload,
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getTrainingGames', '/teams/:teamId/events/:eventId/training-games', {
      success: LoggedGamesResponse,
      error: Forbidden.pipe(HttpApiSchema.status(403)),
      params: { teamId: TeamId, eventId: EventId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.get('getRatingInsight', '/teams/:teamId/members/:memberId/rating/insight', {
      success: RatingInsightResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
      ],
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post(
      'estimateRatingFromDescription',
      '/teams/:teamId/members/:memberId/rating/estimate',
      {
        success: EstimateRatingResponse,
        error: [
          Forbidden.pipe(HttpApiSchema.status(403)),
          PlayerNotFound.pipe(HttpApiSchema.status(404)),
        ],
        payload: EstimateRatingRequest,
        params: { teamId: TeamId, memberId: TeamMemberId },
      },
    ).middleware(AuthMiddleware),
  )
  .add(
    HttpApiEndpoint.post('applySeedRating', '/teams/:teamId/members/:memberId/rating/seed', {
      success: MemberRatingResponse,
      error: [
        Forbidden.pipe(HttpApiSchema.status(403)),
        PlayerNotFound.pipe(HttpApiSchema.status(404)),
        SeedNotAllowed.pipe(HttpApiSchema.status(409)),
      ],
      payload: ApplySeedRatingRequest,
      params: { teamId: TeamId, memberId: TeamMemberId },
    }).middleware(AuthMiddleware),
  ) {}
