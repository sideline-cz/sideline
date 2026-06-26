import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { ChannelCleanupMode } from '~/models/ChannelSyncEvent.js';
import { Snowflake } from '~/models/Discord.js';
import { TeamId } from '~/models/Team.js';

export class TeamSettings extends Model.Class<TeamSettings>('TeamSettings')({
  team_id: TeamId,
  event_horizon_days: Schema.Int,
  min_players_threshold: Schema.Int,
  rsvp_reminders_enabled: Schema.Boolean,
  rsvp_reminder_days_before: Schema.Int,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Snowflake),
  timezone: Schema.String,
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Snowflake),
  discord_roster_category_id: Schema.OptionFromNullOr(Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
