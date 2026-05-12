import { Schema } from 'effect';
import { ChannelSyncEvent, Discord, GroupModel, RosterModel, Team, TeamMember } from '~/index.js';

// --- channel_created ---

export class GroupChannelCreatedEvent extends Schema.TaggedClass<GroupChannelCreatedEvent>()(
  'group_channel_created',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    group_name: Schema.String,
    existing_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_channel_name: Schema.OptionFromNullOr(Schema.String),
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export class RosterChannelCreatedEvent extends Schema.TaggedClass<RosterChannelCreatedEvent>()(
  'roster_channel_created',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    roster_name: Schema.String,
    existing_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_channel_name: Schema.String,
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export const ChannelCreatedEvent = Schema.Union([
  GroupChannelCreatedEvent,
  RosterChannelCreatedEvent,
]);
export type ChannelCreatedEvent = Schema.Schema.Type<typeof ChannelCreatedEvent>;

// --- channel_updated ---

export class GroupChannelUpdatedEvent extends Schema.TaggedClass<GroupChannelUpdatedEvent>()(
  'group_channel_updated',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_channel_name: Schema.String,
    discord_role_name: Schema.String,
    discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  },
) {}

export class RosterChannelUpdatedEvent extends Schema.TaggedClass<RosterChannelUpdatedEvent>()(
  'roster_channel_updated',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    discord_channel_id: Discord.Snowflake,
    discord_role_id: Discord.Snowflake,
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
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export class RosterChannelDeletedEvent extends Schema.TaggedClass<RosterChannelDeletedEvent>()(
  'roster_channel_deleted',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    discord_channel_id: Discord.Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export const ChannelDeletedEvent = Schema.Union([
  GroupChannelDeletedEvent,
  RosterChannelDeletedEvent,
]);
export type ChannelDeletedEvent = Schema.Schema.Type<typeof ChannelDeletedEvent>;

// --- channel_archived ---

export class GroupChannelArchivedEvent extends Schema.TaggedClass<GroupChannelArchivedEvent>()(
  'group_channel_archived',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
    archive_category_id: Discord.Snowflake,
  },
) {}

export class RosterChannelArchivedEvent extends Schema.TaggedClass<RosterChannelArchivedEvent>()(
  'roster_channel_archived',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    discord_channel_id: Discord.Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
    archive_category_id: Discord.Snowflake,
  },
) {}

export const ChannelArchivedEvent = Schema.Union([
  GroupChannelArchivedEvent,
  RosterChannelArchivedEvent,
]);
export type ChannelArchivedEvent = Schema.Schema.Type<typeof ChannelArchivedEvent>;

// --- channel_detached ---

export class GroupChannelDetachedEvent extends Schema.TaggedClass<GroupChannelDetachedEvent>()(
  'group_channel_detached',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  },
) {}

export class RosterChannelDetachedEvent extends Schema.TaggedClass<RosterChannelDetachedEvent>()(
  'roster_channel_detached',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    discord_channel_id: Discord.Snowflake,
    discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
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
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    group_name: Schema.String,
    team_member_id: TeamMember.TeamMemberId,
    discord_user_id: Discord.Snowflake,
  },
) {}

export class RosterMemberAddedEvent extends Schema.TaggedClass<RosterMemberAddedEvent>()(
  'roster_member_added',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    roster_name: Schema.String,
    team_member_id: TeamMember.TeamMemberId,
    discord_user_id: Discord.Snowflake,
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
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    group_id: GroupModel.GroupId,
    team_member_id: TeamMember.TeamMemberId,
    discord_user_id: Discord.Snowflake,
  },
) {}

export class RosterMemberRemovedEvent extends Schema.TaggedClass<RosterMemberRemovedEvent>()(
  'roster_member_removed',
  {
    id: ChannelSyncEvent.ChannelSyncEventId,
    team_id: Team.TeamId,
    guild_id: Discord.Snowflake,
    roster_id: RosterModel.RosterId,
    team_member_id: TeamMember.TeamMemberId,
    discord_user_id: Discord.Snowflake,
  },
) {}

export const ChannelMemberRemovedEvent = Schema.Union([
  GroupMemberRemovedEvent,
  RosterMemberRemovedEvent,
]);
export type ChannelMemberRemovedEvent = Schema.Schema.Type<typeof ChannelMemberRemovedEvent>;

// --- union of all ---

export const UnprocessedChannelEvent = Schema.Union([
  ChannelCreatedEvent,
  ChannelUpdatedEvent,
  ChannelDeletedEvent,
  GroupChannelArchivedEvent,
  RosterChannelArchivedEvent,
  GroupChannelDetachedEvent,
  RosterChannelDetachedEvent,
  ChannelMemberAddedEvent,
  ChannelMemberRemovedEvent,
]);

export type UnprocessedChannelEvent = Schema.Schema.Type<typeof UnprocessedChannelEvent>;
