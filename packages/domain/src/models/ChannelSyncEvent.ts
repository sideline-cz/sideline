import { Schema } from 'effect';
import { Model } from 'effect/unstable/schema';
import { GroupId } from '~/models/GroupModel.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamChannelId } from '~/models/TeamChannel.js';
import { AccessLevel } from '~/models/TeamChannelAccess.js';
import { TeamMemberId } from '~/models/TeamMember.js';

export const ChannelSyncEventId = Schema.String.pipe(Schema.brand('ChannelSyncEventId'));
export type ChannelSyncEventId = typeof ChannelSyncEventId.Type;

export const ChannelSyncEventType = Schema.Literals([
  'channel_created',
  'channel_updated',
  'channel_deleted',
  'channel_archived',
  'channel_restored',
  'channel_detached',
  'member_added',
  'member_removed',
]);

export const ChannelCleanupMode = Schema.Literals(['nothing', 'delete', 'archive']);
export type ChannelCleanupMode = typeof ChannelCleanupMode.Type;
export type ChannelSyncEventType = typeof ChannelSyncEventType.Type;

export const ChannelSyncEntityType = Schema.Literals(['group', 'roster', 'managed', 'discord']);
export type ChannelSyncEntityType = typeof ChannelSyncEntityType.Type;

export class ChannelSyncEvent extends Model.Class<ChannelSyncEvent>('ChannelSyncEvent')({
  id: Model.Generated(ChannelSyncEventId),
  team_id: TeamId,
  guild_id: Schema.String,
  event_type: ChannelSyncEventType,
  entity_type: ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupId),
  group_name: Schema.OptionFromNullOr(Schema.String),
  team_member_id: Schema.OptionFromNullOr(TeamMemberId),
  discord_user_id: Schema.OptionFromNullOr(Schema.String),
  roster_id: Schema.OptionFromNullOr(RosterId),
  roster_name: Schema.OptionFromNullOr(Schema.String),
  existing_channel_id: Schema.OptionFromNullOr(Schema.String),
  discord_role_id: Schema.OptionFromNullOr(Schema.String),
  discord_channel_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  processed_at: Schema.OptionFromNullOr(Schema.String),
  error: Schema.OptionFromNullOr(Schema.String),
  created_at: Model.DateTimeInsertFromDate,
  team_channel_id: Schema.OptionFromNullOr(TeamChannelId),
  access_level: Schema.OptionFromNullOr(AccessLevel),
}) {}
