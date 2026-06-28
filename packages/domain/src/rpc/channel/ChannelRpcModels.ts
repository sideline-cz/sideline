import { Schema } from 'effect';
import {
  ChannelSyncEvent,
  Discord,
  DiscordChannelMapping,
  GroupModel,
  RosterModel,
  Team,
  TeamMember,
} from '~/index.js';
import { TeamChannelId } from '~/models/TeamChannel.js';

export class ChannelMapping extends Schema.Class<ChannelMapping>('ChannelMapping')({
  id: DiscordChannelMapping.DiscordChannelMappingId,
  team_id: Team.TeamId,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  roster_id: Schema.OptionFromNullOr(RosterModel.RosterId),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class RosterMemberDiscord extends Schema.Class<RosterMemberDiscord>('RosterMemberDiscord')({
  team_member_id: TeamMember.TeamMemberId,
  discord_user_id: Discord.Snowflake,
}) {}

export class GroupMemberDiscord extends Schema.Class<GroupMemberDiscord>('GroupMemberDiscord')({
  team_member_id: TeamMember.TeamMemberId,
  discord_user_id: Discord.Snowflake,
}) {}

// Managed channels never carry a per-channel role: access is enforced via Discord permission
// overwrites whose role ids are resolved per-group at emit time (see api/channel.ts setAccess and
// rpc/channel UpsertManagedChannel reconcile). No managed flow writes or reads team_channels.discord_role_id.
export class ManagedChannelMapping extends Schema.Class<ManagedChannelMapping>(
  'ManagedChannelMapping',
)({
  team_channel_id: TeamChannelId,
  team_id: Team.TeamId,
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}
