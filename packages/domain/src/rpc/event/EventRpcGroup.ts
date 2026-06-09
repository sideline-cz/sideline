import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import * as Discord from '~/models/Discord.js';
import * as Event from '~/models/Event.js';
import * as EventRsvp from '~/models/EventRsvp.js';
import * as GroupModel from '~/models/GroupModel.js';
import * as Team from '~/models/Team.js';
import * as TrainingType from '~/models/TrainingType.js';
import { UnprocessedEventSyncEvent } from './EventRpcEvents.js';
import {
  AttendanceOverview,
  ChannelEventEntry,
  ClaimAlreadyClaimed,
  ClaimEventInactive,
  ClaimEventNotFound,
  ClaimNotClaimer,
  ClaimNotOwnerGroupMember,
  ClaimNotTraining,
  CreateEventForbidden,
  CreateEventInvalidDate,
  CreateEventNotMember,
  CreateEventResult,
  DecideJoinRequestResult,
  EventClaimInfo,
  EventDiscordMessage,
  EventEmbedInfo,
  GuildEventListResult,
  GuildNotFound,
  JoinRequestAlreadyDecided,
  JoinRequestEventInactive,
  JoinRequestEventNotFound,
  JoinRequestForbidden,
  JoinRequestId,
  JoinRequestNotMember,
  JoinRequestNotTournament,
  RsvpAttendeeEntry,
  RsvpAttendeesResult,
  RsvpCountsResult,
  RsvpDeadlinePassed,
  RsvpEventNotFound,
  RsvpMemberNotFound,
  RsvpNotGroupMember,
  RsvpReminderSummary,
  SubmitJoinRequestResult,
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
    ]),
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
  Rpc.make('CreateEvent', {
    payload: {
      guild_id: Discord.Snowflake,
      discord_user_id: Discord.Snowflake,
      event_type: Event.EventType,
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
  Rpc.make('GetChannelsWithStoredMessages', {
    success: Schema.Array(
      Schema.Struct({
        discord_channel_id: Discord.Snowflake,
        guild_id: Discord.Snowflake,
      }),
    ),
  }),
  Rpc.make('SubmitJoinRequest', {
    payload: {
      event_id: Event.EventId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
      message: Schema.OptionFromNullOr(Schema.String),
    },
    success: SubmitJoinRequestResult,
    error: Schema.Union([
      JoinRequestEventNotFound,
      JoinRequestNotTournament,
      JoinRequestEventInactive,
      JoinRequestNotMember,
    ]),
  }),
  Rpc.make('AcceptJoinRequest', {
    payload: {
      request_id: JoinRequestId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
    },
    success: DecideJoinRequestResult,
    error: Schema.Union([JoinRequestForbidden, JoinRequestNotMember, JoinRequestAlreadyDecided]),
  }),
  Rpc.make('DeclineJoinRequest', {
    payload: {
      request_id: JoinRequestId,
      team_id: Team.TeamId,
      discord_user_id: Discord.Snowflake,
    },
    success: DecideJoinRequestResult,
    error: Schema.Union([JoinRequestForbidden, JoinRequestNotMember, JoinRequestAlreadyDecided]),
  }),
  Rpc.make('GetAttendanceOverview', {
    payload: { event_id: Event.EventId },
    success: AttendanceOverview,
  }),
  Rpc.make('SaveJoinRequestMessageId', {
    payload: {
      request_id: JoinRequestId,
      channel_id: Discord.Snowflake,
      message_id: Discord.Snowflake,
    },
    success: Schema.Void,
  }),
).prefix('Event/');
