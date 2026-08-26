import {
  Achievement,
  ActivityStats,
  DisplayName,
  type Team,
  type TeamMember,
} from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, ServiceMap } from 'effect';
import { packageMasteriesFromLastCorrect } from '~/api/rules-trainer.js';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
import { RulesAttemptsRepository } from '~/repositories/RulesAttemptsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

export interface PreviewResult {
  readonly qualifyingCount: number;
  readonly removedMembers: ReadonlyArray<{
    teamMemberId: TeamMember.TeamMemberId;
    memberName: string;
  }>;
  readonly botCanManageRoles: boolean;
}

const make = Effect.Do.pipe(
  Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
  Effect.bind('earned', () => EarnedAchievementsRepository.asEffect()),
  Effect.bind('teamMembers', () => TeamMembersRepository.asEffect()),
  Effect.bind('users', () => UsersRepository.asEffect()),
  Effect.bind('rulesAttempts', () => RulesAttemptsRepository.asEffect()),
  Effect.map(({ activityLogs, earned, teamMembers, users, rulesAttempts }) => {
    const preview = (
      teamId: Team.TeamId,
      slug: Achievement.AchievementSlug,
      candidateThreshold: number,
    ): Effect.Effect<PreviewResult> =>
      Effect.Do.pipe(
        Effect.bind('catalogEntry', () => {
          const entry = Achievement.ACHIEVEMENTS_BY_SLUG.get(slug);
          return entry !== undefined
            ? Effect.succeed(entry)
            : LogicError.die(`Unknown achievement slug: ${slug}`);
        }),
        Effect.bind('allMembers', () => teamMembers.findByTeam(teamId)),
        Effect.bind('memberStats', ({ allMembers }) =>
          Effect.forEach(
            allMembers,
            (member) =>
              Effect.Do.pipe(
                Effect.bind('rows', () => activityLogs.findByTeamMember(member.id)),
                Effect.let('stats', ({ rows }) =>
                  ActivityStats.calculateStats(rows, ActivityStats.todayInPrague()),
                ),
                Effect.bind('countsRows', () => earned.getActivityCountsBySlug(member.id)),
                Effect.let(
                  'countsBySlug',
                  ({ countsRows }) => new Map(countsRows.map((r) => [r.slug, r.count])),
                ),
                // Rules-trainer milestone stats, scoped by `member.user_id`
                // (not `member.id`) for the same reason as `AchievementEvaluator`
                // — `rules_attempts` has no `team_id`.
                Effect.bind('examStats', () => rulesAttempts.getExamStats(member.user_id)),
                Effect.bind('lastCorrectRows', () =>
                  rulesAttempts.lastCorrectByScenario(member.user_id),
                ),
                Effect.let('rules', ({ examStats, lastCorrectRows }) => {
                  const lastCorrectAtByScenario = new Map(
                    lastCorrectRows.map(
                      (row) => [row.scenario_id, row.last_correct_at.epochMilliseconds] as const,
                    ),
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
                Effect.map(({ stats, countsBySlug, rules }) => ({
                  member,
                  stats,
                  countsBySlug,
                  rules,
                })),
              ),
            { concurrency: 5 },
          ),
        ),
        Effect.let(
          'qualifyingCount',
          ({ memberStats, catalogEntry }) =>
            memberStats.filter(({ stats, countsBySlug, rules }) =>
              catalogEntry.isEarned({ stats, countsBySlug, rules }, candidateThreshold),
            ).length,
        ),
        Effect.bind('removedMembers', ({ memberStats, catalogEntry }) =>
          Effect.Do.pipe(
            Effect.bind('currentlyEarnedMemberIds', () =>
              Effect.forEach(
                memberStats,
                ({ member }) =>
                  earned
                    .findEarnedSlugs(member.id)
                    .pipe(
                      Effect.map((slugs) =>
                        slugs.has(slug)
                          ? Option.some(member.id)
                          : Option.none<TeamMember.TeamMemberId>(),
                      ),
                    ),
                { concurrency: 5 },
              ).pipe(Effect.map((opts) => new Set(opts.flatMap(Option.toArray)))),
            ),
            Effect.let('removedMembersRaw', ({ currentlyEarnedMemberIds }) =>
              memberStats
                .filter(
                  ({ member, stats, countsBySlug, rules }) =>
                    currentlyEarnedMemberIds.has(member.id) &&
                    !catalogEntry.isEarned({ stats, countsBySlug, rules }, candidateThreshold),
                )
                .slice(0, 100),
            ),
            Effect.flatMap(({ removedMembersRaw }) =>
              Effect.forEach(
                removedMembersRaw,
                ({ member }) =>
                  users.findById(member.user_id).pipe(
                    Effect.map((userOpt) => {
                      const displayName = Option.isSome(userOpt)
                        ? Option.getOrElse(
                            DisplayName.pickDisplayName({
                              name: userOpt.value.name,
                              nickname: userOpt.value.discord_nickname,
                              displayName: userOpt.value.discord_display_name,
                              username: Option.some(userOpt.value.username),
                            }),
                            () => userOpt.value.username,
                          )
                        : String(member.user_id);
                      return {
                        teamMemberId: member.id,
                        memberName: displayName,
                      };
                    }),
                  ),
                { concurrency: 5 },
              ),
            ),
          ),
        ),
        Effect.map(({ qualifyingCount, removedMembers }) => ({
          qualifyingCount,
          removedMembers,
          botCanManageRoles: true,
        })),
      );

    return { preview };
  }),
);

export class AchievementPreview extends ServiceMap.Service<
  AchievementPreview,
  Effect.Success<typeof make>
>()('api/AchievementPreview') {
  static readonly Default = Layer.effect(AchievementPreview, make);
}
