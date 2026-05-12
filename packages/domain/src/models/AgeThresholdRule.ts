import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';
import { Gender } from '~/models/User.js';

export const AgeThresholdRuleId = Schema.String.pipe(Schema.brand('AgeThresholdRuleId'));
export type AgeThresholdRuleId = typeof AgeThresholdRuleId.Type;

export class AgeThresholdRule extends Model.Class<AgeThresholdRule>('AgeThresholdRule')({
  id: Model.Generated(AgeThresholdRuleId),
  team_id: TeamId,
  group_id: GroupId,
  min_age: Schema.OptionFromNullOr(Schema.Number),
  max_age: Schema.OptionFromNullOr(Schema.Number),
  gender: Schema.OptionFromNullOr(Gender),
  required_group_id: Schema.OptionFromNullOr(GroupId),
  created_at: Model.DateTimeInsertFromDate,
}) {}
