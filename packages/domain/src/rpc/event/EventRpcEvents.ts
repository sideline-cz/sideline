import * as Schemas from '@sideline/effect-lib/Schemas';
import { Schema } from 'effect';
import * as Discord from '~/models/Discord.js';
import * as Event from '~/models/Event.js';
import * as EventRosterModel from '~/models/EventRosterModel.js';
import * as GroupModel from '~/models/GroupModel.js';
import * as RosterModel from '~/models/RosterModel.js';
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
  claimed_by_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
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
    owner_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
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

export class CoachingStatusEvent extends Schema.TaggedClass<CoachingStatusEvent>()(
  'coaching_status',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    title: Schema.String,
    start_at: Schemas.DateTimeFromIsoString,
    discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    claimed_by_display_name: Schema.OptionFromNullOr(Schema.String),
    claimed_by_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
    location: Schema.OptionFromNullOr(Schema.String),
  },
) {}

export class EventRosterApprovalRequestEvent extends Schema.TaggedClass<EventRosterApprovalRequestEvent>()(
  'event_roster_approval_request',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    event_roster_id: EventRosterModel.EventRosterId,
    roster_id: RosterModel.RosterId,
    team_member_id: TeamMember.TeamMemberId,
    candidate_discord_id: Schema.OptionFromNullOr(Discord.Snowflake),
    candidate_display_name: Schema.OptionFromNullOr(Schema.String),
    title: Schema.String,
    start_at: Schemas.DateTimeFromIsoString,
    owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
    owner_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    roster_name: Schema.OptionFromNullOr(Schema.String),
  },
) {}

export class EventRosterApprovalCancelEvent extends Schema.TaggedClass<EventRosterApprovalCancelEvent>()(
  'event_roster_approval_cancel',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_message_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export class EventRosterThreadDeleteEvent extends Schema.TaggedClass<EventRosterThreadDeleteEvent>()(
  'event_roster_thread_delete',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    owners_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export const TeamsGeneratedTeamMember = Schema.Struct({
  display_name: Schema.String,
  rating: Schema.Number,
  is_calibrating: Schema.Boolean,
});
export type TeamsGeneratedTeamMember = Schema.Schema.Type<typeof TeamsGeneratedTeamMember>;

export const TeamsGeneratedTeam = Schema.Struct({
  name: Schema.String,
  avg_rating: Schema.Number,
  members: Schema.Array(TeamsGeneratedTeamMember),
});
export type TeamsGeneratedTeam = Schema.Schema.Type<typeof TeamsGeneratedTeam>;

export class TeamsGeneratedEvent extends Schema.TaggedClass<TeamsGeneratedEvent>()(
  'teams_generated',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    title: Schema.String,
    discord_target_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    teams: Schema.Array(TeamsGeneratedTeam),
  },
) {}

export class EventChannelMovedEvent extends Schema.TaggedClass<EventChannelMovedEvent>()(
  'event_channel_moved',
  {
    id: Schema.String,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    event_id: Event.EventId,
    old_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    new_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
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
  CoachingStatusEvent,
  EventRosterApprovalRequestEvent,
  EventRosterApprovalCancelEvent,
  EventRosterThreadDeleteEvent,
  TeamsGeneratedEvent,
  EventChannelMovedEvent,
]);

export type UnprocessedEventSyncEvent = Schema.Schema.Type<typeof UnprocessedEventSyncEvent>;
