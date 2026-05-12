import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { ChannelSyncEntityType } from '~/models/ChannelSyncEvent.js';
import { GroupId } from '~/models/GroupModel.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamId } from '~/models/Team.js';

export const DiscordChannelMappingId = Schema.String.pipe(Schema.brand('DiscordChannelMappingId'));
export type DiscordChannelMappingId = typeof DiscordChannelMappingId.Type;

export class DiscordChannelMapping extends Model.Class<DiscordChannelMapping>(
  'DiscordChannelMapping',
)({
  id: Model.Generated(DiscordChannelMappingId),
  team_id: TeamId,
  entity_type: ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupId),
  roster_id: Schema.OptionFromNullOr(RosterId),
  discord_channel_id: Schema.OptionFromNullOr(Schema.String),
  discord_role_id: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
}) {}
