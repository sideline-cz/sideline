import { Discord, GroupModel, TeamChannel, TeamChannelAccess } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class AccessRow extends Schema.Class<AccessRow>('AccessRow')({
  team_channel_id: TeamChannel.TeamChannelId,
  group_id: GroupModel.GroupId,
  access_level: TeamChannelAccess.AccessLevel,
}) {}

class CountRow extends Schema.Class<CountRow>('CountRow')({
  count: Schema.Number,
}) {}

class GroupRoleRow extends Schema.Class<GroupRoleRow>('GroupRoleRow')({
  group_id: GroupModel.GroupId,
  discord_role_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

const FindByChannelInput = Schema.Struct({ team_channel_id: TeamChannel.TeamChannelId });

const FindByGroupInput = Schema.Struct({ group_id: GroupModel.GroupId });

const UpsertGrantInput = Schema.Struct({
  team_channel_id: TeamChannel.TeamChannelId,
  group_id: GroupModel.GroupId,
  access_level: TeamChannelAccess.AccessLevel,
});

const DeleteGrantInput = Schema.Struct({
  team_channel_id: TeamChannel.TeamChannelId,
  group_id: GroupModel.GroupId,
});

const CountByChannelInput = Schema.Struct({ team_channel_id: TeamChannel.TeamChannelId });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByChannelQuery = SqlSchema.findAll({
    Request: FindByChannelInput,
    Result: AccessRow,
    execute: (input) => sql`
      SELECT team_channel_id, group_id, access_level
      FROM team_channel_access
      WHERE team_channel_id = ${input.team_channel_id}
      ORDER BY group_id ASC
    `,
  });

  const findByChannelForUpdateQuery = SqlSchema.findAll({
    Request: FindByChannelInput,
    Result: AccessRow,
    execute: (input) => sql`
      SELECT team_channel_id, group_id, access_level
      FROM team_channel_access
      WHERE team_channel_id = ${input.team_channel_id}
      ORDER BY group_id ASC
      FOR UPDATE
    `,
  });

  const upsertGrantQuery = SqlSchema.void({
    Request: UpsertGrantInput,
    execute: (input) => sql`
      INSERT INTO team_channel_access (team_channel_id, group_id, access_level)
      VALUES (${input.team_channel_id}, ${input.group_id}, ${input.access_level})
      ON CONFLICT (team_channel_id, group_id)
      DO UPDATE SET access_level = excluded.access_level
    `,
  });

  const deleteGrantQuery = SqlSchema.void({
    Request: DeleteGrantInput,
    execute: (input) => sql`
      DELETE FROM team_channel_access
      WHERE team_channel_id = ${input.team_channel_id} AND group_id = ${input.group_id}
    `,
  });

  const countByChannelQuery = SqlSchema.findOne({
    Request: CountByChannelInput,
    Result: CountRow,
    execute: (input) => sql`
      SELECT COUNT(*)::int AS count
      FROM team_channel_access
      WHERE team_channel_id = ${input.team_channel_id}
    `,
  });

  const findByGroupQuery = SqlSchema.findAll({
    Request: FindByGroupInput,
    Result: AccessRow,
    execute: (input) => sql`
      SELECT team_channel_id, group_id, access_level
      FROM team_channel_access
      WHERE group_id = ${input.group_id}
    `,
  });

  // Resolve discord_role_id for a list of group_ids via discord_channel_mappings
  const findGroupRoleIdsQuery = SqlSchema.findAll({
    Request: Schema.Array(GroupModel.GroupId),
    Result: GroupRoleRow,
    execute: (groupIds) => sql`
      SELECT group_id, discord_role_id
      FROM discord_channel_mappings
      WHERE entity_type = 'group'
        AND group_id IN ${sql.in(groupIds)}
        AND discord_role_id IS NOT NULL
    `,
  });

  const findByChannel = (channelId: TeamChannel.TeamChannelId) =>
    findByChannelQuery({ team_channel_id: channelId }).pipe(catchSqlErrors);

  const findByChannelForUpdate = (channelId: TeamChannel.TeamChannelId) =>
    findByChannelForUpdateQuery({ team_channel_id: channelId }).pipe(catchSqlErrors);

  const upsertGrant = (
    channelId: TeamChannel.TeamChannelId,
    groupId: GroupModel.GroupId,
    level: TeamChannelAccess.AccessLevel,
  ) =>
    upsertGrantQuery({
      team_channel_id: channelId,
      group_id: groupId,
      access_level: level,
    }).pipe(catchSqlErrors);

  const deleteGrant = (channelId: TeamChannel.TeamChannelId, groupId: GroupModel.GroupId) =>
    deleteGrantQuery({ team_channel_id: channelId, group_id: groupId }).pipe(catchSqlErrors);

  const countByChannel = (channelId: TeamChannel.TeamChannelId) =>
    countByChannelQuery({ team_channel_id: channelId }).pipe(
      Effect.map((r) => r.count),
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage(() => `countByChannel(${channelId}) returned no row`),
      ),
      catchSqlErrors,
    );

  const findGroupRoleIds = (groupIds: ReadonlyArray<GroupModel.GroupId>) => {
    if (groupIds.length === 0) return Effect.succeed<ReadonlyArray<GroupRoleRow>>([]);
    return findGroupRoleIdsQuery([...groupIds]).pipe(catchSqlErrors);
  };

  const findGrantsByGroup = (groupId: GroupModel.GroupId) =>
    findByGroupQuery({ group_id: groupId }).pipe(catchSqlErrors);

  return {
    findByChannel,
    findByChannelForUpdate,
    upsertGrant,
    deleteGrant,
    countByChannel,
    findGroupRoleIds,
    findGrantsByGroup,
  };
});

export class TeamChannelAccessRepository extends ServiceMap.Service<
  TeamChannelAccessRepository,
  Effect.Success<typeof make>
>()('api/TeamChannelAccessRepository') {
  static readonly Default = Layer.effect(TeamChannelAccessRepository, make);
}
