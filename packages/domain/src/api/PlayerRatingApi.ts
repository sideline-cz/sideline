import { Schema } from 'effect';
import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema } from 'effect/unstable/httpapi';
import { AuthMiddleware } from '~/api/Auth.js';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export class Forbidden extends Schema.TaggedErrorClass<Forbidden>()('PlayerRatingForbidden', {}) {}

export class PlayerNotFound extends Schema.TaggedErrorClass<PlayerNotFound>()(
  'PlayerRatingPlayerNotFound',
  {},
) {}

export class InvalidGameResult extends Schema.TaggedErrorClass<InvalidGameResult>()(
  'PlayerRatingInvalidGameResult',
  {
    reason: Schema.Literals(['emptyTeam', 'overlap', 'unknownMember']),
  },
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

export const GameResultRequest = Schema.Struct({
  teamA: Schema.Array(TeamMemberId),
  teamB: Schema.Array(TeamMemberId),
  outcome: Schema.Literals(['teamA', 'teamB', 'draw']),
});
export type GameResultRequest = Schema.Schema.Type<typeof GameResultRequest>;

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
  ) {}
