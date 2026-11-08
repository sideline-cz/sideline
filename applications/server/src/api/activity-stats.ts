import { type Achievement, ActivityStats, ActivityStatsApi } from '@sideline/domain';
import { Options } from '@sideline/effect-lib';
import { Effect, Option } from 'effect';
import { HttpApiBuilder } from 'effect/unstable/httpapi';
import { Api } from '~/api/api.js';
import { requirePermission, requireReadAccess } from '~/api/permissions.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { resolveScope } from '~/repositories/activitySeasonScope.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

export const ActivityStatsApiLive = HttpApiBuilder.group(Api, 'activityStats', (handlers) =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('earnedAchievementsOpt', () => Effect.serviceOption(EarnedAchievementsRepository)),
    Effect.map(({ members, activityLogs, earnedAchievementsOpt }) =>
      handlers.handle('getMemberStats', ({ params: { teamId, memberId }, query }) =>
        Effect.Do.pipe(
          Effect.bind('membership', () =>
            requireReadAccess(members, teamId, new ActivityStatsApi.Forbidden()),
          ),
          // Own stats need no member:view (same rule as listLogs). Others: permission, then 404.
          Effect.tap(({ membership }) =>
            membership.id === memberId
              ? Effect.void
              : requirePermission(membership, 'member:view', new ActivityStatsApi.Forbidden()).pipe(
                  Effect.andThen(members.findRosterMemberByIds(teamId, memberId)),
                  Effect.flatMap(Options.toEffect(() => new ActivityStatsApi.MemberNotFound())),
                ),
          ),
          Effect.bind('scope', () => resolveScope(activityLogs, teamId, query.season)),
          Effect.bind('rows', ({ scope }) => activityLogs.findByTeamMember(memberId, scope)),
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
          // Achievements stay lifetime: they are earned once, not per season.
          Effect.map(({ scope, rows, achievementRows }) => {
            const stats = ActivityStats.calculateStats(rows, ActivityStats.todayInPrague());
            return new ActivityStatsApi.ActivityStatsResponse({
              // A past season or Earlier has no running streak.
              currentStreak: scope === 'current' ? stats.currentStreak : 0,
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
