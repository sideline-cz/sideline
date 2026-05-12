import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import * as Achievement from './Achievement.js';
import * as TeamMember from './TeamMember.js';

export const EarnedAchievementId = Schema.String.pipe(Schema.brand('EarnedAchievementId'));
export type EarnedAchievementId = typeof EarnedAchievementId.Type;

export class EarnedAchievement extends Model.Class<EarnedAchievement>('EarnedAchievement')({
  id: Model.Generated(EarnedAchievementId),
  team_member_id: TeamMember.TeamMemberId,
  achievement_slug: Achievement.AchievementSlug,
  earned_at: Model.DateTimeInsertFromDate,
}) {}
