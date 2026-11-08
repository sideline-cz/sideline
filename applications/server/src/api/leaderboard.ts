import { ActivityStats, Auth, DisplayName, Leaderboard, LeaderboardApi } from '@sideline/domain';
import { Array, Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import type { LogScope } from '~/repositories/activitySeasonScope.js';
import { resolveScope } from '~/repositories/activitySeasonScope.js';
import { LeaderboardRepository } from '~/repositories/LeaderboardRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

export const LeaderboardApiLive = HttpApiBuilder.group(Api, 'leaderboard', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('leaderboard', () => LeaderboardRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.map(({ members, leaderboard, activityLogs }) =>
      handlers.handle(
        'getLeaderboard',
        ({ params: { teamId }, query: { timeframe, season, activityTypeId } }) =>
          Effect.Do.pipe(
            Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
            Effect.tap(({ currentUser }) =>
              requireMembership(members, teamId, currentUser.id, new LeaderboardApi.Forbidden()),
            ),
            // timeframe present -> old behaviour; absent -> season scope (default current).
            Effect.bind(
              'scope',
              (): Effect.Effect<Leaderboard.LeaderboardTimeframe | Exclude<LogScope, 'lifetime'>> =>
                Option.match(timeframe, {
                  onSome: Effect.succeed,
                  onNone: () => resolveScope(activityLogs, teamId, season),
                }),
            ),
            Effect.bind('rows', ({ scope }) =>
              leaderboard.getLeaderboard(teamId, activityTypeId, scope),
            ),
            Effect.map(({ scope, rows }) => {
              const today = ActivityStats.todayInPrague();
              // A past season or Earlier has no running streak.
              const hasCurrentStreak = scope === 'current' || scope === 'all' || scope === 'week';

              const memberData = rows.map((row) => {
                const streaks = ActivityStats.calculateStreaks(row.activity_dates, today);
                return {
                  teamMemberId: row.team_member_id,
                  userId: row.user_id,
                  username: row.username,
                  totalActivities: row.total_activities,
                  totalDurationMinutes: row.total_duration_minutes,
                  currentStreak: hasCurrentStreak ? streaks.currentStreak : 0,
                  longestStreak: streaks.longestStreak,
                };
              });

              const ranked = Leaderboard.rankLeaderboard(memberData);

              const entries = ranked.map((entry) => {
                const row = Array.findFirst(rows, (r) => r.team_member_id === entry.teamMemberId);
                return new LeaderboardApi.LeaderboardEntry({
                  rank: entry.rank,
                  teamMemberId: entry.teamMemberId,
                  userId: entry.userId,
                  username: entry.username,
                  name: Option.flatMap(row, (r) => r.name),
                  avatar: Option.flatMap(row, (r) => r.avatar),
                  displayName: Option.match(row, {
                    onNone: () => entry.username,
                    onSome: (r) =>
                      Option.getOrElse(
                        DisplayName.pickDisplayName({
                          name: r.name,
                          nickname: r.discord_nickname,
                          displayName: r.discord_display_name,
                          username: Option.some(entry.username),
                        }),
                        () => entry.username,
                      ),
                  }),
                  totalActivities: entry.totalActivities,
                  totalDurationMinutes: entry.totalDurationMinutes,
                  currentStreak: entry.currentStreak,
                  longestStreak: entry.longestStreak,
                });
              });

              return new LeaderboardApi.LeaderboardResponse({ entries });
            }),
          ),
      ),
    ),
  ),
);
