import { Schema } from 'effect';
import * as Achievement from '../../models/Achievement.js';
import * as AchievementSyncEvent from '../../models/AchievementSyncEvent.js';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';
import * as TeamMember from '../../models/TeamMember.js';

export class AchievementEarnedEvent extends Schema.TaggedClass<AchievementEarnedEvent>()(
  'achievement_earned',
  {
    id: AchievementSyncEvent.AchievementSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    team_member_id: TeamMember.TeamMemberId,
    achievement_slug: Achievement.AchievementSlug,
    discord_user_id: Discord.Snowflake,
    achievement_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export const UnprocessedAchievementEvent = Schema.Union([AchievementEarnedEvent]);

export type UnprocessedAchievementEvent = Schema.Schema.Type<typeof UnprocessedAchievementEvent>;
