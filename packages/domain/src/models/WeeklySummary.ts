import { DateTime, Schema } from 'effect';
import * as ActivityType from '~/models/ActivityType.js';
import * as TeamMember from '~/models/TeamMember.js';

export class WeekRange extends Schema.Class<WeekRange>('WeekRange')({
  startAt: Schema.DateTimeUtc,
  endAt: Schema.DateTimeUtc,
  isoYear: Schema.Int,
  isoWeek: Schema.Int,
}) {}

export class TopContributor extends Schema.Class<TopContributor>('TopContributor')({
  teamMemberId: TeamMember.TeamMemberId,
  displayName: Schema.String,
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
}) {}

export class ActivityTypeBreakdown extends Schema.Class<ActivityTypeBreakdown>(
  'ActivityTypeBreakdown',
)({
  activityTypeId: ActivityType.ActivityTypeId,
  activityTypeName: Schema.String,
  count: Schema.Int,
}) {}

export class PlayerWeeklySummary extends Schema.Class<PlayerWeeklySummary>('PlayerWeeklySummary')({
  teamMemberId: TeamMember.TeamMemberId,
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
  activitiesByType: Schema.Array(ActivityTypeBreakdown),
  currentStreak: Schema.Int,
  longestStreak: Schema.Int,
  previousWeekActivities: Schema.Int,
  newAchievements: Schema.Array(
    Schema.Struct({ slug: Schema.String, earnedAt: Schema.DateTimeUtc }),
  ),
}) {}

export class TeamWeeklySummary extends Schema.Class<TeamWeeklySummary>('TeamWeeklySummary')({
  totalActivities: Schema.Int,
  totalDurationMinutes: Schema.Int,
  activeMemberCount: Schema.Int,
  totalMemberCount: Schema.Int,
  topContributors: Schema.Array(TopContributor),
  newAchievementsCount: Schema.Int,
  previousWeekActivities: Schema.Int,
}) {}

export class WeeklySummaryResponse extends Schema.Class<WeeklySummaryResponse>(
  'WeeklySummaryResponse',
)({
  week: WeekRange,
  player: Schema.NullOr(PlayerWeeklySummary),
  team: Schema.NullOr(TeamWeeklySummary),
}) {}

/**
 * Shared payload schema for the weekly_summary_sync_events queue.
 * The cron encodes this; the bot handler decodes it.
 */
export class WeeklySummaryDigest extends Schema.Class<WeeklySummaryDigest>('WeeklySummaryDigest')({
  week: WeekRange,
  teamSummary: TeamWeeklySummary,
}) {}

/**
 * Compute the ISO week number for a given local date.
 * ISO weeks start on Monday; the first week of the year contains the first Thursday.
 */
const computeIsoWeek = (
  year: number,
  month: number,
  day: number,
): { isoYear: number; isoWeek: number } => {
  // day is 1-based, month is 1-based
  const date = new Date(Date.UTC(year, month - 1, day));
  // ISO day of week: 1=Mon, ..., 7=Sun
  const dow = date.getUTCDay() === 0 ? 7 : date.getUTCDay();
  // Find the Thursday of this ISO week (shift current day to the Thursday of the same week)
  const thursday = new Date(date.getTime() + (4 - dow) * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  const isoWeek = Math.ceil(((thursday.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return { isoYear, isoWeek };
};

/**
 * Returns the ISO week range (Monday 00:00 → Sunday 23:59:59.999 in local time,
 * converted back to UTC) for the week containing `now` interpreted in `timezone`.
 */
export const weekRangeFor = (now: DateTime.Utc, timezone: string): WeekRange => {
  const tz = DateTime.zoneMakeNamedUnsafe(timezone);
  const zoned = DateTime.setZone(now, tz);
  // weekDay: 1=Mon, 2=Tue, ..., 6=Sat, 0=Sun
  const weekDay = DateTime.getPart(zoned, 'weekDay');
  const daysSinceMonday = weekDay === 0 ? 6 : weekDay - 1;

  const mondayZoned = DateTime.setParts(DateTime.add(zoned, { days: -daysSinceMonday }), {
    hour: 0,
    minute: 0,
    second: 0,
    millisecond: 0,
  });
  const sundayZoned = DateTime.setParts(DateTime.add(mondayZoned, { days: 6 }), {
    hour: 23,
    minute: 59,
    second: 59,
    millisecond: 999,
  });

  const startAt = DateTime.makeUnsafe(mondayZoned.epochMilliseconds);
  const endAt = DateTime.makeUnsafe(sundayZoned.epochMilliseconds);

  // Compute ISO week number from the local Monday date
  const mondayYear = DateTime.getPart(mondayZoned, 'year');
  const mondayMonth = DateTime.getPart(mondayZoned, 'month');
  const mondayDay = DateTime.getPart(mondayZoned, 'day');
  const { isoYear, isoWeek } = computeIsoWeek(mondayYear, mondayMonth, mondayDay);

  return new WeekRange({ startAt, endAt, isoYear, isoWeek });
};

/**
 * Returns the ISO week range immediately before the given week.
 */
export const previousWeekRange = (week: WeekRange, timezone: string): WeekRange => {
  // Subtract one day from startAt to get a moment in the previous week
  const prevWeekUtc = DateTime.makeUnsafe(week.startAt.epochMilliseconds - 86400000);
  return weekRangeFor(prevWeekUtc, timezone);
};
