import {
  ChannelRpcModels,
  ChannelSyncEvent,
  Discord,
  DiscordChannelMapping,
  GroupModel,
  RosterModel,
  Team,
  TeamMember,
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

export class RosterMissingRoleRow extends Schema.Class<RosterMissingRoleRow>(
  'RosterMissingRoleRow',
)({
  roster_id: RosterModel.RosterId,
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

class CountRow extends Schema.Class<CountRow>('CountRow')({
  count: Schema.Number,
}) {}

export class RosterRoleReconcileTargetRow extends Schema.Class<RosterRoleReconcileTargetRow>(
  'RosterRoleReconcileTargetRow',
)({
  roster_id: RosterModel.RosterId,
  team_id: Team.TeamId,
  guild_id: Discord.Snowflake,
  discord_role_id: Discord.Snowflake,
}) {}

class ExpectedRoleHolderRow extends Schema.Class<ExpectedRoleHolderRow>('ExpectedRoleHolderRow')({
  team_member_id: TeamMember.TeamMemberId,
  discord_user_id: Discord.Snowflake,
}) {}

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
  const decodeRostersMissingRole = Schema.decodeUnknownEffect(Schema.Array(RosterMissingRoleRow));
  const decodeCountRow = Schema.decodeUnknownEffect(Schema.Array(CountRow));
  const decodeRoleReconcileTargets = Schema.decodeUnknownEffect(
    Schema.Array(RosterRoleReconcileTargetRow),
  );
  const decodeExpectedRoleHolders = Schema.decodeUnknownEffect(Schema.Array(ExpectedRoleHolderRow));

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

  const findActiveRostersWithRole = (teamId: Team.TeamId, limit: number) =>
    sql`
      SELECT r.id AS roster_id, r.team_id, r.name, r.emoji, r.color, m.discord_channel_id
      FROM rosters r
      JOIN discord_channel_mappings m ON m.team_id = r.team_id AND m.roster_id = r.id::text
      WHERE r.team_id = ${teamId}::uuid
        AND r.active = true
        AND m.discord_role_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM channel_sync_events e
          WHERE e.roster_id = r.id::text
            AND e.event_type IN ('channel_created', 'channel_updated')
            AND e.processed_at IS NULL
        )
      ORDER BY r.created_at, r.id
      LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeRostersMissingRole), catchSqlErrors);

  const countActiveRostersWithRole = (teamId: Team.TeamId) =>
    sql`
      SELECT COUNT(*)::int AS count
      FROM rosters r
      JOIN discord_channel_mappings m ON m.team_id = r.team_id AND m.roster_id = r.id::text
      WHERE r.team_id = ${teamId}::uuid
        AND r.active = true
        AND m.discord_role_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM channel_sync_events e
          WHERE e.roster_id = r.id::text
            AND e.event_type IN ('channel_created', 'channel_updated')
            AND e.processed_at IS NULL
        )
    `.pipe(
      Effect.flatMap(decodeCountRow),
      Effect.map((rows) => rows[0]?.count ?? 0),
      catchSqlErrors,
    );

  const findActiveRoleIdsForReconcile = (teamId: Team.TeamId, limit: number) =>
    sql`
      SELECT m.discord_role_id,
             MIN(r.id::text)::uuid AS roster_id,
             r.team_id,
             t.guild_id
      FROM rosters r
      JOIN discord_channel_mappings m ON m.team_id = r.team_id AND m.roster_id = r.id::text
      JOIN teams t ON t.id = r.team_id
      WHERE r.team_id = ${teamId}::uuid
        AND r.active = true
        AND m.discord_role_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM channel_sync_events e
          WHERE e.event_type = 'roster_role_reconcile'
            AND e.processed_at IS NULL
            AND e.discord_role_id = m.discord_role_id
        )
      GROUP BY m.discord_role_id, r.team_id, t.guild_id
      ORDER BY m.discord_role_id
      LIMIT ${limit}
    `.pipe(Effect.flatMap(decodeRoleReconcileTargets), catchSqlErrors);

  const countActiveRoleIdsForReconcile = (teamId: Team.TeamId) =>
    sql`
      SELECT COUNT(DISTINCT m.discord_role_id)::int AS count
      FROM rosters r
      JOIN discord_channel_mappings m ON m.team_id = r.team_id AND m.roster_id = r.id::text
      WHERE r.team_id = ${teamId}::uuid
        AND r.active = true
        AND m.discord_role_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM channel_sync_events e
          WHERE e.event_type = 'roster_role_reconcile'
            AND e.processed_at IS NULL
            AND e.discord_role_id = m.discord_role_id
        )
    `.pipe(
      Effect.flatMap(decodeCountRow),
      Effect.map((rows) => rows[0]?.count ?? 0),
      catchSqlErrors,
    );

  const findExpectedRoleHolders = (teamId: Team.TeamId, discordRoleId: Discord.Snowflake) =>
    sql`
      SELECT DISTINCT tm.id AS team_member_id, u.discord_id AS discord_user_id
      FROM rosters r
      JOIN discord_channel_mappings m ON m.team_id = r.team_id AND m.roster_id = r.id::text
      JOIN roster_members rmb ON rmb.roster_id = r.id
      JOIN team_members tm ON tm.id = rmb.team_member_id
      JOIN users u ON u.id = tm.user_id
      WHERE r.team_id = ${teamId}::uuid
        AND r.active = true
        AND m.discord_role_id = ${discordRoleId}
        AND u.discord_id IS NOT NULL
    `.pipe(
      Effect.flatMap(decodeExpectedRoleHolders),
      Effect.map((rows) =>
        rows.map(
          (row) =>
            new ChannelRpcModels.RosterMemberDiscord({
              team_member_id: row.team_member_id,
              discord_user_id: row.discord_user_id,
            }),
        ),
      ),
      catchSqlErrors,
    );

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
    findActiveRostersWithRole,
    countActiveRostersWithRole,
    findActiveRoleIdsForReconcile,
    countActiveRoleIdsForReconcile,
    findExpectedRoleHolders,
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
