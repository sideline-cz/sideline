import { Discord } from '@sideline/domain';
import { Array, Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class RoleRow extends Schema.Class<RoleRow>('RoleRow')({
  id: Discord.Snowflake,
  name: Schema.String,
  color: Schema.Number,
  position: Schema.Number,
  managed: Schema.Boolean,
}) {}

const UpsertInput = Schema.Struct({
  guild_id: Discord.Snowflake,
  role_id: Discord.Snowflake,
  name: Schema.String,
  color: Schema.Number,
  position: Schema.Number,
  managed: Schema.Boolean,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const _upsertRole = SqlSchema.void({
    Request: UpsertInput,
    execute: (input) => sql`
      INSERT INTO discord_guild_roles (guild_id, role_id, name, color, position, managed, updated_at)
      VALUES (${input.guild_id}, ${input.role_id}, ${input.name}, ${input.color}, ${input.position}, ${input.managed}, now())
      ON CONFLICT (guild_id, role_id) DO UPDATE SET
        name = EXCLUDED.name,
        color = EXCLUDED.color,
        position = EXCLUDED.position,
        managed = EXCLUDED.managed,
        updated_at = now()
    `,
  });

  const _deleteRole = SqlSchema.void({
    Request: Schema.Struct({ guild_id: Discord.Snowflake, role_id: Discord.Snowflake }),
    execute: (input) => sql`
      DELETE FROM discord_guild_roles
      WHERE guild_id = ${input.guild_id} AND role_id = ${input.role_id}
    `,
  });

  const _deleteByGuild = SqlSchema.void({
    Request: Discord.Snowflake,
    execute: (guildId) => sql`
      DELETE FROM discord_guild_roles WHERE guild_id = ${guildId}
    `,
  });

  const _selectByGuild = SqlSchema.findAll({
    Request: Discord.Snowflake,
    Result: RoleRow,
    execute: (guildId) => sql`
      SELECT role_id AS id, name, color, position, managed
      FROM discord_guild_roles
      WHERE guild_id = ${guildId}
      ORDER BY position DESC
    `,
  });

  const upsert = (input: {
    readonly guild_id: Discord.Snowflake;
    readonly role_id: Discord.Snowflake;
    readonly name: string;
    readonly color: number;
    readonly position: number;
    readonly managed: boolean;
  }) => _upsertRole(input).pipe(catchSqlErrors);

  const deleteRole = (guildId: Discord.Snowflake, roleId: Discord.Snowflake) =>
    _deleteRole({ guild_id: guildId, role_id: roleId }).pipe(catchSqlErrors);

  const syncForGuild = (
    guildId: Discord.Snowflake,
    roles: ReadonlyArray<{
      readonly role_id: Discord.Snowflake;
      readonly name: string;
      readonly color: number;
      readonly position: number;
      readonly managed: boolean;
    }>,
  ) =>
    _deleteByGuild(guildId).pipe(
      Effect.tap(() =>
        Effect.all(
          Array.map(roles, (r) =>
            _upsertRole({
              guild_id: guildId,
              role_id: r.role_id,
              name: r.name,
              color: r.color,
              position: r.position,
              managed: r.managed,
            }),
          ),
          { concurrency: 1 },
        ),
      ),
      catchSqlErrors,
    );

  const listByGuild = (guildId: Discord.Snowflake) => _selectByGuild(guildId).pipe(catchSqlErrors);

  return {
    upsert,
    delete: deleteRole,
    syncForGuild,
    listByGuild,
  };
});

export class DiscordRolesRepository extends ServiceMap.Service<
  DiscordRolesRepository,
  Effect.Success<typeof make>
>()('api/DiscordRolesRepository') {
  static readonly Default = Layer.effect(DiscordRolesRepository, make);
}
