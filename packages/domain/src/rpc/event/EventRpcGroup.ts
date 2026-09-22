import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import * as Event from '~/models/Event.js';
import * as EventRosterModel from '~/models/EventRosterModel.js';
import * as EventRsvp from '~/models/EventRsvp.js';
import * as EventType from '~/models/EventType.js';
import * as GroupModel from '~/models/GroupModel.js';
import * as RosterModel from '~/models/RosterModel.js';
import * as Team from '~/models/Team.js';
import * as TeamMember from '~/models/TeamMember.js';
import * as TrainingType from '~/models/TrainingType.js';
import { UnprocessedEventSyncEvent } from './EventRpcEvents.js';
import {
  ChannelEventEntry,
  ClaimAlreadyClaimed,
  ClaimEventInactive,
  ClaimEventNotFound,
  ClaimNotClaimer,
  ClaimNotOwnerGroupMember,
  ClaimNotTraining,
  ClaimProfileIncomplete,
  CreateEventForbidden,
  CreateEventInvalidDate,
  CreateEventNotMember,
  CreateEventResult,
  DecideRosterRequestResult,
  EventClaimInfo,
  EventDiscordMessage,
  EventEmbedInfo,
  EventRosterAlreadyLinked,
  EventRosterEventNotFound,
  EventTypeChoice,
  GuildEventListEntry,
  GuildEventListResult,
  GuildNotFound,
  MovedEventRow,
  NotOwnerGroupMember,
  RosterNotFoundForLink,
  RosterRequestNotFound,
  RosterRequestNotPending,
  RsvpAttendeeEntry,
  RsvpAttendeesResult,
  RsvpCountsResult,
  RsvpDeadlinePassed,
  RsvpEventNotFound,
  RsvpMemberNotFound,
  RsvpMessageRequired,
  RsvpNotGroupMember,
  RsvpProfileIncomplete,
  RsvpReminderSummary,
  SetAutoApproveResult,
  SubmitRsvpResult,
  TrainingTypeChoice,
  UpcomingEventsForUserResult,
} from './EventRpcModels.js';

