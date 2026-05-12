import { Achievement } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import { Card } from '~/components/ui/card';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '~/components/ui/tooltip';

const SLUG_EMOJI: Record<Achievement.AchievementSlug, string> = {
  first_activity: '🌱',
  ten_activities: '🔟',
  fifty_activities: '🎯',
  hundred_activities: '💯',
  streak_3: '🔥',
  streak_7: '🚀',
  streak_30: '🏆',
  duration_600: '⏱️',
  duration_3000: '⏰',
  gym_25: '🏋️',
  running_25: '🏃',
};

type TitleKey =
  | 'achievement_first_activity_title'
  | 'achievement_ten_activities_title'
  | 'achievement_fifty_activities_title'
  | 'achievement_hundred_activities_title'
  | 'achievement_streak_3_title'
  | 'achievement_streak_7_title'
  | 'achievement_streak_30_title'
  | 'achievement_duration_600_title'
  | 'achievement_duration_3000_title'
  | 'achievement_gym_25_title'
  | 'achievement_running_25_title';

type DescriptionKey =
  | 'achievement_first_activity_description'
  | 'achievement_ten_activities_description'
  | 'achievement_fifty_activities_description'
  | 'achievement_hundred_activities_description'
  | 'achievement_streak_3_description'
  | 'achievement_streak_7_description'
  | 'achievement_streak_30_description'
  | 'achievement_duration_600_description'
  | 'achievement_duration_3000_description'
  | 'achievement_gym_25_description'
  | 'achievement_running_25_description';

function getTitle(slug: Achievement.AchievementSlug): string {
  const key = `achievement_${slug}_title` as TitleKey;
  return m[key]();
}

function getDescription(slug: Achievement.AchievementSlug): string {
  const key = `achievement_${slug}_description` as DescriptionKey;
  return m[key]();
}

type EarnedAchievement = {
  achievement_slug: string;
  earned_at: Date;
};

interface AchievementsGridProps {
  earnedAchievements: ReadonlyArray<EarnedAchievement>;
  sectionTitle?: string;
  sectionCount?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  earnedOnLabel?: (date: string) => string;
}

export function AchievementsGrid({
  earnedAchievements,
  sectionTitle,
  sectionCount,
  emptyTitle,
  emptyDescription,
  earnedOnLabel,
}: AchievementsGridProps) {
  const earnedMap = new Map<string, Date>(
    earnedAchievements.map((a) => [a.achievement_slug, a.earned_at]),
  );

  const earnedCount = earnedAchievements.filter((a) =>
    Achievement.ACHIEVEMENTS.some((c) => c.slug === a.achievement_slug),
  ).length;

  return (
    <div className='mt-6'>
      {sectionTitle !== undefined || sectionCount !== undefined ? (
        <div className='flex items-center justify-between mb-4'>
          {sectionTitle !== undefined ? (
            <h2 className='text-lg font-semibold'>{sectionTitle}</h2>
          ) : null}
          {sectionCount !== undefined ? (
            <span className='text-sm text-muted-foreground'>{sectionCount}</span>
          ) : null}
        </div>
      ) : null}
      {earnedCount === 0 && (emptyTitle !== undefined || emptyDescription !== undefined) ? (
        <div className='flex flex-col items-center justify-center py-10 text-center'>
          <span className='text-5xl mb-3'>🏅</span>
          {emptyTitle !== undefined ? (
            <h3 className='text-base font-semibold mb-1'>{emptyTitle}</h3>
          ) : null}
          {emptyDescription !== undefined ? (
            <p className='text-sm text-muted-foreground'>{emptyDescription}</p>
          ) : null}
        </div>
      ) : null}
      <TooltipProvider>
        <div className='grid grid-cols-3 sm:grid-cols-4 md:grid-cols-6 gap-3'>
          {Achievement.ACHIEVEMENTS.map((entry) => {
            const earnedAt = earnedMap.get(entry.slug);
            const isEarned = earnedAt !== undefined;
            const catalogEntry = Achievement.ACHIEVEMENTS_BY_SLUG.get(entry.slug);
            const grantsRole = catalogEntry?.grantsDiscordRole ?? false;

            const title = getTitle(entry.slug);
            const description = getDescription(entry.slug);
            const emoji = SLUG_EMOJI[entry.slug];

            const formattedDate = earnedAt
              ? earnedAt.toLocaleDateString(undefined, {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })
              : null;

            return (
              <Tooltip key={entry.slug}>
                <TooltipTrigger asChild>
                  <Card
                    data-achievement={entry.slug}
                    data-earned={isEarned ? 'true' : undefined}
                    className={[
                      'aspect-square flex flex-col items-center justify-center gap-1 p-2 cursor-default select-none',
                      isEarned ? '' : 'opacity-40 grayscale',
                    ]
                      .join(' ')
                      .trim()}
                  >
                    <span className='text-4xl'>{emoji}</span>
                    <span className='text-xs font-medium text-center leading-tight'>{title}</span>
                    {formattedDate !== null ? (
                      <span className='text-xs text-muted-foreground'>{formattedDate}</span>
                    ) : null}
                  </Card>
                </TooltipTrigger>
                <TooltipContent className='max-w-56'>
                  <p className='font-semibold mb-1'>{title}</p>
                  <p className='text-xs mb-1'>{description}</p>
                  {formattedDate !== null && earnedOnLabel !== undefined ? (
                    <p className='text-xs'>{earnedOnLabel(formattedDate)}</p>
                  ) : null}
                  {grantsRole ? (
                    <p className='text-xs mt-1 font-medium'>Grants Discord role</p>
                  ) : null}
                </TooltipContent>
              </Tooltip>
            );
          })}
        </div>
      </TooltipProvider>
    </div>
  );
}

/**
 * Wrapper that provides i18n strings to AchievementsGrid.
 * Use this in page components. Tests use AchievementsGrid directly with mocked per-achievement messages.
 */
export function AchievementsGridI18n({
  earnedAchievements,
}: {
  earnedAchievements: ReadonlyArray<EarnedAchievement>;
}) {
  const total = Achievement.ACHIEVEMENTS.length;
  const earnedCount = earnedAchievements.filter((a) =>
    Achievement.ACHIEVEMENTS.some((c) => c.slug === a.achievement_slug),
  ).length;

  return (
    <AchievementsGrid
      earnedAchievements={earnedAchievements}
      sectionTitle={m.achievements_section_title()}
      sectionCount={m.achievements_section_count({ earned: earnedCount, total })}
      emptyTitle={m.achievements_empty_title()}
      emptyDescription={m.achievements_empty_description()}
      earnedOnLabel={(date) => m.achievements_earned_on({ date })}
    />
  );
}
