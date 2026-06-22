import {
  ChannelSyncEvent,
  Discord,
  GroupModel,
  RosterModel,
  Team,
  TeamChannel,
  TeamChannelAccess,
  TeamMember,
} from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: ChannelSyncEvent.ChannelSyncEventType,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(Schema.String),
  group_name: Schema.OptionFromNullOr(Schema.String),
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  discord_user_id: Schema.OptionFromNullOr(Discord.Snowflake),
  roster_id: Schema.OptionFromNullOr(RosterModel.RosterId),
  roster_name: Schema.OptionFromNullOr(Schema.String),
  existing_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  team_channel_id: Schema.OptionFromNullOr(TeamChannel.TeamChannelId),
  access_level: Schema.OptionFromNullOr(TeamChannelAccess.AccessLevel),
});

class GuildLookupResult extends Schema.Class<GuildLookupResult>('GuildLookupResult')({
  guild_id: Discord.Snowflake,
}) {}

export class EventRow extends Schema.Class<EventRow>('EventRow')({
  id: ChannelSyncEvent.ChannelSyncEventId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  event_type: ChannelSyncEvent.ChannelSyncEventType,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  group_name: Schema.OptionFromNullOr(Schema.String),
  team_member_id: Schema.OptionFromNullOr(TeamMember.TeamMemberId),
  discord_user_id: Schema.OptionFromNullOr(Discord.Snowflake),
  roster_id: Schema.OptionFromNullOr(RosterModel.RosterId),
  roster_name: Schema.OptionFromNullOr(Schema.String),
  existing_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  archive_category_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_channel_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_name: Schema.OptionFromNullOr(Schema.String),
  discord_role_color: Schema.OptionFromNullOr(Schema.Number),
  team_channel_id: Schema.OptionFromNullOr(TeamChannel.TeamChannelId),
  access_level: Schema.OptionFromNullOr(TeamChannelAccess.AccessLevel),
}) {}

const MarkProcessedInput = Schema.Struct({
  id: ChannelSyncEvent.ChannelSyncEventId,
});

const MarkFailedInput = Schema.Struct({
  id: ChannelSyncEvent.ChannelSyncEventId,
  error: Schema.String,
});

class ProvisioningGroupId extends Schema.Class<ProvisioningGroupId>('ProvisioningGroupId')({
  group_id: GroupModel.GroupId,
}) {}

