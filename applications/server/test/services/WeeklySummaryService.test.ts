import { describe, expect, it } from '@effect/vitest';
import type { ActivityType, TeamMember } from '@sideline/domain';
import { DateTime, Effect, Option } from 'effect';
import { buildPlayerSummary, buildTeamSummary } from '~/services/WeeklySummaryService.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const MEMBER_A = '00000000-0000-0000-0000-000000000001' as TeamMember.TeamMemberId;
const MEMBER_B = '00000000-0000-0000-0000-000000000002' as TeamMember.TeamMemberId;
const MEMBER_C = '00000000-0000-0000-0000-000000000003' as TeamMember.TeamMemberId;

const GYM_TYPE_ID = 'type-gym-001' as ActivityType.ActivityTypeId;
const RUN_TYPE_ID = 'type-run-001' as ActivityType.ActivityTypeId;

// Week range: 2026-W02 Mon 2026-01-05 – Sun 2026-01-11 (Prague, UTC+1)
const WEEK_START = DateTime.makeUnsafe('2026-01-04T23:00:00.000Z'); // Mon 00:00 Prague
const WEEK_END = DateTime.makeUnsafe('2026-01-11T22:59:59.999Z'); // Sun 23:59 Prague

// ---------------------------------------------------------------------------
// Type definitions (mirrors what WeeklySummaryService will expose)
// ---------------------------------------------------------------------------

type WeekActivityRow = {
  team_member_id: TeamMember.TeamMemberId;
  activity_type_id: ActivityType.ActivityTypeId;
  activity_type_name: string;
  logged_at: DateTime.Utc;
  duration_minutes: Option.Option<number>;
};

type AchievementRow = {
  slug: string;
  earned_at: DateTime.Utc;
};

type AllTimeLogRow = {
  team_member_id: TeamMember.TeamMemberId;
  logged_at: DateTime.Utc;
};

const callBuildPlayerSummary = buildPlayerSummary;
const callBuildTeamSummary = buildTeamSummary;

// ---------------------------------------------------------------------------
// buildPlayerSummary tests
// ---------------------------------------------------------------------------

describe('buildPlayerSummary', () => {
  it.effect('computes totalActivities and totalDurationMinutes from week rows', () => {
    const weekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-08T08:00:00Z'),
        duration_minutes: Option.some(30),
      },
    ];

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      allTimeRows: weekRows,
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.totalActivities).toBe(2);
          expect(result.totalDurationMinutes).toBe(90);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('returns 0 for previousWeekActivities when prior week has no logs', () => {
    const weekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
    ];

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      allTimeRows: weekRows,
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.previousWeekActivities).toBe(0);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('returns positive delta when this week has more activities than prior', () => {
    const weekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-08T08:00:00Z'),
        duration_minutes: Option.some(30),
      },
    ];

    const previousWeekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2025-12-30T10:00:00Z'),
        duration_minutes: Option.some(45),
      },
    ];

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows,
      allTimeRows: [...weekRows, ...previousWeekRows],
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // This week: 2, previous: 1 → delta should be +1
          expect(result.totalActivities).toBe(2);
          expect(result.previousWeekActivities).toBe(1);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('includes only achievements with earnedAt inside the week range', () => {
    const inWeekAchievement: AchievementRow = {
      slug: 'first-gym',
      earned_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'), // inside week
    };
    const outOfWeekAchievement: AchievementRow = {
      slug: 'veteran',
      earned_at: DateTime.makeUnsafe('2025-12-01T10:00:00Z'), // before week
    };

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows: [],
      previousWeekRows: [],
      allTimeRows: [],
      newAchievements: [inWeekAchievement, outOfWeekAchievement],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.newAchievements).toHaveLength(1);
          expect(result.newAchievements[0].slug).toBe('first-gym');
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('computes currentStreak and longestStreak from all-time logs', () => {
    // Consecutive days: Jan 4, 5, 6, 7, 8 = 5 days streak ending on Jan 8
    // WEEK_END = Sun 2026-01-11 22:59:59 UTC.
    // The streak "today" is computed as WEEK_END (Jan 11 UTC).
    // Last activity was Jan 8 — that is 3 days before Jan 11 → currentStreak should be 0
    // because the streak is broken (no activity Jan 9, 10, or 11).
    const allTimeRows: AllTimeLogRow[] = [
      {
        team_member_id: MEMBER_A,
        logged_at: DateTime.makeUnsafe('2026-01-04T10:00:00Z'),
      },
      {
        team_member_id: MEMBER_A,
        logged_at: DateTime.makeUnsafe('2026-01-05T10:00:00Z'),
      },
      {
        team_member_id: MEMBER_A,
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
      },
      {
        team_member_id: MEMBER_A,
        logged_at: DateTime.makeUnsafe('2026-01-07T10:00:00Z'),
      },
      {
        team_member_id: MEMBER_A,
        logged_at: DateTime.makeUnsafe('2026-01-08T10:00:00Z'),
      },
    ];

    const weekRows: WeekActivityRow[] = allTimeRows
      .filter(
        (r) =>
          r.logged_at.epochMilliseconds >= WEEK_START.epochMilliseconds &&
          r.logged_at.epochMilliseconds <= WEEK_END.epochMilliseconds,
      )
      .map((r) => ({
        team_member_id: r.team_member_id,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: r.logged_at,
        duration_minutes: Option.none(),
      }));

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      allTimeRows,
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          // longestStreak spans Jan 4–8 = 5 consecutive days
          expect(result.longestStreak).toBe(5);
          // currentStreak: "today" is WEEK_END (Jan 11). Last log was Jan 8, so gap = 3 days → broken
          expect(result.currentStreak).toBe(0);
          expect(result.longestStreak).toBeGreaterThanOrEqual(result.currentStreak);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('returns empty activitiesByType when no logs this week', () =>
    callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows: [],
      previousWeekRows: [],
      allTimeRows: [],
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.totalActivities).toBe(0);
          expect(result.totalDurationMinutes).toBe(0);
          expect(result.activitiesByType).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    ),
  );

  it.effect('groups activitiesByType correctly when multiple types are logged', () => {
    const weekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-07T10:00:00Z'),
        duration_minutes: Option.some(45),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-08T08:00:00Z'),
        duration_minutes: Option.some(30),
      },
    ];

    return callBuildPlayerSummary({
      memberId: MEMBER_A,
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      allTimeRows: weekRows,
      newAchievements: [],
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activitiesByType).toHaveLength(2);
          const gymEntry = result.activitiesByType.find(
            (t: any) => t.activityTypeId === GYM_TYPE_ID,
          );
          expect(gymEntry?.count).toBe(2);
          const runEntry = result.activitiesByType.find(
            (t: any) => t.activityTypeId === RUN_TYPE_ID,
          );
          expect(runEntry?.count).toBe(1);
        }),
      ),
      Effect.asVoid,
    );
  });
});

