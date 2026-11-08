import type { ActivityLog, Team } from '@sideline/domain';
import { Effect, Option } from 'effect';
import type { SqlClient, Statement } from 'effect/unstable/sql';

// Which activity logs a read covers. 'lifetime' = all logs (achievements, AI tool);
// 'current' = current_season_id(team); 'earlier' = season_id IS NULL; else one season id.
export type LogScope = 'lifetime' | 'current' | 'earlier' | ActivityLog.ActivitySeasonId;

// teamId: a fragment that yields the team id, e.g. sql`${teamId}` or a subquery.
export const seasonScopeFilter = (
  sql: SqlClient.SqlClient,
  alias: 'al' | 'al2',
  scope: LogScope,
  teamId: Statement.Fragment,
) =>
  scope === 'lifetime'
    ? sql``
    : scope === 'earlier'
      ? sql`AND ${sql(alias)}.season_id IS NULL`
      : scope === 'current'
        ? // No running season -> current_season_id is NULL -> "= NULL" matches nothing (empty view).
          sql`AND ${sql(alias)}.season_id = current_season_id(${teamId})`
        : sql`AND ${sql(alias)}.season_id = ${scope}`;

// No param -> 'current'. A season id that IS the current season -> 'current', so a shared or
// bookmarked URL gets the same data and the same current streak as the default view.
// A season id of another team cannot leak: every scoped query also filters by member or team.
export const resolveScope = (
  activityLogs: {
    readonly findCurrentSeasonId: (
      teamId: Team.TeamId,
    ) => Effect.Effect<Option.Option<ActivityLog.ActivitySeasonId>>;
  },
  teamId: Team.TeamId,
  season: Option.Option<ActivityLog.ActivitySeasonFilter>,
): Effect.Effect<Exclude<LogScope, 'lifetime'>> =>
  Option.match(season, {
    onNone: () => Effect.succeed('current' as const),
    onSome: (s) =>
      s === 'earlier'
        ? Effect.succeed(s)
        : activityLogs
            .findCurrentSeasonId(teamId)
            .pipe(
              Effect.map((cur) => (Option.exists(cur, (c) => c === s) ? ('current' as const) : s)),
            ),
  });
