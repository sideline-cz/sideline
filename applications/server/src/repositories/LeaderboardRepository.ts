import type { ActivityType, Leaderboard, Team } from '@sideline/domain';
import { TeamMember, User } from '@sideline/domain';
import { Effect, Layer, Option, Schema, ServiceMap } from 'effect';
import { SqlClient } from 'effect/unstable/sql';
import { type LogScope, seasonScopeFilter } from '~/repositories/activitySeasonScope.js';
import { catchSqlErrors } from '~/repositories/catchSqlErrors.js';

class LeaderboardRow extends Schema.Class<LeaderboardRow>('LeaderboardRow')({
  team_member_id: TeamMember.TeamMemberId,
  user_id: User.UserId,
  username: Schema.String,
  name: Schema.OptionFromNullOr(Schema.String),
  avatar: Schema.OptionFromNullOr(Schema.String),
  discord_nickname: Schema.OptionFromNullOr(Schema.String),
  discord_display_name: Schema.OptionFromNullOr(Schema.String),
  total_activities: Schema.Int,
  total_duration_minutes: Schema.Int,
  activity_dates: Schema.Array(Schema.String),
}) {}

const decodeRows = Schema.decodeUnknownEffect(Schema.Array(LeaderboardRow));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getLeaderboard = (
    teamId: Team.TeamId,
    activityTypeId: Option.Option<ActivityType.ActivityTypeId>,
    scope: Leaderboard.LeaderboardTimeframe | Exclude<LogScope, 'lifetime'>,
  ) => {
    const activityTypeFilter = Option.match(activityTypeId, {
      onNone: () => sql``,
      onSome: (id) => sql`AND al.activity_type_id = ${id}`,
    });

    const activityTypeDatesFilter = Option.match(activityTypeId, {
      onNone: () => sql``,
      onSome: (id) => sql`AND al2.activity_type_id = ${id}`,
    });

    const isTimeframe = scope === 'all' || scope === 'week';
    const timeframeFilter =
      scope === 'week'
        ? sql`AND al.logged_at >= NOW() - INTERVAL '7 days'`
        : isTimeframe
          ? sql``
          : seasonScopeFilter(sql, 'al', scope, sql`${teamId}`);

    // al2, not al: al is the outer LEFT JOIN row; binding to it makes the streak dates unscoped.
    // 'all' / 'week' keep the streak dates unfiltered (unchanged behaviour).
    const seasonDatesFilter = isTimeframe
      ? sql``
      : seasonScopeFilter(sql, 'al2', scope, sql`${teamId}`);

    const query = sql`
      SELECT
        tm.id::text AS team_member_id,
        u.id::text AS user_id,
        u.username,
        u.name,
        u.avatar,
        u.discord_nickname,
        u.discord_display_name,
        COUNT(al.id)::int AS total_activities,
        COALESCE(SUM(al.duration_minutes), 0)::int AS total_duration_minutes,
        ARRAY(
          SELECT DISTINCT (al2.logged_at AT TIME ZONE 'Europe/Prague')::date::text
          FROM activity_logs al2
          WHERE al2.team_member_id = tm.id
            ${activityTypeDatesFilter}
            ${seasonDatesFilter}
          ORDER BY 1
        ) AS activity_dates
      FROM team_members tm
      JOIN users u ON u.id = tm.user_id
      LEFT JOIN activity_logs al ON al.team_member_id = tm.id
        ${activityTypeFilter}
        ${timeframeFilter}
      WHERE tm.team_id = ${teamId}
        AND tm.active = true
      GROUP BY tm.id, u.id, u.username, u.name, u.avatar, u.discord_nickname, u.discord_display_name
      HAVING COUNT(al.id) > 0
      ORDER BY total_activities DESC, total_duration_minutes DESC
    `;

    return query.pipe(Effect.flatMap(decodeRows), catchSqlErrors);
  };

  return {
    getLeaderboard,
  };
});

export class LeaderboardRepository extends ServiceMap.Service<
  LeaderboardRepository,
  Effect.Success<typeof make>
>()('api/LeaderboardRepository') {
  static readonly Default = Layer.effect(LeaderboardRepository, make);
}
