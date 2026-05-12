import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import * as Achievement from './Achievement.js';
import * as Team from './Team.js';
import * as TeamMember from './TeamMember.js';

export const AchievementSyncEventId = Schema.String.pipe(Schema.brand('AchievementSyncEventId'));
export type AchievementSyncEventId = typeof AchievementSyncEventId.Type;

export class AchievementSyncEvent extends Model.Class<AchievementSyncEvent>('AchievementSyncEvent')(
  {
    id: Model.Generated(AchievementSyncEventId),
    team_id: Team.TeamId,
    guild_id: Schema.String,
    team_member_id: TeamMember.TeamMemberId,
    achievement_slug: Achievement.AchievementSlug,
    processed_at: Schema.OptionFromNullOr(Schema.String),
    error: Schema.OptionFromNullOr(Schema.String),
    created_at: Model.DateTimeInsertFromDate,
  },
) {}
