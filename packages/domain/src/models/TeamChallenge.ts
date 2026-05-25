import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { TeamId } from '~/models/Team.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const TeamChallengeId = Schema.String.pipe(Schema.brand('TeamChallengeId'));
export type TeamChallengeId = typeof TeamChallengeId.Type;

export const TeamChallengeKind = Schema.Literals(['throwing', 'sport']);
export type TeamChallengeKind = typeof TeamChallengeKind.Type;

export const TeamChallengeTitle = Schema.NonEmptyString.pipe(Schema.check(Schema.isMaxLength(120)));
export type TeamChallengeTitle = typeof TeamChallengeTitle.Type;

export const TeamChallengeDescription = Schema.String.pipe(Schema.check(Schema.isMaxLength(2000)));
export type TeamChallengeDescription = typeof TeamChallengeDescription.Type;

export class TeamChallenge extends Model.Class<TeamChallenge>('TeamChallenge')({
  id: Model.Generated(TeamChallengeId),
  team_id: TeamId,
  start_date: Schema.Date,
  end_date: Schema.Date,
  kind: TeamChallengeKind,
  title: TeamChallengeTitle,
  description: Schema.OptionFromNullOr(TeamChallengeDescription),
  created_by: TeamMemberId,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}

export class TeamChallengeCompletion extends Model.Class<TeamChallengeCompletion>(
  'TeamChallengeCompletion',
)({
  challenge_id: TeamChallengeId,
  member_id: TeamMemberId,
}) {}

export class TeamChallengeView extends Schema.Class<TeamChallengeView>('TeamChallengeView')({
  challenge: TeamChallenge,
  completedMemberIds: Schema.Array(TeamMemberId),
  isActive: Schema.Boolean,
}) {}
