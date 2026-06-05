import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import * as Discord from '~/models/Discord.js';
import * as Event from '~/models/Event.js';
import * as GroupModel from '~/models/GroupModel.js';
import * as Team from '~/models/Team.js';
import * as TeamMember from '~/models/TeamMember.js';

export class EventCreatedEvent extends Schema.TaggedClass<EventCreatedEvent>()('event_created', {
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_id: Event.EventId,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  all_day: Schema.Boolean,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class EventUpdatedEvent extends Schema.TaggedClass<EventUpdatedEvent>()('event_updated', {
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_id: Event.EventId,
  title: Schema.String,
  description: Schema.OptionFromNullOr(Schema.String),
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  all_day: Schema.Boolean,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class EventCancelledEvent extends Schema.TaggedClass<EventCancelledEvent>()(
  'event_cancelled',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
  },
) {}

export class EventStartedEvent extends Schema.TaggedClass<EventStartedEvent>()('event_started', {
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_id: Event.EventId,
  title: Schema.String,
  image_url: Schema.OptionFromNullOr(Schema.String),
  start_at: Schemas.DateTimeFromIsoString,
  end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
  location: Schema.OptionFromNullOr(Schema.String),
  location_url: Schema.OptionFromNullOr(Schema.String),
  event_type: Schema.String,
  all_day: Schema.Boolean,
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class RsvpReminderEvent extends Schema.TaggedClass<RsvpReminderEvent>()('rsvp_reminder', {
  id: Schema.String,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_id: Event.EventId,
  title: Schema.String,
  start_at: Schemas.DateTimeFromIsoString,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class TrainingClaimRequestEvent extends Schema.TaggedClass<TrainingClaimRequestEvent>()(
  'training_claim_request',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    title: Schema.String,
    start_at: Schemas.DateTimeFromIsoString,
    end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
    location: Schema.OptionFromNullOr(Schema.String),
    location_url: Schema.OptionFromNullOr(Schema.String),
    description: Schema.OptionFromNullOr(Schema.String),
    discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export class TrainingClaimUpdateEvent extends Schema.TaggedClass<TrainingClaimUpdateEvent>()(
  'training_claim_update',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    title: Schema.String,
    start_at: Schemas.DateTimeFromIsoString,
    end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
    location: Schema.OptionFromNullOr(Schema.String),
    location_url: Schema.OptionFromNullOr(Schema.String),
    description: Schema.OptionFromNullOr(Schema.String),
    claim_discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claim_discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claimed_by_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
    claimed_by_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claimed_by_name: Schema.OptionFromNullOr(Schema.String),
    claimed_by_nickname: Schema.OptionFromNullOr(Schema.String),
    claimed_by_display_name: Schema.OptionFromNullOr(Schema.String),
    claimed_by_username: Schema.OptionFromNullOr(Schema.String),
    event_status: Schema.String,
  },
) {}

export class UnclaimedTrainingReminderEvent extends Schema.TaggedClass<UnclaimedTrainingReminderEvent>()(
  'unclaimed_training_reminder',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    title: Schema.String,
    start_at: Schemas.DateTimeFromIsoString,
    end_at: Schema.OptionFromNullOr(Schemas.DateTimeFromIsoString),
    location: Schema.OptionFromNullOr(Schema.String),
    location_url: Schema.OptionFromNullOr(Schema.String),
    discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claim_discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claim_discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export const UnprocessedEventSyncEvent = Schema.Union([
  EventCreatedEvent,
  EventUpdatedEvent,
  EventCancelledEvent,
  EventStartedEvent,
  RsvpReminderEvent,
  TrainingClaimRequestEvent,
  TrainingClaimUpdateEvent,
  UnclaimedTrainingReminderEvent,
]);

export type UnprocessedEventSyncEvent = Schema.Schema.Type<typeof UnprocessedEventSyncEvent>;
