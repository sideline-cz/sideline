import { Achievement, TeamMember } from '@sideline/domain';
import { Effect, Layer, Schema, ServiceMap } from 'effect';
import { SqlClient, SqlSchema } from 'effect/unstable/sql';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class EarnedAchievementRow extends Schema.Class<EarnedAchievementRow>('EarnedAchievementRow')({
  achievement_slug: Achievement.AchievementSlug,
  earned_at: Schema.String,
}) {}

class InsertResult extends Schema.Class<InsertResult>('EarnedAchievementInsertResult')({
  id: Schema.String,
}) {}

class ActivityCountRow extends Schema.Class<ActivityCountRow>('ActivityCountRow')({
  slug: Schema.String,
  count: Schema.Int,
}) {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const findByMemberQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: EarnedAchievementRow,
    execute: (memberId) => sql`
      SELECT achievement_slug, earned_at::text AS earned_at
      FROM earned_achievements
      WHERE team_member_id = ${memberId}
      ORDER BY earned_at ASC
    `,
  });

  const insertIfMissingQuery = SqlSchema.findAll({
    Request: Schema.Struct({
      team_member_id: TeamMember.TeamMemberId,
      achievement_slug: Achievement.AchievementSlug,
    }),
    Result: InsertResult,
    execute: (input) => sql`
      INSERT INTO earned_achievements (team_member_id, achievement_slug)
      VALUES (${input.team_member_id}, ${input.achievement_slug})
      ON CONFLICT (team_member_id, achievement_slug) DO NOTHING
      RETURNING id
    `,
  });

  const activityCountsBySlugQuery = SqlSchema.findAll({
    Request: TeamMember.TeamMemberId,
    Result: ActivityCountRow,
    execute: (memberId) => sql`
      SELECT at.slug AS slug, COUNT(*)::int AS count
      FROM activity_logs al
      JOIN activity_types at ON at.id = al.activity_type_id
      WHERE al.team_member_id = ${memberId}
      GROUP BY at.slug
    `,
  });

  const findByMember = (teamMemberId: TeamMember.TeamMemberId) =>
    findByMemberQuery(teamMemberId).pipe(catchSqlErrors);

  const findEarnedSlugs = (teamMemberId: TeamMember.TeamMemberId) =>
    findByMemberQuery(teamMemberId).pipe(
      catchSqlErrors,
      Effect.map(
        (rows): ReadonlySet<Achievement.AchievementSlug> =>
          new Set(rows.map((r) => r.achievement_slug)),
      ),
    );

  const insertIfMissing = (
    teamMemberId: TeamMember.TeamMemberId,
    slug: Achievement.AchievementSlug,
  ) =>
    insertIfMissingQuery({ team_member_id: teamMemberId, achievement_slug: slug }).pipe(
      catchSqlErrors,
      Effect.map((rows) => rows.length > 0),
    );

  const getActivityCountsBySlug = (teamMemberId: TeamMember.TeamMemberId) =>
    activityCountsBySlugQuery(teamMemberId).pipe(catchSqlErrors);

  return {
    findByMember,
    findEarnedSlugs,
    insertIfMissing,
    getActivityCountsBySlug,
  };
});

export class EarnedAchievementsRepository extends ServiceMap.Service<
  EarnedAchievementsRepository,
  Effect.Success<typeof make>
>()('api/EarnedAchievementsRepository') {
  static readonly Default = Layer.effect(EarnedAchievementsRepository, make);
}
