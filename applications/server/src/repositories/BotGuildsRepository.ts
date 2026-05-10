import { Discord } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

const UpsertInput = Schema.Struct({
  guild_id: Discord.Snowflake,
  guild_name: Schema.String,
  is_community_enabled: Schema.Boolean,
});

class BotGuildRow extends Schema.Class<BotGuildRow>('BotGuildRow')({
  guild_id: Discord.Snowflake,
  guild_name: Schema.String,
}) {}

class BotGuildInfoRow extends Schema.Class<BotGuildInfoRow>('BotGuildInfoRow')({
  guild_id: Discord.Snowflake,
  guild_name: Schema.String,
  is_community_enabled: Schema.Boolean,
}) {}

class ExistsResult extends Schema.Class<ExistsResult>('ExistsResult')({
  exists: Schema.Boolean,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _upsertGuild = SqlSchema.void({
    Request: UpsertInput,
    execute: (input) => sql`
      INSERT INTO bot_guilds (guild_id, guild_name, is_community_enabled)
      VALUES (${input.guild_id}, ${input.guild_name}, ${input.is_community_enabled})
      ON CONFLICT (guild_id) DO UPDATE SET
        guild_name = ${input.guild_name},
        is_community_enabled = ${input.is_community_enabled}
    `,
  });

  const _removeGuild = SqlSchema.void({
    Request: Discord.Snowflake,
    execute: (guildId) => sql`
      DELETE FROM bot_guilds WHERE guild_id = ${guildId}
    `,
  });

  const _existsGuild = SqlSchema.findOne({
    Request: Discord.Snowflake,
    Result: ExistsResult,
    execute: (guildId) => sql`
      SELECT EXISTS(SELECT 1 FROM bot_guilds WHERE guild_id = ${guildId}) AS exists
    `,
  });

  const _findAllGuilds = SqlSchema.findAll({
    Request: Schema.Void,
    Result: BotGuildRow,
    execute: () => sql`SELECT guild_id, guild_name FROM bot_guilds ORDER BY guild_name`,
  });

  const _findByGuildId = SqlSchema.findOneOption({
    Request: Discord.Snowflake,
    Result: BotGuildInfoRow,
    execute: (guildId) => sql`
      SELECT guild_id, guild_name, is_community_enabled
      FROM bot_guilds WHERE guild_id = ${guildId}
    `,
  });

  const upsert = (guildId: Discord.Snowflake, guildName: string, isCommunityEnabled = false) =>
    _upsertGuild({
      guild_id: guildId,
      guild_name: guildName,
      is_community_enabled: isCommunityEnabled,
    }).pipe(catchSqlErrors);

  const remove = (guildId: Discord.Snowflake) => _removeGuild(guildId).pipe(catchSqlErrors);

  const exists = (guildId: Discord.Snowflake) =>
    _existsGuild(guildId).pipe(
      Effect.map((r) => r.exists),
      catchSqlErrors,
      Effect.catchTag(
        'NoSuchElementError',
        LogicError.withMessage((e) => `Guild existence check returned no row: ${e}`),
      ),
    );

  const findAll = () => _findAllGuilds(undefined).pipe(catchSqlErrors);

  const findByGuildId = (guildId: Discord.Snowflake) =>
    _findByGuildId(guildId).pipe(catchSqlErrors);

  const bulkUpdateCommunityFlags = (
    rows: ReadonlyArray<{
      readonly guildId: Discord.Snowflake;
      readonly isCommunityEnabled: boolean;
    }>,
  ) => {
    if (rows.length === 0) return Effect.void;
    return Effect.forEach(
      rows,
      (row) =>
        sql`
          UPDATE bot_guilds
          SET is_community_enabled = ${row.isCommunityEnabled}
          WHERE guild_id = ${row.guildId}
        `.pipe(Effect.asVoid),
      { concurrency: 1 },
    ).pipe(Effect.asVoid, catchSqlErrors);
  };

  return {
    upsert,
    remove,
    exists,
    findAll,
    findByGuildId,
    bulkUpdateCommunityFlags,
  };
});

export class BotGuildsRepository extends ServiceMap.Service<
  BotGuildsRepository,
  Effect.Success<typeof make>
>()('api/BotGuildsRepository') {
  static readonly Default = Layer.effect(BotGuildsRepository, make);
}
