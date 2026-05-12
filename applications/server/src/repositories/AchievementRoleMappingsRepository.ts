import { Achievement, Discord, Team } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class MappingRow extends Schema.Class<MappingRow>('AchievementRoleMappingRow')({
  team_id: Team.TeamId,
  achievement_slug: Schema.String,
  discord_role_id: Discord.Snowflake,
}) {}

const FindInput = Schema.Struct({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
});

const UpsertInput = Schema.Struct({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
  discord_role_id: Discord.Snowflake,
});

const DeleteInput = Schema.Struct({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamAndSlugQuery = SqlSchema.findOneOption({
    Request: FindInput,
    Result: MappingRow,
    execute: (input) => sql`
      SELECT team_id, achievement_slug, discord_role_id
      FROM achievement_role_mappings
      WHERE team_id = ${input.team_id} AND achievement_slug = ${input.achievement_slug}
    `,
  });

  const findAllByTeamQuery = SqlSchema.findAll({
    Request: Schema.String,
    Result: MappingRow,
    execute: (teamId) => sql`
      SELECT team_id, achievement_slug, discord_role_id
      FROM achievement_role_mappings
      WHERE team_id = ${teamId}
    `,
  });

  const upsertQuery = SqlSchema.void({
    Request: UpsertInput,
    execute: (input) => sql`
      INSERT INTO achievement_role_mappings (team_id, achievement_slug, discord_role_id)
      VALUES (${input.team_id}, ${input.achievement_slug}, ${input.discord_role_id})
      ON CONFLICT (team_id, achievement_slug) DO UPDATE SET discord_role_id = EXCLUDED.discord_role_id
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: DeleteInput,
    execute: (input) => sql`
      DELETE FROM achievement_role_mappings
      WHERE team_id = ${input.team_id} AND achievement_slug = ${input.achievement_slug}
    `,
  });

  const findByTeamAndSlug = (
    teamId: Team.TeamId,
    slug: Achievement.AchievementSlug,
  ): Effect.Effect<Option.Option<Discord.Snowflake>> =>
    findByTeamAndSlugQuery({
      team_id: teamId,
      achievement_slug: slug,
    }).pipe(catchSqlErrors, Effect.map(Option.map((row) => row.discord_role_id)));

  const findAllByTeam = (teamId: Team.TeamId) =>
    findAllByTeamQuery(teamId).pipe(
      catchSqlErrors,
      Effect.map((rows) =>
        rows.map((r) => ({ slug: r.achievement_slug, discord_role_id: r.discord_role_id })),
      ),
    );

  const upsert = (
    teamId: Team.TeamId,
    slug: Achievement.AchievementSlug,
    discordRoleId: Discord.Snowflake,
  ) =>
    upsertQuery({
      team_id: teamId,
      achievement_slug: slug,
      discord_role_id: discordRoleId,
    }).pipe(catchSqlErrors);

  const _delete = (teamId: Team.TeamId, slug: Achievement.AchievementSlug) =>
    deleteQuery({
      team_id: teamId,
      achievement_slug: slug,
    }).pipe(catchSqlErrors);

  return {
    findByTeamAndSlug,
    findAllByTeam,
    upsert,
    delete: _delete,
  };
});

export class AchievementRoleMappingsRepository extends ServiceMap.Service<
  AchievementRoleMappingsRepository,
  Effect.Success<typeof make>
>()('api/AchievementRoleMappingsRepository') {
  static readonly Default = Layer.effect(AchievementRoleMappingsRepository, make);
}
