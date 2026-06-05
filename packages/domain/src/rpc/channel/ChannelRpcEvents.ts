import { Schema } from 'effect';
import { ChannelSyncEventId } from '~/models/ChannelSyncEvent.js';
import { Snowflake } from '~/models/Discord.js';
import { GroupId } from '~/models/GroupModel.js';
import { RosterId } from '~/models/RosterModel.js';
import { TeamId } from '~/models/Team.js';
import { TeamChannelId } from '~/models/TeamChannel.js';
import { AccessLevel } from '~/models/TeamChannelAccess.js';
import { TeamMemberId } from '~/models/TeamMember.js';

// --- channel_created ---

export class GroupChannelCreatedEvent extends Schema.TaggedClass<GroupChannelCreatedEvent>()(
  'group_channel_created',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    group_name: Schema.String,
    existing_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_channel_name: Schema.OptionFromNullOr(Schema.String),
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export class RosterChannelCreatedEvent extends Schema.TaggedClass<RosterChannelCreatedEvent>()(
  'roster_channel_created',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    roster_name: Schema.String,
    existing_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_channel_name: Schema.String,
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export class ManagedChannelCreatedEvent extends Schema.TaggedClass<ManagedChannelCreatedEvent>()(
  'managed_channel_created',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    team_channel_id: TeamChannelId,
    discord_channel_name: Schema.String,
  },
) {}

export const ChannelCreatedEvent = Schema.Union([
  GroupChannelCreatedEvent,
  RosterChannelCreatedEvent,
  ManagedChannelCreatedEvent,
]);
export type ChannelCreatedEvent = Schema.Schema.Type<typeof ChannelCreatedEvent>;

// --- channel_updated ---

export class GroupChannelUpdatedEvent extends Schema.TaggedClass<GroupChannelUpdatedEvent>()(
  'group_channel_updated',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
    discord_channel_name: Schema.String,
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export class RosterChannelUpdatedEvent extends Schema.TaggedClass<RosterChannelUpdatedEvent>()(
  'roster_channel_updated',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    discord_channel_id: Snowflake,
    discord_role_id: Snowflake,
    discord_channel_name: Schema.String,
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export const ChannelUpdatedEvent = Schema.Union([
  GroupChannelUpdatedEvent,
  RosterChannelUpdatedEvent,
]);
export type ChannelUpdatedEvent = Schema.Schema.Type<typeof ChannelUpdatedEvent>;

// --- channel_deleted ---

export class GroupChannelDeletedEvent extends Schema.TaggedClass<GroupChannelDeletedEvent>()(
  'group_channel_deleted',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
  },
) {}

export class RosterChannelDeletedEvent extends Schema.TaggedClass<RosterChannelDeletedEvent>()(
  'roster_channel_deleted',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    discord_channel_id: Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
  },
) {}

export class ManagedChannelDeletedEvent extends Schema.TaggedClass<ManagedChannelDeletedEvent>()(
  'managed_channel_deleted',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    team_channel_id: TeamChannelId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
  },
) {}

export class ManagedChannelAccessGrantedEvent extends Schema.TaggedClass<ManagedChannelAccessGrantedEvent>()(
  'managed_access_granted',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    team_channel_id: TeamChannelId,
    discord_channel_id: Snowflake,
    discord_role_id: Snowflake,
    access_level: AccessLevel,
  },
) {}

export class ManagedChannelAccessRevokedEvent extends Schema.TaggedClass<ManagedChannelAccessRevokedEvent>()(
  'managed_access_revoked',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    discord_channel_id: Snowflake,
    discord_role_id: Snowflake,
  },
) {}

export const ChannelDeletedEvent = Schema.Union([
  GroupChannelDeletedEvent,
  RosterChannelDeletedEvent,
  ManagedChannelDeletedEvent,
]);
export type ChannelDeletedEvent = Schema.Schema.Type<typeof ChannelDeletedEvent>;

// --- channel_archived ---

export class GroupChannelArchivedEvent extends Schema.TaggedClass<GroupChannelArchivedEvent>()(
  'group_channel_archived',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
    archive_category_id: Snowflake,
  },
) {}

