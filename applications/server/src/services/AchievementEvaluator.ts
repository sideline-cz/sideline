import { Achievement, ActivityStats, type TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, ServiceMap } from 'effect';
import { packageMasteriesFromLastCorrect } from '~/api/rules-trainer.js';
import { AchievementSettingsRepository } from '~/repositories/AchievementSettingsRepository.js';
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

const evaluate = (teamMemberId: TeamMember.TeamMemberId) =>
  Effect.Do.pipe(
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('earned', () => EarnedAchievementsRepository.asEffect()),
    Effect.bind('syncEvents', () => AchievementSyncEventsRepository.asEffect()),
    Effect.bind('teamMembers', () => TeamMembersRepository.asEffect()),
    Effect.bind('achievementSettings', () => AchievementSettingsRepository.asEffect()),
    Effect.bind('rulesAttempts', () => RulesAttemptsRepository.asEffect()),
    Effect.bind('member', ({ teamMembers }) =>
      teamMembers.findById(teamMemberId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => LogicError.die('Member not found in AchievementEvaluator'),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('overrides', ({ achievementSettings, member }) =>
      achievementSettings.findOverridesByTeam(member.team_id),
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
    // Rules-trainer milestone stats (Phase 3b of `docs/plans/rules-trainer.md`).
    // `rules_attempts` has no `team_id` (deliberately, so progress survives
    // leaving a team), so both queries are scoped by `member.user_id`, not
    // `teamMemberId` — a member who practised before joining still earns the
    // milestones they already qualify for.
    Effect.bind('examStats', ({ rulesAttempts, member }) =>
      rulesAttempts.getExamStats(member.user_id),
    ),
    Effect.bind('lastCorrectRows', ({ rulesAttempts, member }) =>
      rulesAttempts.lastCorrectByScenario(member.user_id),
    ),
    Effect.let('rules', ({ examStats, lastCorrectRows }) => {
      const lastCorrectAtByScenario = new Map(
        lastCorrectRows.map((row) => [row.scenario_id, row.last_correct_at.epochMilliseconds]),
      );
      const packagesMastered = packageMasteriesFromLastCorrect(
        lastCorrectAtByScenario,
        Date.now(),
      ).filter((m) => m.mastered).length;
      return {
        examsCompleted: examStats.exams_completed,
        perfectExams: examStats.perfect_exams,
        packagesMastered,
      };
    }),
    Effect.bind('alreadyEarned', ({ earned }) => earned.findEarnedSlugs(teamMemberId)),
    Effect.let('newlyEarned', ({ stats, countsBySlug, rules, alreadyEarned, overrides }) =>
      Achievement.ACHIEVEMENTS.filter((a) => {
        if (alreadyEarned.has(a.slug)) return false;
        const threshold = Achievement.effectiveThreshold(a.slug, overrides);
        return a.isEarned({ stats, countsBySlug, rules }, threshold);
      }),
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
