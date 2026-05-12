import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Achievement from '../../models/Achievement.js';
import * as AchievementSyncEvent from '../../models/AchievementSyncEvent.js';
import * as Discord from '../../models/Discord.js';
import * as Team from '../../models/Team.js';
import { UnprocessedAchievementEvent } from './AchievementRpcEvents.js';

export const AchievementRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedAchievementEvent),
  }),
  Rpc.make('MarkEventProcessed', {
    payload: { id: AchievementSyncEvent.AchievementSyncEventId },
  }),
  Rpc.make('MarkEventFailed', {
    payload: { id: AchievementSyncEvent.AchievementSyncEventId, error: Schema.String },
  }),
  Rpc.make('GetRoleMapping', {
    payload: { team_id: Team.TeamId, achievement_slug: Achievement.AchievementSlug },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('UpsertRoleMapping', {
    payload: {
      team_id: Team.TeamId,
      achievement_slug: Achievement.AchievementSlug,
      discord_role_id: Discord.Snowflake,
    },
  }),
).prefix('Achievement/');
