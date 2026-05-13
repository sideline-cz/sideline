import { Achievement, ActivityStats, type Team, type TeamMember } from '@sideline/domain';
import { LogicError } from '@sideline/effect-lib';
import { Effect, Layer, Option, ServiceMap } from 'effect';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { EarnedAchievementsRepository } from '~/repositories/EarnedAchievementsRepository.js';
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
  Effect.map(({ activityLogs, earned, teamMembers, users }) => {
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
                Effect.map(({ stats, countsBySlug }) => ({ member, stats, countsBySlug })),
              ),
            { concurrency: 5 },
          ),
        ),
        Effect.let(
          'qualifyingCount',
          ({ memberStats, catalogEntry }) =>
            memberStats.filter(({ stats, countsBySlug }) =>
              catalogEntry.isEarned({ stats, countsBySlug }, candidateThreshold),
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
                  ({ member, stats, countsBySlug }) =>
                    currentlyEarnedMemberIds.has(member.id) &&
                    !catalogEntry.isEarned({ stats, countsBySlug }, candidateThreshold),
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
                        ? Option.getOrElse(userOpt.value.name, () => userOpt.value.username)
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
