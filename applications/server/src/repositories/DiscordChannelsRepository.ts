import { Discord, Team, TeamChannel } from '@sideline/domain';
import { Array, Effect, Layer, type Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class ChannelRow extends Schema.Class<ChannelRow>('ChannelRow')({
  channel_id: Discord.Snowflake,
  name: Schema.String,
  type: Schema.Number,
  parent_id: Schema.OptionFromNullOr(Discord.Snowflake),
}) {}

class ManagedListRow extends Schema.Class<ManagedListRow>('ManagedListRow')({
  channel_id: Discord.Snowflake,
  name: Schema.String,
  type: Schema.Number,
  parent_id: Schema.OptionFromNullOr(Discord.Snowflake),
  team_channel_id: Schema.OptionFromNullOr(TeamChannel.TeamChannelId),
  team_channel_archived: Schema.OptionFromNullOr(Schema.Boolean),
  team_channel_name: Schema.OptionFromNullOr(Schema.String),
  team_channel_emoji: Schema.OptionFromNullOr(Schema.String),
  access_count: Schema.Number,
}) {}

const SyncInput = Schema.Struct({
  guild_id: Discord.Snowflake,
  channel_id: Discord.Snowflake,
  name: Schema.String,
  type: Schema.Number,
  parent_id: Schema.OptionFromNullOr(Discord.Snowflake),
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const deleteByGuild = SqlSchema.void({
    Request: Discord.Snowflake,
    execute: (guildId) => sql`
      DELETE FROM discord_channels WHERE guild_id = ${guildId}
    `,
  });

  const insertChannel = SqlSchema.void({
    Request: SyncInput,
    execute: (input) => sql`
      INSERT INTO discord_channels (guild_id, channel_id, name, type, parent_id)
      VALUES (${input.guild_id}, ${input.channel_id}, ${input.name}, ${input.type}, ${input.parent_id})
    `,
  });

  const selectByGuild = SqlSchema.findAll({
    Request: Discord.Snowflake,
    Result: ChannelRow,
    execute: (guildId) => sql`
      SELECT channel_id, name, type, parent_id
      FROM discord_channels
      WHERE guild_id = ${guildId}
      ORDER BY name
    `,
  });

  const syncChannels = (
    guildId: Discord.Snowflake,
    channels: ReadonlyArray<{
      readonly channel_id: Discord.Snowflake;
      readonly name: string;
      readonly type: number;
      readonly parent_id: Option.Option<Discord.Snowflake>;
    }>,
  ) =>
    deleteByGuild(guildId).pipe(
      Effect.tap(() =>
        Effect.all(
          Array.map(channels, (ch) =>
            insertChannel({
              guild_id: guildId,
              channel_id: ch.channel_id,
              name: ch.name,
              type: ch.type,
              parent_id: ch.parent_id,
            }),
          ),
          { concurrency: 1 },
        ),
      ),
      catchSqlErrors,
    );

  const _updateChannelName = SqlSchema.void({
    Request: Schema.Struct({ channel_id: Discord.Snowflake, name: Schema.String }),
    execute: (input) => sql`
      UPDATE discord_channels SET name = ${input.name} WHERE channel_id = ${input.channel_id}
    `,
  });

  const _deleteChannel = SqlSchema.void({
    Request: Schema.Struct({ guild_id: Discord.Snowflake, channel_id: Discord.Snowflake }),
    execute: (input) => sql`
      DELETE FROM discord_channels WHERE guild_id = ${input.guild_id} AND channel_id = ${input.channel_id}
    `,
  });

  const _upsertChannel = SqlSchema.void({
    Request: SyncInput,
    execute: (input) => sql`
      INSERT INTO discord_channels (guild_id, channel_id, name, type, parent_id)
      VALUES (${input.guild_id}, ${input.channel_id}, ${input.name}, ${input.type}, ${input.parent_id})
      ON CONFLICT (guild_id, channel_id)
      DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type, parent_id = EXCLUDED.parent_id
    `,
  });

  const updateChannelName = (channelId: Discord.Snowflake, name: string) =>
    _updateChannelName({ channel_id: channelId, name }).pipe(catchSqlErrors);

  const deleteChannel = (guild_id: Discord.Snowflake, channel_id: Discord.Snowflake) =>
    _deleteChannel({ guild_id, channel_id }).pipe(catchSqlErrors);

  const upsertChannel = (
    guildId: Discord.Snowflake,
    channelId: Discord.Snowflake,
    name: string,
    type: number,
    parentId: Option.Option<Discord.Snowflake>,
  ) =>
    _upsertChannel({
      guild_id: guildId,
      channel_id: channelId,
      name,
      type,
      parent_id: parentId,
    }).pipe(catchSqlErrors);

  const findByGuildId = (guildId: Discord.Snowflake) => selectByGuild(guildId).pipe(catchSqlErrors);

  const selectManagedListByTeam = SqlSchema.findAll({
    Request: Team.TeamId,
    Result: ManagedListRow,
    execute: (teamId) => sql`
      SELECT
        dc.channel_id,
        dc.name,
        dc.type,
        dc.parent_id,
        tc.id AS team_channel_id,
        tc.archived AS team_channel_archived,
        tc.name AS team_channel_name,
        tc.emoji AS team_channel_emoji,
        COALESCE(acc.access_count, 0) AS access_count
      FROM teams t
      JOIN discord_channels dc ON dc.guild_id = t.guild_id
      LEFT JOIN team_channels tc
        ON tc.discord_channel_id = dc.channel_id
        AND tc.team_id = ${teamId}
      LEFT JOIN (
        SELECT tca.team_channel_id AS tc_id, COUNT(*)::int AS access_count
        FROM team_channel_access tca
        GROUP BY tca.team_channel_id
      ) acc ON acc.tc_id = tc.id
      WHERE t.id = ${teamId}
      ORDER BY dc.name
    `,
  });

  const selectByChannelId = SqlSchema.findOneOption({
    Request: Schema.Struct({ guild_id: Discord.Snowflake, channel_id: Discord.Snowflake }),
    Result: ChannelRow,
    execute: (input) => sql`
      SELECT channel_id, name, type, parent_id
      FROM discord_channels
      WHERE guild_id = ${input.guild_id}
        AND channel_id = ${input.channel_id}
    `,
  });

  const findManagedListByTeam = (teamId: Team.TeamId) =>
    selectManagedListByTeam(teamId).pipe(catchSqlErrors);

  const findByChannelId = (guildId: Discord.Snowflake, channelId: Discord.Snowflake) =>
    selectByChannelId({ guild_id: guildId, channel_id: channelId }).pipe(catchSqlErrors);

  return {
    syncChannels,
    updateChannelName,
    deleteChannel,
    upsertChannel,
    findByGuildId,
    findManagedListByTeam,
    findByChannelId,
  };
});

export class DiscordChannelsRepository extends ServiceMap.Service<
  DiscordChannelsRepository,
  Effect.Success<typeof make>
>()('api/DiscordChannelsRepository') {
  static readonly Default = Layer.effect(DiscordChannelsRepository, make);
}
