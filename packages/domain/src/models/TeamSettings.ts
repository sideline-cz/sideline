import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { ChannelCleanupMode } from '~/models/ChannelSyncEvent.js';
import { Snowflake } from '~/models/Discord.js';
import { EventType } from '~/models/Event.js';
import { GroupId } from '~/models/GroupModel.js';
import { TeamId } from '~/models/Team.js';

// Per-event-type overrides for the RSVP reminder lead time. PARTIAL on purpose: an event type
// absent from the map falls back to `rsvp_reminder_days_before`, so `{}` (the column default)
// reproduces the old single-value behaviour exactly.
//
// `Schema.Record` with a literal key DROPS unrecognised keys on decode rather than failing, which
// is what we want on this field: a web bundle that learns a new event type before the server does
// must not make the whole settings payload undecodable.
export const RsvpReminderDaysBeforeOverrides = Schema.Record(
  EventType,
  Schema.optionalKey(Schema.Int.pipe(Schema.check(Schema.isBetween({ minimum: 0, maximum: 14 })))),
);
export type RsvpReminderDaysBeforeOverrides = typeof RsvpReminderDaysBeforeOverrides.Type;

export class TeamSettings extends Model.Class<TeamSettings>('TeamSettings')({
  team_id: TeamId,
  event_horizon_days: Schema.Int,
  min_players_threshold: Schema.Int,
  rsvp_reminders_enabled: Schema.Boolean,
  require_complete_profile: Schema.Boolean,
  rsvp_reminder_days_before: Schema.Int,
  rsvp_reminder_days_before_overrides: RsvpReminderDaysBeforeOverrides,
  max_missed_rsvps: Schema.Int,
  rsvp_reminder_time: Schema.String,
  reminders_channel_id: Schema.OptionFromNullOr(Snowflake),
  timezone: Schema.String,
  create_discord_channel_on_group: Schema.Boolean,
  create_discord_channel_on_roster: Schema.Boolean,
  discord_archive_category_id: Schema.OptionFromNullOr(Snowflake),
  discord_roster_category_id: Schema.OptionFromNullOr(Snowflake),
  discord_personal_events_category_id: Schema.OptionFromNullOr(Snowflake),
  discord_personal_events_group_id: Schema.OptionFromNullOr(GroupId),
  discord_personal_events_channel_format: Schema.String,
  discord_events_channel_id: Schema.OptionFromNullOr(Snowflake),
  discord_channel_cleanup_on_group_delete: ChannelCleanupMode,
  discord_channel_cleanup_on_roster_deactivate: ChannelCleanupMode,
  discord_role_format: Schema.String,
  discord_channel_format: Schema.String,
  created_at: Model.DateTimeInsertFromDate,
  updated_at: Model.DateTimeUpdateFromDate,
}) {}
