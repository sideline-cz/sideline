/**
 * The code-defined achievement catalogue: `AchievementSlug`, `ACHIEVEMENTS`
 * (threshold-based, evaluated from `AchievementEvaluationInput`), and the
 * exhaustive `BUILT_IN_ENGLISH_NAMES`/`BUILT_IN_RULE_KINDS` records every
 * slug must appear in — omitting an entry is a compile error, which is the
 * point (see `docs/plans/rules-trainer.md`'s Phase 3 step 15).
 */
import { Schema } from 'effect';
import type * as ActivityStats from './ActivityStats.js';
import type { CustomRuleKind } from './CustomAchievement.js';

export const AchievementSlug = Schema.Literals([
  'first_activity',
  'ten_activities',
  'fifty_activities',
  'hundred_activities',
  'streak_3',
  'streak_7',
  'streak_30',
  'duration_600',
  'duration_3000',
  'gym_25',
  'running_25',
  'rules_first_exam',
  'rules_perfect_exam',
  'rules_package_mastered',
  'rules_all_packages',
]);
export type AchievementSlug = typeof AchievementSlug.Type;

export interface AchievementEvaluationInput {
  readonly stats: ActivityStats.StatsResult;
  readonly countsBySlug: ReadonlyMap<string, number>;
  // Rules-trainer milestone stats (Phase 3b of `docs/plans/rules-trainer.md`).
  // A required field, not `Option`/a decoding default: every caller must
  // positively decide what these numbers are. There are exactly three
  // construction sites — `AchievementEvaluator.ts` and `AchievementPreview.ts`
  // (twice) — and making the field required is what turns a missed one into
  // a compile error instead of a silently-wrong "never earns a rules
  // achievement" bug.
  readonly rules: {
    readonly examsCompleted: number;
    readonly perfectExams: number;
    readonly packagesMastered: number;
  };
}

export interface AchievementCatalogEntry {
  readonly slug: AchievementSlug;
  readonly grantsDiscordRole: boolean;
  readonly defaultThreshold: number;
  readonly isEarned: (input: AchievementEvaluationInput, threshold: number) => boolean;
}

export const ACHIEVEMENTS: ReadonlyArray<AchievementCatalogEntry> = [
  {
    slug: 'first_activity',
    grantsDiscordRole: false,
    defaultThreshold: 1,
    isEarned: ({ stats }, threshold) => stats.totalActivities >= threshold,
  },
  {
    slug: 'ten_activities',
    grantsDiscordRole: false,
    defaultThreshold: 10,
    isEarned: ({ stats }, threshold) => stats.totalActivities >= threshold,
  },
  {
    slug: 'fifty_activities',
    grantsDiscordRole: true,
    defaultThreshold: 50,
    isEarned: ({ stats }, threshold) => stats.totalActivities >= threshold,
  },
  {
    slug: 'hundred_activities',
    grantsDiscordRole: true,
    defaultThreshold: 100,
    isEarned: ({ stats }, threshold) => stats.totalActivities >= threshold,
  },
  {
    slug: 'streak_3',
    grantsDiscordRole: false,
    defaultThreshold: 3,
    isEarned: ({ stats }, threshold) => stats.longestStreak >= threshold,
  },
  {
    slug: 'streak_7',
    grantsDiscordRole: true,
    defaultThreshold: 7,
    isEarned: ({ stats }, threshold) => stats.longestStreak >= threshold,
  },
  {
    slug: 'streak_30',
    grantsDiscordRole: true,
    defaultThreshold: 30,
    isEarned: ({ stats }, threshold) => stats.longestStreak >= threshold,
  },
  {
    slug: 'duration_600',
    grantsDiscordRole: false,
    defaultThreshold: 600,
    isEarned: ({ stats }, threshold) => stats.totalDurationMinutes >= threshold,
  },
  {
    slug: 'duration_3000',
    grantsDiscordRole: true,
    defaultThreshold: 3000,
    isEarned: ({ stats }, threshold) => stats.totalDurationMinutes >= threshold,
  },
  {
    slug: 'gym_25',
    grantsDiscordRole: false,
    defaultThreshold: 25,
    isEarned: ({ countsBySlug }, threshold) => (countsBySlug.get('gym') ?? 0) >= threshold,
  },
  {
    slug: 'running_25',
    grantsDiscordRole: false,
    defaultThreshold: 25,
    isEarned: ({ countsBySlug }, threshold) => (countsBySlug.get('running') ?? 0) >= threshold,
  },
  {
    slug: 'rules_first_exam',
    grantsDiscordRole: false,
    defaultThreshold: 1,
    isEarned: ({ rules }, threshold) => rules.examsCompleted >= threshold,
  },
  {
    slug: 'rules_perfect_exam',
    grantsDiscordRole: false,
    defaultThreshold: 1,
    isEarned: ({ rules }, threshold) => rules.perfectExams >= threshold,
  },
  {
    slug: 'rules_package_mastered',
    grantsDiscordRole: false,
    defaultThreshold: 1,
    isEarned: ({ rules }, threshold) => rules.packagesMastered >= threshold,
  },
  // The only rules-trainer slug that grants a Discord role — the plan's
  // "knows the rules" role, earned only once ALL nine packages are
  // mastered at once (see docs/plans/rules-trainer.md's Phase 3 step 15).
  {
    slug: 'rules_all_packages',
    grantsDiscordRole: true,
    defaultThreshold: 9,
    isEarned: ({ rules }, threshold) => rules.packagesMastered >= threshold,
  },
];

