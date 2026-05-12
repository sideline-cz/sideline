import type { Achievement } from '@sideline/domain';
import * as m from '@sideline/i18n/messages';
import type * as Discord from 'dfx/types';
import { Option } from 'effect';
import type { Locale } from '~/locale.js';

const ACHIEVEMENT_COLOR = 0xffd700; // gold

const ACHIEVEMENT_EMOJIS: Record<Achievement.AchievementSlug, string> = {
  first_activity: '🎯',
  ten_activities: '🏅',
  fifty_activities: '🥈',
  hundred_activities: '🥇',
  streak_3: '🔥',
  streak_7: '⚡',
  streak_30: '💎',
  duration_600: '⏱️',
  duration_3000: '🏆',
  gym_25: '💪',
  running_25: '🏃',
};

const TITLE_MESSAGES: Record<Achievement.AchievementSlug, (locale: Locale) => string> = {
  first_activity: (locale) => m.achievement_first_activity_title({}, { locale }),
  ten_activities: (locale) => m.achievement_ten_activities_title({}, { locale }),
  fifty_activities: (locale) => m.achievement_fifty_activities_title({}, { locale }),
  hundred_activities: (locale) => m.achievement_hundred_activities_title({}, { locale }),
  streak_3: (locale) => m.achievement_streak_3_title({}, { locale }),
  streak_7: (locale) => m.achievement_streak_7_title({}, { locale }),
  streak_30: (locale) => m.achievement_streak_30_title({}, { locale }),
  duration_600: (locale) => m.achievement_duration_600_title({}, { locale }),
  duration_3000: (locale) => m.achievement_duration_3000_title({}, { locale }),
  gym_25: (locale) => m.achievement_gym_25_title({}, { locale }),
  running_25: (locale) => m.achievement_running_25_title({}, { locale }),
};

const DESCRIPTION_MESSAGES: Record<Achievement.AchievementSlug, (locale: Locale) => string> = {
  first_activity: (locale) => m.achievement_first_activity_description({}, { locale }),
  ten_activities: (locale) => m.achievement_ten_activities_description({}, { locale }),
  fifty_activities: (locale) => m.achievement_fifty_activities_description({}, { locale }),
  hundred_activities: (locale) => m.achievement_hundred_activities_description({}, { locale }),
  streak_3: (locale) => m.achievement_streak_3_description({}, { locale }),
  streak_7: (locale) => m.achievement_streak_7_description({}, { locale }),
  streak_30: (locale) => m.achievement_streak_30_description({}, { locale }),
  duration_600: (locale) => m.achievement_duration_600_description({}, { locale }),
  duration_3000: (locale) => m.achievement_duration_3000_description({}, { locale }),
  gym_25: (locale) => m.achievement_gym_25_description({}, { locale }),
  running_25: (locale) => m.achievement_running_25_description({}, { locale }),
};

export const buildAchievementEmbed = (opts: {
  slug: Achievement.AchievementSlug;
  discord_user_id: string;
  discord_role_id: Option.Option<string>;
  earned_at: Date;
  locale: Locale;
}): Discord.RichEmbed => {
  const emoji = ACHIEVEMENT_EMOJIS[opts.slug];
  const titleText = TITLE_MESSAGES[opts.slug](opts.locale);
  const descriptionText = DESCRIPTION_MESSAGES[opts.slug](opts.locale);
  const earnedUnix = Math.floor(opts.earned_at.getTime() / 1000);

  const fields: Array<Discord.RichEmbedField> = [
    { name: 'Player', value: `<@${opts.discord_user_id}>`, inline: true },
    { name: 'Earned', value: `<t:${earnedUnix}:R>`, inline: true },
  ];

  Option.match(opts.discord_role_id, {
    onNone: () => undefined,
    onSome: (roleId) => {
      fields.push({ name: 'Role Granted', value: `<@&${roleId}>`, inline: true });
    },
  });

  return {
    title: `${emoji} Achievement Unlocked: ${titleText}`,
    description: descriptionText,
    color: ACHIEVEMENT_COLOR,
    fields,
    footer: { text: 'Sideline · Achievements' },
    timestamp: opts.earned_at.toISOString(),
  };
};
