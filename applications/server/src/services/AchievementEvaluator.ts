import { Achievement, ActivityStats, type TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, ServiceMap } from 'effect';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const evaluate = (teamMemberId: TeamMember.TeamMemberId) =>
  Effect.Do.pipe(
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('earned', () => EarnedAchievementsRepository.asEffect()),
    Effect.bind('syncEvents', () => AchievementSyncEventsRepository.asEffect()),
    Effect.bind('teamMembers', () => TeamMembersRepository.asEffect()),
    Effect.bind('member', ({ teamMembers }) =>
      teamMembers.findById(teamMemberId).pipe(
        Effect.flatMap((opt) =>
          Option.match(opt, {
            onNone: () => LogicError.die('Member not found in AchievementEvaluator'),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('rows', ({ activityLogs }) => activityLogs.findByTeamMember(teamMemberId)),
    Effect.let('stats', ({ rows }) =>
      ActivityStats.calculateStats(rows, ActivityStats.todayInPrague()),
    ),
    Effect.bind('countsRows', ({ earned }) => earned.getActivityCountsBySlug(teamMemberId)),
    Effect.let(
      'countsBySlug',
      ({ countsRows }) => new Map(countsRows.map((r) => [r.slug, r.count])),
    ),
    Effect.bind('alreadyEarned', ({ earned }) => earned.findEarnedSlugs(teamMemberId)),
    Effect.let('newlyEarned', ({ stats, countsBySlug, alreadyEarned }) =>
      Achievement.ACHIEVEMENTS.filter(
        (a) => !alreadyEarned.has(a.slug) && a.isEarned({ stats, countsBySlug }),
      ),
    ),
    Effect.tap(({ earned, syncEvents, member, newlyEarned }) =>
      Effect.forEach(
        newlyEarned,
        (a) =>
          earned
            .insertIfMissing(teamMemberId, a.slug)
            .pipe(
              Effect.flatMap((inserted) =>
                inserted ? syncEvents.emit(member.team_id, teamMemberId, a.slug) : Effect.void,
              ),
            ),
        { concurrency: 1 },
      ),
    ),
    Effect.asVoid,
  );

const make = Effect.succeed({ evaluate });

export class AchievementEvaluator extends ServiceMap.Service<
  AchievementEvaluator,
  Effect.Success<typeof make>
>()('api/AchievementEvaluator') {
  static readonly Default = Layer.effect(AchievementEvaluator, make);
}
