import { type Achievement, ActivityStats, ActivityStatsApi, Auth } from '@sideline/domain';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requireMembership, requirePermission } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

export const ActivityStatsApiLive = HttpApiBuilder.group(Api, 'activityStats', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('earnedAchievementsOpt', () => Effect.serviceOption(EarnedAchievementsRepository)),
    Effect.map(({ members, activityLogs, earnedAchievementsOpt }) =>
      handlers.handle('getMemberStats', ({ params: { teamId, memberId } }) =>
        Effect.Do.pipe(
          Effect.bind('currentUser', () => Auth.CurrentUserContext.asEffect()),
          Effect.bind('membership', ({ currentUser }) =>
            requireMembership(members, teamId, currentUser.id, new ActivityStatsApi.Forbidden()),
          ),
          Effect.tap(({ membership }) =>
            requirePermission(membership, 'member:view', new ActivityStatsApi.Forbidden()),
          ),
          Effect.tap(() =>
            members.findRosterMemberByIds(teamId, memberId).pipe(
              Effect.flatMap(
                Option.match({
                  onNone: () => Effect.fail(new ActivityStatsApi.MemberNotFound()),
                  onSome: Effect.succeed,
                }),
              ),
            ),
          ),
          Effect.bind('rows', () => activityLogs.findByTeamMember(memberId)),
          Effect.bind('achievementRows', () =>
            Option.match(earnedAchievementsOpt, {
              onNone: (): Effect.Effect<
                ReadonlyArray<{
                  readonly achievement_slug: Achievement.AchievementSlug;
                  readonly earned_at: string;
                }>
              > => Effect.succeed([]),
              onSome: (repo) => repo.findByMember(memberId),
            }),
          ),
          Effect.map(({ rows, achievementRows }) => {
            const stats = ActivityStats.calculateStats(rows, ActivityStats.todayInPrague());
            return new ActivityStatsApi.ActivityStatsResponse({
              currentStreak: stats.currentStreak,
              longestStreak: stats.longestStreak,
              totalActivities: stats.totalActivities,
              totalDurationMinutes: stats.totalDurationMinutes,
              counts: stats.counts,
              achievements: achievementRows.map((a) => ({
                slug: a.achievement_slug,
                earned_at: a.earned_at,
              })),
            });
          }),
        ),
      ),
    ),
  ),
);
