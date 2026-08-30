import { Discord, DiscordRoleMapping, Role, RoleRpcModels, Team } from '@sideline/domain';
import { SqlErrors } from '@sideline/effect-lib';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class MappingRow extends Schema.Class<MappingRow>('MappingRow')({
  id: DiscordRoleMapping.DiscordRoleMappingId,
  team_id: Team.TeamId,
  role_id: Role.RoleId,
  discord_role_id: Discord.Snowflake,
  adopted: Schema.Boolean,
}) {}

const FindByRoleInput = Schema.Struct({
  team_id: Team.TeamId,
  role_id: Role.RoleId,
});

const InsertInput = Schema.Struct({
  team_id: Team.TeamId,
  role_id: Role.RoleId,
  discord_role_id: Discord.Snowflake,
  adopted: Schema.Boolean,
});

const DeleteByRoleInput = Schema.Struct({
  team_id: Team.TeamId,
  role_id: Role.RoleId,
});

// Default Postgres name for the inline `UNIQUE(team_id, discord_role_id)` constraint on
// `discord_role_mappings` (`packages/migrations/src/before/1740970000_create_role_sync.ts`).
// Reachable via a Sideline role rename (no `role_renamed` event exists to clear the stale
// mapping) followed by a different role adopting the same Discord role.
const TEAM_DISCORD_ROLE_UNIQUE_CONSTRAINT = 'discord_role_mappings_team_id_discord_role_id_key';

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByRole = SqlSchema.findOneOption({
    Request: FindByRoleInput,
    Result: MappingRow,
    execute: (input) => sql`
      SELECT id, team_id, role_id, discord_role_id, adopted
      FROM discord_role_mappings
      WHERE team_id = ${input.team_id} AND role_id = ${input.role_id}
    `,
  });

  const insertMapping = SqlSchema.void({
    Request: InsertInput,
    execute: (input) => sql`
      INSERT INTO discord_role_mappings (team_id, role_id, discord_role_id, adopted)
      VALUES (${input.team_id}, ${input.role_id}, ${input.discord_role_id}, ${input.adopted})
      ON CONFLICT (team_id, role_id)
      DO UPDATE SET discord_role_id = ${input.discord_role_id}, adopted = ${input.adopted}
    `,
  });

  const deleteByRole = SqlSchema.void({
    Request: DeleteByRoleInput,
    execute: (input) => sql`
      DELETE FROM discord_role_mappings
      WHERE team_id = ${input.team_id} AND role_id = ${input.role_id}
    `,
  });

  const _findAllByTeamId = SqlSchema.findAll({
    Request: Schema.String,
    Result: MappingRow,
    execute: (teamId) => sql`
      SELECT id, team_id, role_id, discord_role_id, adopted
      FROM discord_role_mappings
      WHERE team_id = ${teamId}
    `,
  });

  const findByRoleId = (teamId: Team.TeamId, roleId: Role.RoleId) =>
    findByRole({ team_id: teamId, role_id: roleId }).pipe(catchSqlErrors);

  const insert = (
    teamId: Team.TeamId,
    roleId: Role.RoleId,
    discordRoleId: Discord.Snowflake,
    adopted: boolean,
  ) =>
    insertMapping({
      team_id: teamId,
      role_id: roleId,
      discord_role_id: discordRoleId,
      adopted,
    }).pipe(
      SqlErrors.catchUniqueViolationOn(
        TEAM_DISCORD_ROLE_UNIQUE_CONSTRAINT,
        () => new RoleRpcModels.DiscordRoleAlreadyMapped(),
      ),
      catchSqlErrors,
    );

  const deleteByRoleId = (teamId: Team.TeamId, roleId: Role.RoleId) =>
    deleteByRole({ team_id: teamId, role_id: roleId }).pipe(catchSqlErrors);

  const findAllByTeam = (teamId: Team.TeamId) => _findAllByTeamId(teamId).pipe(catchSqlErrors);

  return {
    findByRoleId,
    insert,
    deleteByRoleId,
    findAllByTeam,
  };
});

export class DiscordRoleMappingRepository extends ServiceMap.Service<
  DiscordRoleMappingRepository,
  Effect.Success<typeof make>
>()('api/DiscordRoleMappingRepository') {
  static readonly Default = Layer.effect(DiscordRoleMappingRepository, make);
}
