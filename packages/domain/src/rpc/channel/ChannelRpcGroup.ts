import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { ChannelSyncEvent, Discord, GroupModel, RosterModel, Team } from '~/index.js';
import { TeamChannelId } from '~/models/TeamChannel.js';
import { UnprocessedChannelEvent } from './ChannelRpcEvents.js';
import {
  ChannelMapping,
  GroupMemberDiscord,
  ManagedChannelMapping,
  RosterMemberDiscord,
} from './ChannelRpcModels.js';

export const ChannelRpcGroup = RpcGroup.make(
  Rpc.make('GetUnprocessedEvents', {
    payload: { limit: Schema.Number },
    success: Schema.Array(UnprocessedChannelEvent),
  }),
  Rpc.make('MarkEventProcessed', {
    payload: { id: ChannelSyncEvent.ChannelSyncEventId },
  }),
  Rpc.make('MarkEventFailed', {
    payload: { id: ChannelSyncEvent.ChannelSyncEventId, error: Schema.String },
  }),
  Rpc.make('MarkEventPermanentlyFailed', {
    payload: { id: ChannelSyncEvent.ChannelSyncEventId, error: Schema.String },
  }),
  // Group mappings
  Rpc.make('GetMapping', {
    payload: { team_id: Team.TeamId, group_id: GroupModel.GroupId },
    success: Schema.OptionFromNullOr(ChannelMapping),
  }),
  Rpc.make('UpsertMapping', {
    payload: {
      team_id: Team.TeamId,
      group_id: GroupModel.GroupId,
      discord_channel_id: Discord.Snowflake,
      discord_role_id: Discord.Snowflake,
    },
  }),
  Rpc.make('UpsertMappingRoleOnly', {
    payload: {
      team_id: Team.TeamId,
      group_id: GroupModel.GroupId,
      discord_role_id: Discord.Snowflake,
    },
  }),
  Rpc.make('UpsertGroupChannel', {
    payload: {
      team_id: Team.TeamId,
      group_id: GroupModel.GroupId,
      discord_channel_id: Discord.Snowflake,
    },
  }),
  Rpc.make('DeleteMapping', {
    payload: { team_id: Team.TeamId, group_id: GroupModel.GroupId },
  }),
  // Roster mappings
  Rpc.make('GetRosterMapping', {
    payload: { team_id: Team.TeamId, roster_id: RosterModel.RosterId },
    success: Schema.OptionFromNullOr(ChannelMapping),
  }),
  Rpc.make('GetRosterMembers', {
    payload: { team_id: Team.TeamId, roster_id: RosterModel.RosterId },
    success: Schema.Array(RosterMemberDiscord),
  }),
  Rpc.make('GetGroupMembers', {
    payload: { team_id: Team.TeamId, group_id: GroupModel.GroupId },
    success: Schema.Array(GroupMemberDiscord),
  }),
  Rpc.make('UpsertRosterMapping', {
    payload: {
      team_id: Team.TeamId,
      roster_id: RosterModel.RosterId,
      discord_channel_id: Discord.Snowflake,
      discord_role_id: Discord.Snowflake,
    },
  }),
  Rpc.make('DeleteRosterMapping', {
    payload: { team_id: Team.TeamId, roster_id: RosterModel.RosterId },
  }),
  // Roster channel update
  Rpc.make('UpdateRosterChannel', {
    payload: {
      roster_id: RosterModel.RosterId,
      discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    },
  }),
  // Managed channel mappings
  Rpc.make('GetManagedChannel', {
    payload: { team_channel_id: TeamChannelId },
    success: Schema.OptionFromNullOr(ManagedChannelMapping),
  }),
  Rpc.make('UpsertManagedChannel', {
    payload: {
      team_channel_id: TeamChannelId,
      discord_channel_id: Discord.Snowflake,
    },
  }),
  Rpc.make('ClearManagedChannel', {
    payload: { team_channel_id: TeamChannelId },
  }),
  Rpc.make('DeleteManagedChannel', {
    payload: { team_channel_id: TeamChannelId },
  }),
  // Backfill
  Rpc.make('BackfillMissingGroupRoles', {
    payload: {
      team_id: Schema.OptionFromNullOr(Team.TeamId),
      limit: Schema.OptionFromNullOr(Schema.Number),
    },
    success: Schema.Number,
  }),
).prefix('Channel/');