export class RosterChannelArchivedEvent extends Schema.TaggedClass<RosterChannelArchivedEvent>()(
  'roster_channel_archived',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    discord_channel_id: Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
    archive_category_id: Snowflake,
  },
) {}

export class ManagedChannelArchivedEvent extends Schema.TaggedClass<ManagedChannelArchivedEvent>()(
  'managed_channel_archived',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    team_channel_id: TeamChannelId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    archive_category_id: Snowflake,
  },
) {}

export class DiscordChannelArchivedEvent extends Schema.TaggedClass<DiscordChannelArchivedEvent>()(
  'discord_channel_archived',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    archive_category_id: Snowflake,
  },
) {}

export const ChannelArchivedEvent = Schema.Union([
  GroupChannelArchivedEvent,
  RosterChannelArchivedEvent,
  ManagedChannelArchivedEvent,
  DiscordChannelArchivedEvent,
]);
export type ChannelArchivedEvent = Schema.Schema.Type<typeof ChannelArchivedEvent>;

// --- channel_detached ---

export class GroupChannelDetachedEvent extends Schema.TaggedClass<GroupChannelDetachedEvent>()(
  'group_channel_detached',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
  },
) {}

export class RosterChannelDetachedEvent extends Schema.TaggedClass<RosterChannelDetachedEvent>()(
  'roster_channel_detached',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    discord_channel_id: Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Snowflake),
  },
) {}

export const ChannelDetachedEvent = Schema.Union([
  GroupChannelDetachedEvent,
  RosterChannelDetachedEvent,
]);
export type ChannelDetachedEvent = Schema.Schema.Type<typeof ChannelDetachedEvent>;

// --- member_added ---

export class GroupMemberAddedEvent extends Schema.TaggedClass<GroupMemberAddedEvent>()(
  'group_member_added',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    group_name: Schema.String,
    team_member_id: TeamMemberId,
    discord_user_id: Snowflake,
  },
) {}

export class RosterMemberAddedEvent extends Schema.TaggedClass<RosterMemberAddedEvent>()(
  'roster_member_added',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    roster_name: Schema.String,
    team_member_id: TeamMemberId,
    discord_user_id: Snowflake,
  },
) {}

export const ChannelMemberAddedEvent = Schema.Union([
  GroupMemberAddedEvent,
  RosterMemberAddedEvent,
]);
export type ChannelMemberAddedEvent = Schema.Schema.Type<typeof ChannelMemberAddedEvent>;

// --- member_removed ---

export class GroupMemberRemovedEvent extends Schema.TaggedClass<GroupMemberRemovedEvent>()(
  'group_member_removed',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    group_id: GroupId,
    team_member_id: TeamMemberId,
    discord_user_id: Snowflake,
  },
) {}

export class RosterMemberRemovedEvent extends Schema.TaggedClass<RosterMemberRemovedEvent>()(
  'roster_member_removed',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    roster_id: RosterId,
    team_member_id: TeamMemberId,
    discord_user_id: Snowflake,
  },
) {}

export const ChannelMemberRemovedEvent = Schema.Union([
  GroupMemberRemovedEvent,
  RosterMemberRemovedEvent,
]);
export type ChannelMemberRemovedEvent = Schema.Schema.Type<typeof ChannelMemberRemovedEvent>;

export class ManagedChannelAdoptedEvent extends Schema.TaggedClass<ManagedChannelAdoptedEvent>()(
  'managed_channel_adopted',
  {
    id: ChannelSyncEventId,
    team_id: TeamId,
    guild_id: Snowflake,
    team_channel_id: TeamChannelId,
    discord_channel_id: Snowflake,
  },
) {}

// --- union of all ---

export const UnprocessedChannelEvent = Schema.Union([
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelDeletedEvent,
  GroupChannelArchivedEvent,
  RosterChannelArchivedEvent,
  ManagedChannelArchivedEvent,
  DiscordChannelArchivedEvent,
  GroupChannelDetachedEvent,
  RosterChannelDetachedEvent,
  ChannelMemberAddedEvent,
  ChannelMemberRemovedEvent,
  ManagedChannelAccessGrantedEvent,
  ManagedChannelAccessRevokedEvent,
  ManagedChannelAdoptedEvent,
]);

export type UnprocessedChannelEvent = Schema.Schema.Type<typeof UnprocessedChannelEvent>;
