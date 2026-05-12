import { Schema } from 'effect';
import {
  ChannelSyncEvent,
  Discord,
  DiscordChannelMapping,
  GroupModel,
  RosterModel,
  Team,
} from '~/index.js';

export class ChannelMapping extends Schema.Class<ChannelMapping>('ChannelMapping')({
  id: DiscordChannelMapping.DiscordChannelMappingId,
  team_id: Team.TeamId,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  roster_id: Schema.OptionFromNullOr(RosterModel.RosterId),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}
