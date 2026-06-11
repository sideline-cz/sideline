import {
  ChannelSyncEvent,
  Discord,
  DiscordChannelMapping,
  GroupModel,
  RosterModel,
  Team,
} from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class PrevRoleRow extends Schema.Class<PrevRoleRow>('PrevRoleRow')({
  old_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

export class GroupMissingRoleRow extends Schema.Class<GroupMissingRoleRow>('GroupMissingRoleRow')({
  group_id: GroupModel.GroupId,
  team_id: Team.TeamId,
  name: Schema.String,
  emoji: Schema.OptionFromNullOr(Schema.String),
  color: Schema.OptionFromNullOr(Schema.String),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class MappingRow extends Schema.Class<MappingRow>('MappingRow')({
  id: DiscordChannelMapping.DiscordChannelMappingId,
  team_id: Team.TeamId,
  entity_type: ChannelSyncEvent.ChannelSyncEntityType,
  group_id: Schema.OptionFromNullOr(GroupModel.GroupId),
  roster_id: Schema.OptionFromNullOr(RosterModel.RosterId),
  discord_channel_id: Schema.OptionFromNullOr(Discord.Snowflake),
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
  claim_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class ClaimThreadRow extends Schema.Class<ClaimThreadRow>('ClaimThreadRow')({
  claim_thread_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const FindByGroupInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
});

const FindByRosterInput = Schema.Struct({
  team_id: Team.TeamId,
  roster_id: RosterModel.RosterId,
});

const InsertGroupInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  discord_channel_id: Discord.Snowflake,
  discord_role_id: Discord.Snowflake,
});

const InsertRoleOnlyInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  discord_role_id: Discord.Snowflake,
});

const UpsertGroupChannelInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  discord_channel_id: Discord.Snowflake,
});

const ClearGroupChannelInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
});

const InsertRosterInput = Schema.Struct({
  team_id: Team.TeamId,
  roster_id: RosterModel.RosterId,
  discord_channel_id: Discord.Snowflake,
  discord_role_id: Discord.Snowflake,
});

const DeleteByGroupInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
});

const DeleteByRosterInput = Schema.Struct({
  team_id: Team.TeamId,
  roster_id: RosterModel.RosterId,
});

const ClaimThreadInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
});

