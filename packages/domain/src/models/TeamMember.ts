import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { UserId } from '~/models/User.js';

export const TeamMemberId = Schema.String.pipe(Schema.brand('TeamMemberId'));
export type TeamMemberId = typeof TeamMemberId.Type;

export const JerseyNumber = Schema.Int.pipe(
  Schema.check(Schema.isBetween({ minimum: 0, maximum: 99 })),
);
export type JerseyNumber = typeof JerseyNumber.Type;

export class TeamMember extends Model.Class<TeamMember>('TeamMember')({
  id: Model.Generated(TeamMemberId),
  team_id: TeamId,
  user_id: UserId,
  active: Schema.Boolean,
  jersey_number: Model.FieldExcept(['insert'])(Schema.OptionFromNullOr(Schema.Number)),
  joined_at: Model.DateTimeInsertFromDate,
}) {}
