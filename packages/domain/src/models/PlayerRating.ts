import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const PlayerRatingId = Schema.String.pipe(Schema.brand('PlayerRatingId'));
export type PlayerRatingId = typeof PlayerRatingId.Type;

export class PlayerRating extends Model.Class<PlayerRating>('PlayerRating')({
  id: Model.Generated(PlayerRatingId),
  team_id: TeamId,
  team_member_id: TeamMemberId,
  rating: Schema.Int,
  games_played: Schema.Int,
  wins: Schema.Int,
  losses: Schema.Int,
  draws: Schema.Int,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export const PlayerRatingHistoryId = Schema.String.pipe(Schema.brand('PlayerRatingHistoryId'));
export type PlayerRatingHistoryId = typeof PlayerRatingHistoryId.Type;

export class PlayerRatingHistoryEntry extends Model.Class<PlayerRatingHistoryEntry>(
  'PlayerRatingHistoryEntry',
)({
  id: Model.Generated(PlayerRatingHistoryId),
  team_id: TeamId,
  team_member_id: TeamMemberId,
  rating_before: Schema.Int,
  rating_after: Schema.Int,
  delta: Schema.Int,
  result: Schema.Literals(['win', 'loss', 'draw']),
  game_id: Schema.OptionFromNullOr(Schema.String),
  submitted_by: Schema.OptionFromNullOr(TeamMemberId),
  created_at: Model.DateTimeInsertFromDate,
}) {}