export const ACHIEVEMENTS_BY_SLUG: ReadonlyMap<AchievementSlug, AchievementCatalogEntry> = new Map(
  ACHIEVEMENTS.map((a) => [a.slug, a]),
);

export const effectiveThreshold = (
  slug: AchievementSlug,
  overrides: ReadonlyMap<AchievementSlug, number>,
): number => {
  const entry = ACHIEVEMENTS_BY_SLUG.get(slug);
  if (entry === undefined) {
    return 0;
  }
  return overrides.get(slug) ?? entry.defaultThreshold;
};

export const i18nTitleKey = (slug: AchievementSlug) => `achievement_${slug}_title` as const;
export const i18nDescriptionKey = (slug: AchievementSlug) =>
  `achievement_${slug}_description` as const;

export const BUILT_IN_ENGLISH_NAMES: Readonly<Record<AchievementSlug, string>> = {
  first_activity: 'First Steps',
  ten_activities: 'Getting Started',
  fifty_activities: 'Dedicated',
  hundred_activities: 'Centurion',
  streak_3: 'On Fire',
  streak_7: 'Week Warrior',
  streak_30: 'Unstoppable',
  duration_600: '10-Hour Club',
  duration_3000: '50-Hour Club',
  gym_25: 'Gym Rat',
  running_25: 'Road Runner',
  rules_first_exam: 'Rules Rookie',
  rules_perfect_exam: 'Flawless Call',
  rules_package_mastered: 'Chapter Learned',
  rules_all_packages: 'Rulebook Rat',
};

const BUILT_IN_RULE_KINDS: Readonly<Record<AchievementSlug, CustomRuleKind>> = {
  first_activity: 'total_activities',
  ten_activities: 'total_activities',
  fifty_activities: 'total_activities',
  hundred_activities: 'total_activities',
  streak_3: 'longest_streak',
  streak_7: 'longest_streak',
  streak_30: 'longest_streak',
  duration_600: 'total_duration',
  duration_3000: 'total_duration',
  gym_25: 'activity_type_count',
  running_25: 'activity_type_count',
  rules_first_exam: 'rules_exams_completed',
  rules_perfect_exam: 'rules_perfect_exams',
  rules_package_mastered: 'rules_packages_mastered',
  rules_all_packages: 'rules_packages_mastered',
};

export const builtInRuleKind = (slug: AchievementSlug): CustomRuleKind => BUILT_IN_RULE_KINDS[slug];