// ---------------------------------------------------------------------------
// buildTeamSummary tests
// ---------------------------------------------------------------------------

describe('buildTeamSummary', () => {
  it.effect('returns top 3 contributors ordered by total activities desc', () => {
    const weekRows: WeekActivityRow[] = [
      // Member A: 3 activities
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-07T10:00:00Z'),
        duration_minutes: Option.some(30),
      },
      {
        team_member_id: MEMBER_A,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-08T10:00:00Z'),
        duration_minutes: Option.some(30),
      },
      // Member B: 5 activities
      {
        team_member_id: MEMBER_B,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-05T08:00:00Z'),
        duration_minutes: Option.some(30),
      },
      {
        team_member_id: MEMBER_B,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T08:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_B,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-07T08:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_B,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-08T08:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_B,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-09T08:00:00Z'),
        duration_minutes: Option.some(60),
      },
      // Member C: 1 activity
      {
        team_member_id: MEMBER_C,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2026-01-10T08:00:00Z'),
        duration_minutes: Option.some(20),
      },
    ];

    const members = [
      { id: MEMBER_A, displayName: 'Alice' },
      { id: MEMBER_B, displayName: 'Bob' },
      { id: MEMBER_C, displayName: 'Carol' },
    ];

    return callBuildTeamSummary({
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      members,
      newAchievementsCount: 0,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.topContributors).toHaveLength(3);
          expect(result.topContributors[0].teamMemberId).toBe(MEMBER_B);
          expect(result.topContributors[0].totalActivities).toBe(5);
          expect(result.topContributors[1].teamMemberId).toBe(MEMBER_A);
          expect(result.topContributors[1].totalActivities).toBe(3);
          expect(result.topContributors[2].teamMemberId).toBe(MEMBER_C);
          expect(result.topContributors[2].totalActivities).toBe(1);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('activeMemberCount counts only members with 1 or more logs this week', () => {
    const weekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      // Member B has no logs this week
    ];

    const members = [
      { id: MEMBER_A, displayName: 'Alice' },
      { id: MEMBER_B, displayName: 'Bob' },
    ];

    return callBuildTeamSummary({
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows,
      previousWeekRows: [],
      members,
      newAchievementsCount: 0,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activeMemberCount).toBe(1);
          expect(result.totalMemberCount).toBe(2);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('newAchievementsCount reflects passed-in count', () => {
    const members = [{ id: MEMBER_A, displayName: 'Alice' }];

    return callBuildTeamSummary({
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows: [],
      previousWeekRows: [],
      members,
      newAchievementsCount: 7,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.newAchievementsCount).toBe(7);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('previousWeekActivities sums team prior week totals', () => {
    const previousWeekRows: WeekActivityRow[] = [
      {
        team_member_id: MEMBER_A,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2025-12-30T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
      {
        team_member_id: MEMBER_B,
        activity_type_id: RUN_TYPE_ID,
        activity_type_name: 'Running',
        logged_at: DateTime.makeUnsafe('2025-12-31T10:00:00Z'),
        duration_minutes: Option.some(30),
      },
    ];

    const members = [
      { id: MEMBER_A, displayName: 'Alice' },
      { id: MEMBER_B, displayName: 'Bob' },
    ];

    return callBuildTeamSummary({
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows: [],
      previousWeekRows,
      members,
      newAchievementsCount: 0,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.previousWeekActivities).toBe(2);
        }),
      ),
      Effect.asVoid,
    );
  });

  it.effect('returns zero totals when no logs exist this week', () => {
    const members = [
      { id: MEMBER_A, displayName: 'Alice' },
      { id: MEMBER_B, displayName: 'Bob' },
    ];

    return callBuildTeamSummary({
      weekStart: WEEK_START,
      weekEnd: WEEK_END,
      weekRows: [],
      previousWeekRows: [],
      members,
      newAchievementsCount: 0,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.totalActivities).toBe(0);
          expect(result.activeMemberCount).toBe(0);
          expect(result.topContributors).toHaveLength(0);
        }),
      ),
      Effect.asVoid,
    );
  });
});
