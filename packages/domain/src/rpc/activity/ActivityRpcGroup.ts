import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { Discord } from '~/index.js';
import {
  ActivityGuildNotFound,
  ActivityMemberNotFound,
  ActivityTypeChoice,
  ActivityTypeNotFound,
  GetLeaderboardResult,
  GetStatsResult,
  InvalidLoggedAtDate,
  LogActivityResult,
} from './ActivityRpcModels.js';

export const ActivityRpcGroup = RpcGroup.make(
  Rpc.make('LogActivity', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      activity_type: Schema.String,
      duration_minutes: Schema.OptionFromNullOr(
        Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 1, maximum: 1440 }))),
      ),
      note: Schema.OptionFromNullOr(Schema.String),
      logged_at_date: Schema.OptionFromNullOr(
        Schema.String.pipe(Schema.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/))),
      ),
    },
    success: LogActivityResult,
    error: Schema.Union([
      ActivityMemberNotFound,
      ActivityGuildNotFound,
      ActivityTypeNotFound,
      InvalidLoggedAtDate,
    ]),
  }),
  Rpc.make('GetStats', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
    },
    success: GetStatsResult,
    error: Schema.Union([ActivityMemberNotFound, ActivityGuildNotFound]),
  }),
  Rpc.make('GetLeaderboard', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      limit: Schema.OptionFromNullOr(Schema.Int.pipe(Schema.check(Schema.isGreaterThan(0)))),
    },
    success: GetLeaderboardResult,
    error: Schema.Union([ActivityMemberNotFound, ActivityGuildNotFound]),
  }),
  Rpc.make('GetActivityTypesByGuild', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.Array(ActivityTypeChoice),
    error: ActivityGuildNotFound,
  }),
).prefix('Activity/');
