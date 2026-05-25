import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const WeeklyChallengeId = Schema.String.pipe(Schema.brand('WeeklyChallengeId'));
export type WeeklyChallengeId = typeof WeeklyChallengeId.Type;

export const WeeklyChallengeKind = Schema.Literals(['throwing', 'sport']);
export type WeeklyChallengeKind = typeof WeeklyChallengeKind.Type;

export const WeeklyChallengeTitle = Schema.NonEmptyString.pipe(
  Schema.check(Schema.isMaxLength(120)),
);
export type WeeklyChallengeTitle = typeof WeeklyChallengeTitle.Type;

export const WeeklyChallengeDescription = Schema.String.pipe(
  Schema.check(Schema.isMaxLength(2000)),
);
export type WeeklyChallengeDescription = typeof WeeklyChallengeDescription.Type;

export class WeeklyChallenge extends Model.Class<WeeklyChallenge>('WeeklyChallenge')({
  id: Model.Generated(WeeklyChallengeId),
  team_id: TeamId,
  week_start_date: Schema.Date,
  kind: WeeklyChallengeKind,
  title: WeeklyChallengeTitle,
  description: Schema.OptionFromNullOr(WeeklyChallengeDescription),
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class WeeklyChallengeCompletion extends Model.Class<WeeklyChallengeCompletion>(
  'WeeklyChallengeCompletion',
)({
  challenge_id: WeeklyChallengeId,
  member_id: TeamMemberId,
}) {}

export class WeeklyChallengeView extends Schema.Class<WeeklyChallengeView>('WeeklyChallengeView')({
  challenge: WeeklyChallenge,
  completedMemberIds: Schema.Array(TeamMemberId),
  isActive: Schema.Boolean,
}) {}
