import { ActivityStats, type ActivityType, type TeamMember, WeeklySummary } from '@sideline/domain';
import { type DateTime, Effect, Option } from 'effect';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WeekActivityRow = {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly activity_type_id: ActivityType.ActivityTypeId;
  readonly activity_type_name: string;
  readonly logged_at: DateTime.Utc;
  readonly duration_minutes: Option.Option<number>;
};

export type AllTimeLogRow = {
  readonly team_member_id: TeamMember.TeamMemberId;
  readonly logged_at: DateTime.Utc;
};

export type AchievementRow = {
  readonly slug: string;
  readonly earned_at: DateTime.Utc;
};

export type MemberEntry = {
  readonly id: TeamMember.TeamMemberId;
  readonly displayName: string;
};

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

const toDurationMinutes = (val: Option.Option<number>): number => Option.getOrElse(val, () => 0);

const toIsoDateString = (dt: DateTime.Utc): string => {
  const d = new Date(dt.epochMilliseconds);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

// ---------------------------------------------------------------------------
// buildPlayerSummary
// ---------------------------------------------------------------------------

export type BuildPlayerSummaryInput = {
  readonly memberId: TeamMember.TeamMemberId;
  readonly weekStart: DateTime.Utc;
  readonly weekEnd: DateTime.Utc;
  readonly weekRows: ReadonlyArray<WeekActivityRow>;
  readonly previousWeekRows: ReadonlyArray<WeekActivityRow>;
  readonly allTimeRows: ReadonlyArray<AllTimeLogRow | WeekActivityRow>;
  readonly newAchievements: ReadonlyArray<AchievementRow>;
};

export const buildPlayerSummary = (
  input: BuildPlayerSummaryInput,
): Effect.Effect<WeeklySummary.PlayerWeeklySummary> => {
  const { memberId, weekStart, weekEnd, weekRows, previousWeekRows, allTimeRows, newAchievements } =
    input;

  const memberWeekRows = weekRows.filter((r) => r.team_member_id === memberId);
  const memberPrevRows = previousWeekRows.filter((r) => r.team_member_id === memberId);
  const memberAllTimeRows = allTimeRows.filter((r) => r.team_member_id === memberId);

  // For streak computation we need all-time rows.
  // Use the week's end date as "today" so that streaks are evaluated as of the
  // end of the reporting week, not the current wall-clock time.
  const allTimeDates = memberAllTimeRows.map((r) => toIsoDateString(r.logged_at));
  const todayDate = toIsoDateString(weekEnd);
  const { currentStreak, longestStreak } = ActivityStats.calculateStreaks(allTimeDates, todayDate);

  const totalActivities = memberWeekRows.length;
  const totalDurationMinutes = memberWeekRows.reduce(
    (acc, r) => acc + toDurationMinutes(r.duration_minutes),
    0,
  );

  // activitiesByType — group by activity_type_id (only rows that have the field)
  const typeMap = new Map<ActivityType.ActivityTypeId, { name: string; count: number }>();
  for (const r of memberWeekRows) {
    if (r.activity_type_id === undefined || r.activity_type_id === null) continue;
    const existing = typeMap.get(r.activity_type_id);
    if (existing) {
      existing.count++;
    } else {
      typeMap.set(r.activity_type_id, { name: r.activity_type_name ?? '', count: 1 });
    }
  }
  const activitiesByType = Array.from(typeMap.entries()).map(
    ([id, { name, count }]) =>
      new WeeklySummary.ActivityTypeBreakdown({
        activityTypeId: id,
        activityTypeName: name,
        count,
      }),
  );

  // previousWeekActivities
  const previousWeekActivities = memberPrevRows.length;

  // Filter achievements to those inside the week window
  const filteredAchievements = newAchievements.filter(
    (a) =>
      a.earned_at.epochMilliseconds >= weekStart.epochMilliseconds &&
      a.earned_at.epochMilliseconds <= weekEnd.epochMilliseconds,
  );

  return Effect.succeed(
    new WeeklySummary.PlayerWeeklySummary({
      teamMemberId: memberId,
      totalActivities,
      totalDurationMinutes,
      activitiesByType,
      currentStreak,
      longestStreak,
      previousWeekActivities,
      newAchievements: filteredAchievements.map((a) => ({
        slug: a.slug,
        earnedAt: a.earned_at,
      })),
    }),
  );
};

// ---------------------------------------------------------------------------
// buildTeamSummary
// ---------------------------------------------------------------------------

export type BuildTeamSummaryInput = {
  readonly weekStart: DateTime.Utc;
  readonly weekEnd: DateTime.Utc;
  readonly weekRows: ReadonlyArray<WeekActivityRow>;
  readonly previousWeekRows: ReadonlyArray<WeekActivityRow>;
  readonly members: ReadonlyArray<MemberEntry>;
  readonly newAchievementsCount: number;
};

export const buildTeamSummary = (
  input: BuildTeamSummaryInput,
): Effect.Effect<WeeklySummary.TeamWeeklySummary> => {
  const { weekRows, previousWeekRows, members, newAchievementsCount } = input;

  const totalActivities = weekRows.length;
  const totalDurationMinutes = weekRows.reduce(
    (acc, r) => acc + toDurationMinutes(r.duration_minutes),
    0,
  );
  const previousWeekActivities = previousWeekRows.length;

  // Group week rows by member
  const memberActivityMap = new Map<
    TeamMember.TeamMemberId,
    { count: number; totalDuration: number }
  >();
  for (const row of weekRows) {
    const existing = memberActivityMap.get(row.team_member_id);
    if (existing) {
      existing.count++;
      existing.totalDuration += toDurationMinutes(row.duration_minutes);
    } else {
      memberActivityMap.set(row.team_member_id, {
        count: 1,
        totalDuration: toDurationMinutes(row.duration_minutes),
      });
    }
  }

  // Active member count = members who logged at least one activity this week
  const activeMemberCount = members.filter((m) => memberActivityMap.has(m.id)).length;
  const totalMemberCount = members.length;

  // Top contributors: all members with activity, sorted desc by count
  const topContributors = members
    .filter((m) => memberActivityMap.has(m.id))
    .map((m) => {
      const stats = memberActivityMap.get(m.id)!;
      return new WeeklySummary.TopContributor({
        teamMemberId: m.id,
        displayName: m.displayName,
        totalActivities: stats.count,
        totalDurationMinutes: stats.totalDuration,
      });
    })
    .sort(
      (a, b) =>
        b.totalActivities - a.totalActivities || b.totalDurationMinutes - a.totalDurationMinutes,
    );

  return Effect.succeed(
    new WeeklySummary.TeamWeeklySummary({
      totalActivities,
      totalDurationMinutes,
      activeMemberCount,
      totalMemberCount,
      topContributors,
      newAchievementsCount,
      previousWeekActivities,
    }),
  );
};