const SaveClaimThreadInput = Schema.Struct({
  team_id: Team.TeamId,
  group_id: GroupModel.GroupId,
  thread_id: Discord.Snowflake,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByGroup = SqlSchema.findOneOption({
    Request: FindByGroupInput,
    Result: MappingRow,
    execute: (input) => sql`
      SELECT id, team_id, entity_type, group_id, roster_id, discord_channel_id, discord_role_id, claim_thread_id
      FROM discord_channel_mappings
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
    `,
  });

  const findByRoster = SqlSchema.findOneOption({
    Request: FindByRosterInput,
    Result: MappingRow,
    execute: (input) => sql`
      SELECT id, team_id, entity_type, group_id, roster_id, discord_channel_id, discord_role_id, claim_thread_id
      FROM discord_channel_mappings
      WHERE team_id = ${input.team_id} AND roster_id = ${input.roster_id}
    `,
  });

  const insertGroupMapping = SqlSchema.findOne({
    Request: InsertGroupInput,
    Result: PrevRoleRow,
    execute: (input) => sql`
      WITH prev AS (
        SELECT discord_role_id AS old_role_id
        FROM discord_channel_mappings
        WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
      )
      INSERT INTO discord_channel_mappings (team_id, entity_type, group_id, discord_channel_id, discord_role_id)
      VALUES (${input.team_id}, 'group', ${input.group_id}, ${input.discord_channel_id}, ${input.discord_role_id})
      ON CONFLICT (team_id, group_id) WHERE group_id IS NOT NULL
      DO UPDATE SET discord_channel_id = ${input.discord_channel_id}, discord_role_id = ${input.discord_role_id}
      RETURNING (SELECT old_role_id FROM prev) AS old_role_id
    `,
  });

  const insertRoleOnlyMapping = SqlSchema.findOne({
    Request: InsertRoleOnlyInput,
    Result: PrevRoleRow,
    execute: (input) => sql`
      WITH prev AS (
        SELECT discord_role_id AS old_role_id
        FROM discord_channel_mappings
        WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
      )
      INSERT INTO discord_channel_mappings (team_id, entity_type, group_id, discord_role_id)
      VALUES (${input.team_id}, 'group', ${input.group_id}, ${input.discord_role_id})
      ON CONFLICT (team_id, group_id) WHERE group_id IS NOT NULL
      DO UPDATE SET discord_role_id = excluded.discord_role_id
      RETURNING (SELECT old_role_id FROM prev) AS old_role_id
    `,
  });

  const upsertGroupChannelMapping = SqlSchema.void({
    Request: UpsertGroupChannelInput,
    execute: (input) => sql`
      INSERT INTO discord_channel_mappings (team_id, entity_type, group_id, discord_channel_id)
      VALUES (${input.team_id}, 'group', ${input.group_id}, ${input.discord_channel_id})
      ON CONFLICT (team_id, group_id) WHERE group_id IS NOT NULL
      DO UPDATE SET discord_channel_id = excluded.discord_channel_id
    `,
  });

  const clearGroupChannelMapping = SqlSchema.void({
    Request: ClearGroupChannelInput,
    execute: (input) => sql`
      UPDATE discord_channel_mappings
      SET discord_channel_id = NULL
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
    `,
  });

  const insertRosterMapping = SqlSchema.void({
    Request: InsertRosterInput,
    execute: (input) => sql`
      INSERT INTO discord_channel_mappings (team_id, entity_type, roster_id, discord_channel_id, discord_role_id)
      VALUES (${input.team_id}, 'roster', ${input.roster_id}, ${input.discord_channel_id}, ${input.discord_role_id})
      ON CONFLICT (team_id, roster_id) WHERE roster_id IS NOT NULL
      DO UPDATE SET discord_channel_id = ${input.discord_channel_id}, discord_role_id = ${input.discord_role_id}
    `,
  });

  const deleteByGroup = SqlSchema.void({
    Request: DeleteByGroupInput,
    execute: (input) => sql`
      DELETE FROM discord_channel_mappings
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
    `,
  });

  const deleteByRoster = SqlSchema.void({
    Request: DeleteByRosterInput,
    execute: (input) => sql`
      DELETE FROM discord_channel_mappings
      WHERE team_id = ${input.team_id} AND roster_id = ${input.roster_id}
    `,
  });

  const _findAllByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: MappingRow,
    execute: (teamId) => sql`
      SELECT id, team_id, entity_type, group_id, roster_id, discord_channel_id, discord_role_id, claim_thread_id
      FROM discord_channel_mappings
      WHERE team_id = ${teamId}
    `,
  });

  const findByGroupId = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
    findByGroup({ team_id: teamId, group_id: groupId }).pipe(catchSqlErrors);

  const insert = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    discordChannelId: Discord.Snowflake,
    discordRoleId: Discord.Snowflake,
  ) =>
    insertGroupMapping({
      team_id: teamId,
      group_id: groupId,
      discord_channel_id: discordChannelId,
      discord_role_id: discordRoleId,
    }).pipe(
      Effect.map((row) => row.old_role_id),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(Option.none<Discord.Snowflake>())),
      catchSqlErrors,
    );

  const insertRoleOnly = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    discordRoleId: Discord.Snowflake,
  ) =>
    insertRoleOnlyMapping({
      team_id: teamId,
      group_id: groupId,
      discord_role_id: discordRoleId,
    }).pipe(
      Effect.map((row) => row.old_role_id),
      Effect.catchTag('NoSuchElementError', () => Effect.succeed(Option.none<Discord.Snowflake>())),
      catchSqlErrors,
    );

  const upsertGroupChannel = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    discordChannelId: Discord.Snowflake,
  ) =>
    upsertGroupChannelMapping({
      team_id: teamId,
      group_id: groupId,
      discord_channel_id: discordChannelId,
    }).pipe(catchSqlErrors);

  const clearGroupChannel = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
    clearGroupChannelMapping({
      team_id: teamId,
      group_id: groupId,
    }).pipe(catchSqlErrors);

  const deleteByGroupId = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
    deleteByGroup({ team_id: teamId, group_id: groupId }).pipe(catchSqlErrors);

  const findByRosterId = (teamId: Team.TeamId, rosterId: RosterModel.RosterId) =>
    findByRoster({ team_id: teamId, roster_id: rosterId }).pipe(catchSqlErrors);

  const insertRoster = (
    teamId: Team.TeamId,
    rosterId: RosterModel.RosterId,
    discordChannelId: Discord.Snowflake,
    discordRoleId: Discord.Snowflake,
  ) =>
    insertRosterMapping({
      team_id: teamId,
      roster_id: rosterId,
      discord_channel_id: discordChannelId,
      discord_role_id: discordRoleId,
    }).pipe(catchSqlErrors);

  const deleteByRosterId = (teamId: Team.TeamId, rosterId: RosterModel.RosterId) =>
    deleteByRoster({ team_id: teamId, roster_id: rosterId }).pipe(catchSqlErrors);

  const findAllByTeam = (teamId: Team.TeamId) => _findAllByTeamId(teamId).pipe(catchSqlErrors);

  const _findClaimThread = SqlSchema.findOneOption({
    Request: ClaimThreadInput,
    Result: ClaimThreadRow,
    execute: (input) => sql`
      SELECT claim_thread_id
      FROM discord_channel_mappings
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
    `,
  });

  const _saveClaimThreadIfAbsent = SqlSchema.findOneOption({
    Request: SaveClaimThreadInput,
    Result: ClaimThreadRow,
    execute: (input) => sql`
      UPDATE discord_channel_mappings
      SET claim_thread_id = ${input.thread_id}
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id} AND claim_thread_id IS NULL
      RETURNING claim_thread_id
    `,
  });

  const _clearClaimThread = SqlSchema.void({
    Request: ClaimThreadInput,
    execute: (input) => sql`
      UPDATE discord_channel_mappings
      SET claim_thread_id = NULL
      WHERE team_id = ${input.team_id} AND group_id = ${input.group_id}
    `,
  });

  const decodeGroupsMissingRole = Schema.decodeUnknownEffect(Schema.Array(GroupMissingRoleRow));

  const findGroupsMissingRole = (teamId: Option.Option<Team.TeamId>, limit: number) =>
    sql`
      SELECT g.id AS group_id, g.team_id, g.name, g.emoji, g.color, m.discord_channel_id
      FROM groups g
      LEFT JOIN discord_channel_mappings m ON m.team_id = g.team_id AND m.group_id = g.id
      WHERE g.is_archived = false
        AND (m.id IS NULL OR m.discord_role_id IS NULL)
        AND NOT EXISTS (
          SELECT 1 FROM channel_sync_events e
          WHERE e.group_id = g.id
            AND e.event_type IN ('channel_created', 'channel_updated')
            AND e.processed_at IS NULL
            AND e.error IS NULL
        )
        ${Option.isSome(teamId) ? sql`AND g.team_id = ${teamId.value}` : sql``}
      ORDER BY g.created_at
      LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeGroupsMissingRole), catchSqlErrors);

  const findClaimThread = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
    _findClaimThread({ team_id: teamId, group_id: groupId }).pipe(
      Effect.map(Option.flatMap((row) => row.claim_thread_id)),
      catchSqlErrors,
    );

  const saveClaimThreadIfAbsent = (
    teamId: Team.TeamId,
    groupId: GroupModel.GroupId,
    threadId: Discord.Snowflake,
  ) =>
    _saveClaimThreadIfAbsent({ team_id: teamId, group_id: groupId, thread_id: threadId }).pipe(
      Effect.flatMap((maybeRow) =>
        Option.isSome(maybeRow)
          ? Effect.succeed(maybeRow.value.claim_thread_id)
          : findClaimThread(teamId, groupId),
      ),
      catchSqlErrors,
    );

  const clearClaimThread = (teamId: Team.TeamId, groupId: GroupModel.GroupId) =>
    _clearClaimThread({ team_id: teamId, group_id: groupId }).pipe(catchSqlErrors);

  return {
    findByGroupId,
    insert,
    insertRoleOnly,
    upsertGroupChannel,
    clearGroupChannel,
    deleteByGroupId,
    findByRosterId,
    insertRoster,
    deleteByRosterId,
    findAllByTeam,
    findGroupsMissingRole,
    findClaimThread,
    saveClaimThreadIfAbsent,
    clearClaimThread,
  };
});

export class DiscordChannelMappingRepository extends ServiceMap.Service<
  DiscordChannelMappingRepository,
  Effect.Success<typeof make>
>()('api/DiscordChannelMappingRepository') {
  static readonly Default = Layer.effect(DiscordChannelMappingRepository, make);
}
