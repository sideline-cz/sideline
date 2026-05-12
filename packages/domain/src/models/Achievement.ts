import { Schema } from 'effect';
import type * as ActivityStats from './ActivityStats.js';

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
]);
export type AchievementSlug = typeof AchievementSlug.Type;

export interface AchievementEvaluationInput {
  readonly stats: ActivityStats.StatsResult;
  readonly countsBySlug: ReadonlyMap<string, number>;
}

export interface AchievementCatalogEntry {
  readonly slug: AchievementSlug;
  readonly grantsDiscordRole: boolean;
  readonly isEarned: (input: AchievementEvaluationInput) => boolean;
}

export const ACHIEVEMENTS: ReadonlyArray<AchievementCatalogEntry> = [
  {
    slug: 'first_activity',
    grantsDiscordRole: false,
    isEarned: ({ stats }) => stats.totalActivities >= 1,
  },
  {
    slug: 'ten_activities',
    grantsDiscordRole: false,
    isEarned: ({ stats }) => stats.totalActivities >= 10,
  },
  {
    slug: 'fifty_activities',
    grantsDiscordRole: true,
    isEarned: ({ stats }) => stats.totalActivities >= 50,
  },
  {
    slug: 'hundred_activities',
    grantsDiscordRole: true,
    isEarned: ({ stats }) => stats.totalActivities >= 100,
  },
  { slug: 'streak_3', grantsDiscordRole: false, isEarned: ({ stats }) => stats.longestStreak >= 3 },
  { slug: 'streak_7', grantsDiscordRole: true, isEarned: ({ stats }) => stats.longestStreak >= 7 },
  {
    slug: 'streak_30',
    grantsDiscordRole: true,
    isEarned: ({ stats }) => stats.longestStreak >= 30,
  },
  {
    slug: 'duration_600',
    grantsDiscordRole: false,
    isEarned: ({ stats }) => stats.totalDurationMinutes >= 600,
  },
  {
    slug: 'duration_3000',
    grantsDiscordRole: true,
    isEarned: ({ stats }) => stats.totalDurationMinutes >= 3000,
  },
  {
    slug: 'gym_25',
    grantsDiscordRole: false,
    isEarned: ({ countsBySlug }) => (countsBySlug.get('gym') ?? 0) >= 25,
  },
  {
    slug: 'running_25',
    grantsDiscordRole: false,
    isEarned: ({ countsBySlug }) => (countsBySlug.get('running') ?? 0) >= 25,
  },
];

export const ACHIEVEMENTS_BY_SLUG: ReadonlyMap<AchievementSlug, AchievementCatalogEntry> = new Map(
  ACHIEVEMENTS.map((a) => [a.slug, a]),
);

export const i18nTitleKey = (slug: AchievementSlug) => `achievement_${slug}_title` as const;
export const i18nDescriptionKey = (slug: AchievementSlug) =>
  `achievement_${slug}_description` as const;
