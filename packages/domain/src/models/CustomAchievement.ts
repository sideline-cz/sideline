import { Schema } from 'effect';
import { TeamId } from '~/models/Team.js';

export const CustomAchievementId = Schema.String.pipe(Schema.brand('CustomAchievementId'));
export type CustomAchievementId = typeof CustomAchievementId.Type;

export const CustomRuleKind = Schema.Literals([
  'total_activities',
  'longest_streak',
  'total_duration',
  'activity_type_count',
]);
export type CustomRuleKind = typeof CustomRuleKind.Type;

export class CustomAchievement extends Schema.Class<CustomAchievement>('CustomAchievement')({
  id: CustomAchievementId,
  teamId: TeamId,
  name: Schema.String,
  description: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  ruleKind: CustomRuleKind,
  threshold: Schema.Number,
  activityTypeSlug: Schema.OptionFromNullOr(Schema.String),
  discordRoleId: Schema.OptionFromNullOr(Schema.String),
}) {}
