import { Achievement, Team } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class SettingsRow extends Schema.Class<SettingsRow>('AchievementSettingsRow')({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
  threshold_override: Schema.Int,
}) {}

const FindByTeamInput = Schema.Struct({
  team_id: Team.TeamId,
});

const UpsertInput = Schema.Struct({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
  threshold_override: Schema.Int,
});

const DeleteInput = Schema.Struct({
  team_id: Team.TeamId,
  achievement_slug: Achievement.AchievementSlug,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByTeamQuery = SqlSchema.findAll({
    Request: FindByTeamInput,
    Result: SettingsRow,
    execute: (input) => sql`
      SELECT team_id, achievement_slug, threshold_override
      FROM achievement_settings
      WHERE team_id = ${input.team_id}
    `,
  });

  const upsertQuery = SqlSchema.void({
    Request: UpsertInput,
    execute: (input) => sql`
      INSERT INTO achievement_settings (team_id, achievement_slug, threshold_override)
      VALUES (${input.team_id}, ${input.achievement_slug}, ${input.threshold_override})
      ON CONFLICT (team_id, achievement_slug) DO UPDATE SET
        threshold_override = EXCLUDED.threshold_override,
        updated_at = now()
    `,
  });

  const deleteQuery = SqlSchema.void({
    Request: DeleteInput,
    execute: (input) => sql`
      DELETE FROM achievement_settings
      WHERE team_id = ${input.team_id} AND achievement_slug = ${input.achievement_slug}
    `,
  });

  const findOverridesByTeam = (
    teamId: Team.TeamId,
  ): Effect.Effect<ReadonlyMap<Achievement.AchievementSlug, number>> =>
    findByTeamQuery({ team_id: teamId }).pipe(
      catchSqlErrors,
      Effect.map(
        (rows) =>
          new Map<Achievement.AchievementSlug, number>(
            rows.map((r) => [r.achievement_slug, r.threshold_override]),
          ),
      ),
    );

  const upsertOverride = (
    teamId: Team.TeamId,
    slug: Achievement.AchievementSlug,
    threshold: number,
  ): Effect.Effect<void> =>
    upsertQuery({
      team_id: teamId,
      achievement_slug: slug,
      threshold_override: threshold,
    }).pipe(catchSqlErrors);

  const deleteOverride = (
    teamId: Team.TeamId,
    slug: Achievement.AchievementSlug,
  ): Effect.Effect<void> =>
    deleteQuery({
      team_id: teamId,
      achievement_slug: slug,
    }).pipe(catchSqlErrors);

  return {
    findOverridesByTeam,
    upsertOverride,
    deleteOverride,
  };
});

export class AchievementSettingsRepository extends ServiceMap.Service<
  AchievementSettingsRepository,
  Effect.Success<typeof make>
>()('api/AchievementSettingsRepository') {
  static readonly Default = Layer.effect(AchievementSettingsRepository, make);
}
