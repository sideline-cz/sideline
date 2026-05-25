import type { WeeklyChallenge } from '@sideline/domain';
import { tr } from '~/lib/translations.js';
import { cn } from '~/lib/utils';

type WeeklyChallengeKind = WeeklyChallenge.WeeklyChallengeKind;

interface ChallengeKindBadgeProps {
  kind: WeeklyChallengeKind;
  className?: string;
}

const kindConfig = {
  throwing: {
    emoji: '🥏',
    labelKey: 'challenges_kind_throwing' as const,
    colorClass: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300',
  },
  sport: {
    emoji: '🏃',
    labelKey: 'challenges_kind_sport' as const,
    colorClass: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300',
  },
} satisfies Record<WeeklyChallengeKind, { emoji: string; labelKey: string; colorClass: string }>;

export function ChallengeKindBadge({ kind, className }: ChallengeKindBadgeProps) {
  const config = kindConfig[kind];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        config.colorClass,
        className,
      )}
    >
      {config.emoji} {tr(config.labelKey)}
    </span>
  );
}
