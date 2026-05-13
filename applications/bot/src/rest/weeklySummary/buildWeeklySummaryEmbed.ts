import type { TeamMember } from '@sideline/domain';
import type { DateTime } from 'effect';
import type { Locale } from '~/locale.js';

const ACTIVE_COLOR = 0x57f287; // green
const EMPTY_COLOR = 0x99aab5; // grey
const FOOTER_TEXT = 'Sideline · Weekly recap';

const formatDuration = (minutes: number): string => {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
};

const formatDate = (dt: DateTime.Utc, locale: Locale): string => {
  const ms = dt.epochMilliseconds;
  const date = new Date(ms);
  return date.toLocaleDateString(locale === 'en' ? 'en-GB' : locale, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
};

export type TopContributorInput = {
  readonly teamMemberId: TeamMember.TeamMemberId;
  readonly displayName: string;
  readonly totalActivities: number;
  readonly totalDurationMinutes: number;
};

export type TeamSummaryInput = {
  readonly totalActivities: number;
  readonly totalDurationMinutes: number;
  readonly activeMemberCount: number;
  readonly totalMemberCount: number;
  readonly topContributors: ReadonlyArray<TopContributorInput>;
  readonly newAchievementsCount: number;
  readonly previousWeekActivities: number;
};

export type WeeklySummaryDigest = {
  readonly week: {
    readonly startAt: DateTime.Utc;
    readonly endAt: DateTime.Utc;
    readonly isoYear: number;
    readonly isoWeek: number;
  };
  readonly teamSummary: TeamSummaryInput;
  readonly locale: Locale;
};

// Stricter field/embed types (no null, only strict undefined-optional)
export type SummaryEmbedField = {
  readonly name: string;
  readonly value: string;
  readonly inline?: boolean;
};

export type SummaryEmbed = {
  readonly title?: string;
  readonly description?: string;
  readonly color?: number;
  readonly fields?: Array<SummaryEmbedField>;
  readonly footer?: { readonly text: string };
};

const MEDAL: Record<number, string> = {
  0: '🥇',
  1: '🥈',
  2: '🥉',
};

export const buildWeeklySummaryEmbed = (
  payload: WeeklySummaryDigest,
): { embeds: Array<SummaryEmbed> } => {
  const { week, teamSummary, locale } = payload;
  const {
    totalActivities,
    totalDurationMinutes,
    activeMemberCount,
    totalMemberCount,
    topContributors,
    newAchievementsCount,
    previousWeekActivities,
  } = teamSummary;

  const weekLabel = `W${String(week.isoWeek).padStart(2, '0')} ${week.isoYear}`;
  const startLabel = formatDate(week.startAt, locale);
  const endLabel = formatDate(week.endAt, locale);

  const title = `🏁 Team Makáníčko — ${weekLabel}`;

  const isEmpty = totalActivities === 0;
  const color = isEmpty ? EMPTY_COLOR : ACTIVE_COLOR;

  const delta = totalActivities - previousWeekActivities;
  const deltaStr = delta > 0 ? `+${delta}` : delta < 0 ? `${delta}` : `+0`;

  const fields: Array<SummaryEmbedField> = [];

  if (isEmpty) {
    fields.push({
      name: '😴 Quiet week',
      value: "Quiet week — let's get moving!",
      inline: false,
    });
  } else {
    // Top contributors (top 3)
    const top3 = topContributors.slice(0, 3);
    const contributorLines = top3
      .map((c, i) => {
        const medal = MEDAL[i] ?? `${i + 1}.`;
        return `${medal} **${c.displayName}** — ${c.totalActivities} activities (${formatDuration(c.totalDurationMinutes)})`;
      })
      .join('\n');

    fields.push({
      name: '🥇 Top contributors',
      value: contributorLines,
      inline: false,
    });

    if (newAchievementsCount > 0) {
      fields.push({
        name: '🏆 Achievements',
        value: `${newAchievementsCount} new achievement${newAchievementsCount === 1 ? '' : 's'} earned this week`,
        inline: true,
      });
    }

    fields.push({
      name: '📈 vs last week',
      value: `${deltaStr} activities`,
      inline: true,
    });
  }

  const baseEmbed = {
    title,
    color,
    fields,
    footer: { text: FOOTER_TEXT },
  } satisfies SummaryEmbed;

  const embed: SummaryEmbed = isEmpty
    ? baseEmbed
    : {
        ...baseEmbed,
        description: `${startLabel} – ${endLabel}\n${totalActivities} activities · ${formatDuration(totalDurationMinutes)}\n${activeMemberCount} of ${totalMemberCount} members logged`,
      };

  return { embeds: [embed] };
};