class ProvisioningRosterId extends Schema.Class<ProvisioningRosterId>('ProvisioningRosterId')({
  roster_id: RosterModel.RosterId,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const insertEvent = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO channel_sync_events (team_id, guild_id, event_type, entity_type, group_id, group_name, team_member_id, discord_user_id, roster_id, roster_name, existing_channel_id, discord_role_id, archive_category_id, discord_channel_name, discord_role_name, discord_role_color, team_channel_id, access_level)
      VALUES (${input.team_id}, ${input.guild_id}, ${input.event_type}, ${input.entity_type}, ${input.group_id}, ${input.group_name}, ${input.team_member_id}, ${input.discord_user_id}, ${input.roster_id}, ${input.roster_name}, ${input.existing_channel_id}, ${input.discord_role_id}, ${input.archive_category_id}, ${input.discord_channel_name}, ${input.discord_role_name}, ${input.discord_role_color}, ${input.team_channel_id}, ${input.access_level})
    `,
  });

  const lookupGuildId = SqlSchema.findOneOption({
    Request: Schema.String,
    Result: GuildLookupResult,
    execute: (teamId) => sql`SELECT guild_id FROM teams WHERE id = ${teamId}`,
  });

  const findUnprocessedEvents = SqlSchema.findAll({
    Request: Schema.Number,
    Result: EventRow,
    execute: (limit) => sql`
      SELECT id, team_id, guild_id, event_type, entity_type, group_id, group_name, team_member_id, discord_user_id, roster_id, roster_name, existing_channel_id, discord_role_id, archive_category_id, discord_channel_name, discord_role_name, discord_role_color, team_channel_id, access_level
      FROM channel_sync_events
      WHERE processed_at IS NULL
      ORDER BY created_at ASC
      LIMIT ${limit}
    `,
  });

  const findUnprocessedForGroups = SqlSchema.findAll({
    Request: Schema.Array(GroupModel.GroupId),
    Result: ProvisioningGroupId,
    execute: (groupIds) => sql`
      SELECT DISTINCT group_id FROM channel_sync_events
      WHERE entity_type = 'group'
        AND group_id IN ${sql.in(groupIds)}
        AND event_type IN ('channel_created', 'channel_updated', 'channel_deleted', 'channel_archived', 'channel_detached')
        AND processed_at IS NULL AND error IS NULL
    `,
  });

  const findUnprocessedForRosters = SqlSchema.findAll({
    Request: Schema.Array(RosterModel.RosterId),
    Result: ProvisioningRosterId,
    execute: (rosterIds) => sql`
      SELECT DISTINCT roster_id FROM channel_sync_events
      WHERE entity_type = 'roster'
        AND roster_id IN ${sql.in(rosterIds)}
        AND event_type IN ('channel_created', 'channel_updated', 'channel_deleted', 'channel_archived', 'channel_detached')
        AND processed_at IS NULL AND error IS NULL
    `,
  });

  const markEventProcessed = SqlSchema.void({
    Request: MarkProcessedInput,
    execute: (input) => sql`
      UPDATE channel_sync_events SET processed_at = now() WHERE id = ${input.id}
    `,
  });

  const markEventFailed = SqlSchema.void({
    Request: MarkFailedInput,
    execute: (input) => sql`
      UPDATE channel_sync_events SET error = ${input.error} WHERE id = ${input.id}
    `,
  });

  const markEventPermanentlyFailed = SqlSchema.void({
    Request: MarkFailedInput,
    execute: (input) => sql`
      UPDATE channel_sync_events SET processed_at = now(), error = ${input.error} WHERE id = ${input.id}
    `,
  });

  const _emitIfGuildLinked = (
    teamId: Team.TeamId,
    eventType: ChannelSyncEvent.ChannelSyncEventType,
    entityType: ChannelSyncEvent.ChannelSyncEntityType,
    fields: {
      groupId?: Option.Option<GroupModel.GroupId>;
      groupName?: Option.Option<string>;
      teamMemberId?: Option.Option<TeamMember.TeamMemberId>;
      discordUserId?: Option.Option<Discord.Snowflake>;
      rosterId?: Option.Option<RosterModel.RosterId>;
      rosterName?: Option.Option<string>;
      existingChannelId?: Option.Option<Discord.Snowflake>;
      discordRoleId?: Option.Option<Discord.Snowflake>;
      archiveCategoryId?: Option.Option<Discord.Snowflake>;
      discordChannelName?: Option.Option<string>;
      discordRoleName?: Option.Option<string>;
      discordRoleColor?: Option.Option<number>;
      teamChannelId?: Option.Option<TeamChannel.TeamChannelId>;
      accessLevel?: Option.Option<TeamChannelAccess.AccessLevel>;
    } = {},
  ) =>
    lookupGuildId(teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            insertEvent({
              team_id: teamId,
              guild_id,
              event_type: eventType,
              entity_type: entityType,
              group_id: fields.groupId ?? Option.none(),
              group_name: fields.groupName ?? Option.none(),
              team_member_id: fields.teamMemberId ?? Option.none(),
              discord_user_id: fields.discordUserId ?? Option.none(),
              roster_id: fields.rosterId ?? Option.none(),
              roster_name: fields.rosterName ?? Option.none(),
              existing_channel_id: fields.existingChannelId ?? Option.none(),
              discord_role_id: fields.discordRoleId ?? Option.none(),
              archive_category_id: fields.archiveCategoryId ?? Option.none(),
              discord_channel_name: fields.discordChannelName ?? Option.none(),
              discord_role_name: fields.discordRoleName ?? Option.none(),
              discord_role_color: fields.discordRoleColor ?? Option.none(),
              team_channel_id: fields.teamChannelId ?? Option.none(),
              access_level: fields.accessLevel ?? Option.none(),
            }),
        }),
      ),
      catchSqlErrors,
    );

  const emitChannelCreated = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    discordChannelName?: string,
    discordRoleName?: string,
    discordRoleColor?: Option.Option<number>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_created', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      existingChannelId,
      discordChannelName:
        discordChannelName !== undefined ? Option.some(discordChannelName) : Option.none(),
      discordRoleName: discordRoleName !== undefined ? Option.some(discordRoleName) : Option.none(),
      discordRoleColor: discordRoleColor ?? Option.none(),
    });

  const emitChannelDeleted = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_deleted', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      existingChannelId: discordChannelId,
      discordRoleId,
    });

  const emitMemberAdded = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(teamId, 'member_added', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      teamMemberId: Option.some(teamMemberId),
      discordUserId: Option.some(discordUserId),
    });

  type GroupMemberBatchEntry = {
    groupId: GroupModel.GroupId;
    groupName: string;
    teamMemberId: TeamMember.TeamMemberId;
    discordUserId: Discord.Snowflake;
  };

  const _emitGroupMembersBatch = (
    eventType: 'member_added' | 'member_removed',
    input: { teamId: Team.TeamId; entries: ReadonlyArray<GroupMemberBatchEntry> },
  ) => {
    if (input.entries.length === 0) return Effect.void;
    return lookupGuildId(input.teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            sql`
              INSERT INTO channel_sync_events (team_id, guild_id, event_type, entity_type, group_id, group_name, team_member_id, discord_user_id, roster_id, roster_name, existing_channel_id, discord_role_id, archive_category_id, discord_channel_name, discord_role_name, discord_role_color)
              VALUES ${sql.join(
                ',',
                false,
              )(
                input.entries.map(
                  (e) =>
                    sql`(${input.teamId}, ${guild_id}, ${eventType}, ${'group'}, ${e.groupId}, ${e.groupName}, ${e.teamMemberId}, ${e.discordUserId}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null})`,
                ),
              )}
            `.pipe(Effect.asVoid),
        }),
      ),
      catchSqlErrors,
    );
  };

  const emitMembersAddedBatch = (input: {
    teamId: Team.TeamId;
    entries: ReadonlyArray<GroupMemberBatchEntry>;
  }) => _emitGroupMembersBatch('member_added', input);

  const emitMembersRemovedBatch = (input: {
    teamId: Team.TeamId;
    entries: ReadonlyArray<GroupMemberBatchEntry>;
  }) => _emitGroupMembersBatch('member_removed', input);

  const emitRosterMemberAdded = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'member_added', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      teamMemberId: Option.some(teamMemberId),
      discordUserId,
    });

  const emitMemberRemoved = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(teamId, 'member_removed', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      teamMemberId: Option.some(teamMemberId),
      discordUserId: Option.some(discordUserId),
    });

  const emitRosterMemberRemoved = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    teamMemberId: TeamMember.TeamMemberId,
    discordUserId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'member_removed', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      teamMemberId: Option.some(teamMemberId),
      discordUserId,
    });

  const emitRosterChannelCreated = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    existingChannelId: Option.Option<Discord.Snowflake> = Option.none(),
    discordChannelName?: string,
    discordRoleName?: string,
    discordRoleColor?: Option.Option<number>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_created', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      existingChannelId,
      discordChannelName:
        discordChannelName !== undefined ? Option.some(discordChannelName) : Option.none(),
      discordRoleName: discordRoleName !== undefined ? Option.some(discordRoleName) : Option.none(),
      discordRoleColor: discordRoleColor ?? Option.none(),
    });

  const emitRosterChannelDeleted = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_deleted', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      existingChannelId: discordChannelId,
      discordRoleId,
    });

  const emitChannelArchived = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
    archiveCategoryId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_archived', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      existingChannelId: discordChannelId,
      discordRoleId,
      archiveCategoryId: Option.some(archiveCategoryId),
    });

  const emitRosterChannelArchived = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
    archiveCategoryId: Discord.Snowflake,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_archived', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      existingChannelId: discordChannelId,
      discordRoleId,
      archiveCategoryId: Option.some(archiveCategoryId),
    });

  const emitChannelDetached = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    groupName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_detached', 'group', {
      groupId: Option.some(groupId),
      groupName: Option.some(groupName),
      existingChannelId: discordChannelId,
      discordRoleId,
    });

  const emitRosterChannelDetached = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    rosterName: string,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_detached', 'roster', {
      rosterId: Option.some(rosterId),
      rosterName: Option.some(rosterName),
      existingChannelId: discordChannelId,
      discordRoleId,
    });

  const emitGroupChannelUpdated = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
    discordChannelName: string,
    discordRoleName: string,
    discordRoleColor: Option.Option<number>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_updated', 'group', {
      groupId: Option.some(groupId),
      existingChannelId: discordChannelId,
      discordRoleId,
      discordChannelName: Option.some(discordChannelName),
      discordRoleName: Option.some(discordRoleName),
      discordRoleColor,
    });

  const emitRosterChannelUpdated = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    discordChannelId: Option.Option<Discord.Snowflake>,
    discordRoleId: Option.Option<Discord.Snowflake>,
    discordChannelName: string,
    discordRoleName: string,
    discordRoleColor: Option.Option<number>,
  ) =>
    _emitIfGuildLinked(teamId, 'channel_updated', 'roster', {
      rosterId: Option.some(rosterId),
      existingChannelId: discordChannelId,
      discordRoleId,
      discordChannelName: Option.some(discordChannelName),
      discordRoleName: Option.some(discordRoleName),
      discordRoleColor,
    });

  // Managed channel emitters

  const emitManagedChannelCreated = ({
    teamId,
    teamChannelId,
    discordChannelName,
  }: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelName: string;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_created', 'managed', {
      teamChannelId: Option.some(teamChannelId),
      discordChannelName: Option.some(discordChannelName),
    });

  const emitManagedChannelArchived = ({
    teamId,
    teamChannelId,
    discordChannelId,
    archiveCategoryId,
  }: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Option.Option<Discord.Snowflake>;
    archiveCategoryId: Discord.Snowflake;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_archived', 'managed', {
      teamChannelId: Option.some(teamChannelId),
      existingChannelId: discordChannelId,
      archiveCategoryId: Option.some(archiveCategoryId),
    });

  const emitDiscordChannelArchived = ({
    teamId,
    discordChannelId,
    archiveCategoryId,
  }: {
    teamId: Team.TeamId;
    discordChannelId: Discord.Snowflake;
    archiveCategoryId: Discord.Snowflake;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_archived', 'discord', {
      existingChannelId: Option.some(discordChannelId),
      archiveCategoryId: Option.some(archiveCategoryId),
    });

  const emitManagedChannelRestored = ({
    teamId,
    teamChannelId,
    discordChannelId,
  }: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Discord.Snowflake;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_restored', 'managed', {
      teamChannelId: Option.some(teamChannelId),
      existingChannelId: Option.some(discordChannelId),
    });

  const emitDiscordChannelRestored = ({
    teamId,
    discordChannelId,
  }: {
    teamId: Team.TeamId;
    discordChannelId: Discord.Snowflake;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_restored', 'discord', {
      existingChannelId: Option.some(discordChannelId),
    });

  const emitManagedChannelAdopted = ({
    teamId,
    teamChannelId,
    discordChannelId,
  }: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Discord.Snowflake;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_updated', 'managed', {
      teamChannelId: Option.some(teamChannelId),
      existingChannelId: Option.some(discordChannelId),
    });

  // NOTE: no delete endpoint currently emits `managed_channel_deleted` (v1); emitter kept for future.
  const emitManagedChannelDeleted = ({
    teamId,
    teamChannelId,
    discordChannelId,
  }: {
    teamId: Team.TeamId;
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Option.Option<Discord.Snowflake>;
  }) =>
    _emitIfGuildLinked(teamId, 'channel_deleted', 'managed', {
      teamChannelId: Option.some(teamChannelId),
      existingChannelId: discordChannelId,
    });

  type ManagedAccessEntry = {
    teamChannelId: TeamChannel.TeamChannelId;
    discordChannelId: Discord.Snowflake;
    discordRoleId: Discord.Snowflake;
    accessLevel: TeamChannelAccess.AccessLevel;
  };

  type ManagedRevokeEntry = {
    discordChannelId: Discord.Snowflake;
    discordRoleId: Discord.Snowflake;
  };

  const emitManagedAccessGrantedBatch = (input: {
    teamId: Team.TeamId;
    entries: ReadonlyArray<ManagedAccessEntry>;
  }) => {
    if (input.entries.length === 0) return Effect.void;
    return lookupGuildId(input.teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            sql`
              INSERT INTO channel_sync_events (team_id, guild_id, event_type, entity_type, existing_channel_id, discord_role_id, team_channel_id, access_level, group_id, group_name, team_member_id, discord_user_id, roster_id, roster_name, archive_category_id, discord_channel_name, discord_role_name, discord_role_color)
              VALUES ${sql.join(
                ',',
                false,
              )(
                input.entries.map(
                  (e) =>
                    sql`(${input.teamId}, ${guild_id}, ${'member_added'}, ${'managed'}, ${e.discordChannelId}, ${e.discordRoleId}, ${e.teamChannelId}, ${e.accessLevel}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null})`,
                ),
              )}
            `.pipe(Effect.asVoid),
        }),
      ),
      catchSqlErrors,
    );
  };

  const emitManagedAccessRevokedBatch = (input: {
    teamId: Team.TeamId;
    entries: ReadonlyArray<ManagedRevokeEntry>;
  }) => {
    if (input.entries.length === 0) return Effect.void;
    return lookupGuildId(input.teamId).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: ({ guild_id }) =>
            sql`
              INSERT INTO channel_sync_events (team_id, guild_id, event_type, entity_type, existing_channel_id, discord_role_id, team_channel_id, access_level, group_id, group_name, team_member_id, discord_user_id, roster_id, roster_name, archive_category_id, discord_channel_name, discord_role_name, discord_role_color)
              VALUES ${sql.join(
                ',',
                false,
              )(
                input.entries.map(
                  (e) =>
                    sql`(${input.teamId}, ${guild_id}, ${'member_removed'}, ${'managed'}, ${e.discordChannelId}, ${e.discordRoleId}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null}, ${null})`,
                ),
              )}
            `.pipe(Effect.asVoid),
        }),
      ),
      catchSqlErrors,
    );
  };

  const findUnprocessed = (limit: number) => findUnprocessedEvents(limit).pipe(catchSqlErrors);

  const markProcessed = (id: ChannelSyncEvent.ChannelSyncEventId) =>
    markEventProcessed({ id }).pipe(catchSqlErrors);

  const markFailed = (id: ChannelSyncEvent.ChannelSyncEventId, error: string) =>
    markEventFailed({ id, error }).pipe(catchSqlErrors);

  const markPermanentlyFailed = (id: ChannelSyncEvent.ChannelSyncEventId, error: string) =>
    markEventPermanentlyFailed({ id, error }).pipe(catchSqlErrors);

  const hasUnprocessedForGroups = (groupIds: ReadonlyArray<GroupModel.GroupId>) => {
    if (groupIds.length === 0) return Effect.succeed([] as GroupModel.GroupId[]);
    return findUnprocessedForGroups([...groupIds]).pipe(
      Effect.map((rows) => rows.map((r) => r.group_id)),
      catchSqlErrors,
    );
  };

  const hasUnprocessedForRosters = (rosterIds: ReadonlyArray<RosterModel.RosterId>) => {
    if (rosterIds.length === 0) return Effect.succeed([] as RosterModel.RosterId[]);
    return findUnprocessedForRosters([...rosterIds]).pipe(
      Effect.map((rows) => rows.map((r) => r.roster_id)),
      catchSqlErrors,
    );
  };

  return {
    emitChannelCreated,
    emitChannelDeleted,
    emitMemberAdded,
    emitMembersAddedBatch,
    emitMembersRemovedBatch,
    emitRosterMemberAdded,
    emitMemberRemoved,
    emitRosterMemberRemoved,
    emitRosterChannelCreated,
    emitRosterChannelDeleted,
    emitChannelArchived,
    emitRosterChannelArchived,
    emitChannelDetached,
    emitRosterChannelDetached,
    emitGroupChannelUpdated,
    emitRosterChannelUpdated,
    emitManagedChannelCreated,
    emitManagedChannelAdopted,
    emitManagedChannelArchived,
    emitManagedChannelRestored,
    emitDiscordChannelRestored,
    emitManagedChannelDeleted,
    emitDiscordChannelArchived,
    emitManagedAccessGrantedBatch,
    emitManagedAccessRevokedBatch,
    findUnprocessed,
    markProcessed,
    markFailed,
    markPermanentlyFailed,
    hasUnprocessedForGroups,
    hasUnprocessedForRosters,
  };
});

export class ChannelSyncEventsRepository extends ServiceMap.Service<
  ChannelSyncEventsRepository,
  Effect.Success<typeof make>
>()('api/ChannelSyncEventsRepository') {
  static readonly Default = Layer.effect(ChannelSyncEventsRepository, make);
}