export const EventRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedEventSyncEvent),
  }),
  Rpc.make('MarkEventProcessed', {
    payload: { id: Schema.String },
  }),
  Rpc.make('MarkEventFailed', {
    payload: { id: Schema.String, error: Schema.String },
  }),
  Rpc.make('SaveDiscordMessageId', {
    payload: {
      event_id: Event.EventId,
      discord_channel_id: Discord.Snowflake,
      discord_message_id: Discord.Snowflake,
    },
  }),
  Rpc.make('RepointChannelEvents', {
    payload: {
      team_id: Team.TeamId,
      old_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
      new_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    },
    success: Schema.Array(MovedEventRow),
  }),
  Rpc.make('GetDiscordMessageId', {
    payload: { event_id: Event.EventId },
    success: Schema.OptionFromNullOr(EventDiscordMessage),
  }),
  Rpc.make('SubmitRsvp', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
      response: EventRsvp.RsvpResponse,
      message: Schema.OptionFromNullOr(Schema.String),
      clearMessage: Schema.Boolean,
    },
    success: SubmitRsvpResult,
    error: Schema.Union([
      RsvpMemberNotFound,
      RsvpDeadlinePassed,
      RsvpEventNotFound,
      RsvpNotGroupMember,
      RsvpMessageRequired,
      RsvpProfileIncomplete,
    ]),
  }),
  // Lean read for the "edit message" modal prefill: a MODAL response cannot be
  // deferred, so this returns only the member's stored note.
  Rpc.make('GetRsvpMessage', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
    },
    success: Schema.OptionFromNullOr(Schema.String),
  }),
  Rpc.make('GetRsvpCounts', {
    payload: { event_id: Event.EventId },
    success: RsvpCountsResult,
  }),
  Rpc.make('GetEventEmbedInfo', {
    payload: { event_id: Event.EventId },
    success: Schema.OptionFromNullOr(EventEmbedInfo),
  }),
  Rpc.make('GetChannelEvents', {
    payload: { discord_channel_id: Discord.Snowflake },
    success: Schema.Array(ChannelEventEntry),
  }),
  Rpc.make('GetRsvpAttendees', {
    payload: { event_id: Event.EventId, offset: Schema.Number, limit: Schema.Number },
    success: RsvpAttendeesResult,
  }),
  Rpc.make('GetYesAttendeesForEmbed', {
    payload: {
      event_id: Event.EventId,
      limit: Schema.Number,
      member_group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
    },
    success: Schema.Array(RsvpAttendeeEntry),
  }),
  Rpc.make('GetRsvpReminderSummary', {
    payload: { event_id: Event.EventId },
    success: RsvpReminderSummary,
  }),
  Rpc.make('GetUpcomingGuildEvents', {
    payload: {
      guild_id: Discord.Snowflake,
      offset: Schema.Number,
      limit: Schema.Number,
    },
    success: GuildEventListResult,
    error: GuildNotFound,
  }),
  Rpc.make('GetUpcomingEventsForUser', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      offset: Schema.Number,
      limit: Schema.Number,
    },
    success: UpcomingEventsForUserResult,
    error: Schema.Union([GuildNotFound, RsvpMemberNotFound]),
  }),
  Rpc.make('GetTrainingTypesByGuild', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.Array(TrainingTypeChoice),
  }),
  Rpc.make('GetEventTypesByGuild', {
    payload: { guild_id: Discord.Snowflake },
    success: Schema.Array(EventTypeChoice),
  }),
  Rpc.make('CreateEvent', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      // Kept required — the bot ships before the server, so a new bot may still be talking
      // to an old server that has never heard of event_type_id.
      event_type: Event.EventType,
      // Optional and `OptionFromOptionalKey`: an old bot omits the key entirely, and the
      // server must decode that as None, not fail.
      event_type_id: Schema.OptionFromOptionalKey(EventType.EventTypeId),
      title: Schema.String,
      start_at: Schema.String,
      end_at: Schema.OptionFromNullOr(Schema.String),
      location: Schema.OptionFromNullOr(Schema.String),
      location_url: Schema.OptionFromNullOr(Schema.String),
      description: Schema.OptionFromNullOr(Schema.String),
      training_type_id: Schema.OptionFromNullOr(TrainingType.TrainingTypeId),
    },
    success: CreateEventResult,
    error: Schema.Union([CreateEventNotMember, CreateEventForbidden, CreateEventInvalidDate]),
  }),
  Rpc.make('GetChannelDivider', {
    payload: { discord_channel_id: Discord.Snowflake },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('SaveChannelDivider', {
    payload: {
      discord_channel_id: Discord.Snowflake,
      discord_message_id: Discord.Snowflake,
    },
  }),
  Rpc.make('DeleteChannelDivider', {
    payload: { discord_channel_id: Discord.Snowflake },
  }),
  Rpc.make('ClaimTraining', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
    },
    success: EventClaimInfo,
    error: Schema.Union([
      ClaimEventNotFound,
      ClaimNotTraining,
      ClaimEventInactive,
      ClaimNotOwnerGroupMember,
      ClaimAlreadyClaimed,
      ClaimProfileIncomplete,
    ]),
  }),
  Rpc.make('UnclaimTraining', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
    },
    success: EventClaimInfo,
    error: Schema.Union([ClaimEventNotFound, ClaimEventInactive, ClaimNotClaimer]),
  }),
  Rpc.make('SaveClaimDiscordMessageId', {
    payload: {
      event_id: Event.EventId,
      channel_id: Discord.Snowflake,
      message_id: Discord.Snowflake,
    },
    success: Schema.Void,
  }),
  Rpc.make('SaveClaimThreadId', {
    payload: {
      event_id: Event.EventId,
      thread_id: Discord.Snowflake,
    },
    success: Schema.Void,
  }),
  Rpc.make('GetClaimInfo', {
    payload: { event_id: Event.EventId },
    success: Schema.OptionFromNullOr(EventClaimInfo),
  }),
  Rpc.make('GetOwnerClaimThread', {
    payload: {
      team_id: Team.TeamId,
      owner_group_id: GroupModel.GroupId,
    },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('SaveOwnerClaimThread', {
    payload: {
      team_id: Team.TeamId,
      owner_group_id: GroupModel.GroupId,
      thread_id: Discord.Snowflake,
    },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('ClearOwnerClaimThread', {
    payload: {
      team_id: Team.TeamId,
      owner_group_id: GroupModel.GroupId,
    },
    success: Schema.Void,
  }),
  Rpc.make('GetUnpostedUpcomingByChannel', {
    payload: { discord_channel_id: Discord.Snowflake },
    success: Schema.Array(Event.EventId),
  }),
  Rpc.make('GetChannelsWithStoredMessages', {
    success: Schema.Array(
      Schema.Struct({
        discord_channel_id: Discord.Snowflake,
        guild_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('LinkEventRoster', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      roster_id: RosterModel.RosterId,
      auto_approve: Schema.Boolean,
    },
    success: EventRosterModel.EventRoster,
    error: Schema.Union([
      EventRosterAlreadyLinked,
      RosterNotFoundForLink,
      EventRosterEventNotFound,
    ]),
  }),
  Rpc.make('UnlinkEventRoster', {
    payload: { event_id: Event.EventId },
    success: Schema.Void,
  }),
  Rpc.make('GetEventRoster', {
    payload: { event_id: Event.EventId },
    success: Schema.OptionFromNullOr(EventRosterModel.EventRoster),
  }),
  Rpc.make('SetEventRosterAutoApprove', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      auto_approve: Schema.Boolean,
    },
    success: SetAutoApproveResult,
  }),
  Rpc.make('SaveEventRosterThreadIfAbsent', {
    payload: {
      event_id: Event.EventId,
      thread_id: Discord.Snowflake,
    },
    success: Schema.OptionFromNullOr(Discord.Snowflake),
  }),
  Rpc.make('ClearEventRosterThread', {
    payload: { event_id: Event.EventId },
    success: Schema.Void,
  }),
  Rpc.make('SaveApprovalRequestMessageId', {
    payload: {
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      message_id: Discord.Snowflake,
    },
    success: Schema.Void,
  }),
  Rpc.make('ApproveRosterRequest', {
    payload: {
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      decided_by_discord_id: Discord.Snowflake,
    },
    success: DecideRosterRequestResult,
    error: Schema.Union([
      RosterRequestNotFound,
      RosterRequestNotPending,
      NotOwnerGroupMember,
      EventRosterEventNotFound,
    ]),
  }),
  Rpc.make('DeclineRosterRequest', {
    payload: {
      event_id: Event.EventId,
      team_member_id: TeamMember.TeamMemberId,
      decided_by_discord_id: Discord.Snowflake,
    },
    success: DecideRosterRequestResult,
    error: Schema.Union([
      RosterRequestNotFound,
      RosterRequestNotPending,
      NotOwnerGroupMember,
      EventRosterEventNotFound,
    ]),
  }),
  Rpc.make('GetLoggableTrainingEvents', {
    payload: {
      guild_id: Discord.Snowflake,
    },
    success: Schema.Array(GuildEventListEntry),
    error: GuildNotFound,
  }),
).prefix('Event/');
