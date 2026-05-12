import { Schema } from 'effect';
import { Rpc, RpcGroup } from 'effect/unstable/rpc';
import { ChannelSyncEvent, Discord, GroupModel, RosterModel, Team } from '~/index.js';
import { UnprocessedChannelEvent } from './ChannelRpcEvents.js';
import { ChannelMapping } from './ChannelRpcModels.js';

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
).prefix('Channel/');
