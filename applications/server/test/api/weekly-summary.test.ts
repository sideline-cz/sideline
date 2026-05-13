import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { ActivityType, Auth, Role, Team, TeamMember } from '@sideline/domain';
import { WeeklySummaryApi } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Result } from 'effect';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamSettingsRepository } from '~/repositories/TeamSettingsRepository.js';
import { WeeklySummaryRepository } from '~/repositories/WeeklySummaryRepository.js';
import { getWeeklySummaryHandler } from '~/services/WeeklySummaryHandler.js';

// ---------------------------------------------------------------------------
// Test IDs
// ---------------------------------------------------------------------------

const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_OUTSIDER_USER_ID = '00000000-0000-0000-0000-000000000099' as Auth.UserId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_MEMBER_ID_2 = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const GYM_TYPE_ID = 'type-gym-001' as ActivityType.ActivityTypeId;

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];
const CAPTAIN_PERMISSIONS: readonly Role.Permission[] = [
  'roster:view',
  'roster:manage',
  'member:view',
  'member:edit',
];

// ---------------------------------------------------------------------------
// In-memory stores
// ---------------------------------------------------------------------------

type WeekActivityRow = {
  team_member_id: TeamMember.TeamMemberId;
  activity_type_id: ActivityType.ActivityTypeId;
  activity_type_name: string;
  logged_at: DateTime.Utc;
  duration_minutes: Option.Option<number>;
};

let weekActivityRows: WeekActivityRow[];

const resetStores = () => {
  weekActivityRows = [];
};

// ---------------------------------------------------------------------------
// Mock TeamSettingsRepository (returns 'Europe/Prague' timezone)
// ---------------------------------------------------------------------------

const MockTeamSettingsRepositoryLayer = Layer.succeed(TeamSettingsRepository, {
  findByTeamId: () =>
    Effect.succeed(
      Option.some({
        timezone: 'Europe/Prague',
      }),
    ),
  findAllWithWeeklySummaryChannel: () => Effect.succeed([]),
  upsert: () => Effect.die(new Error('Not implemented')),
  getHorizonDays: () => Effect.succeed(30),
  findLateRsvpChannelId: () => Effect.succeed(Option.none()),
  findEventsNeedingReminder: () => Effect.succeed([]),
} as any);

// ---------------------------------------------------------------------------
// Mock layers
// ---------------------------------------------------------------------------

const MockPlayerTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: TEST_USER_ID,
          active: true,
          role_names: ['Player'],
          permissions: PLAYER_PERMISSIONS,
        } as MembershipWithRole),
      );
    return Effect.succeed(Option.none());
  },
  findByTeam: () => Effect.succeed([]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockCaptainTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: TEST_USER_ID,
          active: true,
          role_names: ['Captain'],
          permissions: CAPTAIN_PERMISSIONS,
        } as MembershipWithRole),
      );
    return Effect.succeed(Option.none());
  },
  findByTeam: () =>
    Effect.succeed([
      { id: TEST_MEMBER_ID, team_id: TEST_TEAM_ID, user_id: TEST_USER_ID, active: true },
      {
        id: TEST_MEMBER_ID_2,
        team_id: TEST_TEAM_ID,
        user_id: '00000000-0000-0000-0000-000000000002',
        active: true,
      },
    ]),
  findByUser: () => Effect.succeed([]),
  findRosterByTeam: () => Effect.succeed([]),
  findRosterMemberByIds: () => Effect.succeed(Option.none()),
  addMember: () => Effect.die(new Error('Not implemented')),
  deactivateMemberByIds: () => Effect.die(new Error('Not implemented')),
  getPlayerRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockWeeklySummaryRepositoryLayer = Layer.succeed(WeeklySummaryRepository, {
  findPlayerWeekActivity: (
    _teamId: Team.TeamId,
    memberId: TeamMember.TeamMemberId,
    _weekStart: DateTime.Utc,
    _weekEnd: DateTime.Utc,
  ) => {
    const rows = weekActivityRows.filter((r) => r.team_member_id === memberId);
    return Effect.succeed(rows);
  },
  findPlayerActivityCountInRange: (_memberId: TeamMember.TeamMemberId) => Effect.succeed(0),
  findTeamWeekActivity: (_teamId: Team.TeamId, _weekStart: DateTime.Utc, _weekEnd: DateTime.Utc) =>
    Effect.succeed(weekActivityRows),
  findTeamNewAchievementCountInRange: () => Effect.succeed(0),
  findNewAchievementsInRange: (
    _teamId: Team.TeamId,
    _weekStart: DateTime.Utc,
    _weekEnd: DateTime.Utc,
  ) => Effect.succeed([]),
  findAllTimeLogsForMember: (_memberId: TeamMember.TeamMemberId) => Effect.succeed([]),
  hasDeliveredSummaryForWeek: () => Effect.succeed(false),
} as any);

const MockPlayerProvideLayer = Layer.mergeAll(
  MockPlayerTeamMembersRepositoryLayer,
  MockWeeklySummaryRepositoryLayer,
  MockTeamSettingsRepositoryLayer,
);

const MockCaptainProvideLayer = Layer.mergeAll(
  MockCaptainTeamMembersRepositoryLayer,
  MockWeeklySummaryRepositoryLayer,
  MockTeamSettingsRepositoryLayer,
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getWeeklySummaryHandler', () => {
  it.effect('returns 401 Forbidden when caller is not a member of the team', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_OUTSIDER_USER_ID,
      week: Option.none(),
      includeTeam: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result: any) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (result._tag === 'Failure') {
            expect(result.failure._tag).toBe('WeeklySummaryForbidden');
          }
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns player section for caller own member id', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.none(),
      includeTeam: Option.none(),
    }).pipe(
      Effect.tap((result: any) =>
        Effect.sync(() => {
          expect(result.player).not.toBeNull();
          expect(result.player?.teamMemberId).toBe(TEST_MEMBER_ID);
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns team: null when caller lacks roster:manage permission (Player role)', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.none(),
      includeTeam: Option.some(true),
    }).pipe(
      Effect.tap((result: any) =>
        Effect.sync(() => {
          // Player does not have roster:manage → team section should be null
          expect(result.team).toBeNull();
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns team section when caller has roster:manage (Captain role)', () => {
    // Seed activity rows so topContributors and activeMemberCount are non-zero
    weekActivityRows = [
      {
        team_member_id: TEST_MEMBER_ID,
        activity_type_id: GYM_TYPE_ID,
        activity_type_name: 'Gym',
        logged_at: DateTime.makeUnsafe('2026-01-06T10:00:00Z'),
        duration_minutes: Option.some(60),
      },
    ];

    return getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.some('2026-W02'),
      includeTeam: Option.some(true),
    }).pipe(
      Effect.tap((result: any) =>
        Effect.sync(() => {
          // Captain has roster:manage → team section should be populated
          expect(result.team).not.toBeNull();
          expect(result.team?.activeMemberCount).toBeGreaterThan(0);
          expect(result.team?.topContributors.length).toBeGreaterThan(0);
        }),
      ),
      Effect.provide(MockCaptainProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('returns the historical week range when ?week=2026-W02 is provided', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.some('2026-W02'),
      includeTeam: Option.none(),
    }).pipe(
      Effect.tap((result: any) =>
        Effect.sync(() => {
          expect(result.week.isoYear).toBe(2026);
          expect(result.week.isoWeek).toBe(2);
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns ParseError when ?week=invalid is provided', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.some('invalid-week'),
      includeTeam: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result: any) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (result._tag === 'Failure') {
            // Should be a ParseError or a WeeklySummaryNotFound/validation error
            const tag = result.failure._tag;
            expect(['ParseError', 'WeeklySummaryNotFound', 'WeeklySummaryForbidden']).toContain(
              tag,
            );
          }
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('week response contains correct ISO week fields', () =>
    getWeeklySummaryHandler({
      teamId: TEST_TEAM_ID,
      currentUserId: TEST_USER_ID,
      week: Option.none(),
      includeTeam: Option.none(),
    }).pipe(
      Effect.tap((result: any) =>
        Effect.sync(() => {
          expect(result.week).toBeDefined();
          expect(typeof result.week.isoYear).toBe('number');
          expect(typeof result.week.isoWeek).toBe('number');
          expect(result.week.isoWeek).toBeGreaterThanOrEqual(1);
          expect(result.week.isoWeek).toBeLessThanOrEqual(53);
        }),
      ),
      Effect.provide(MockPlayerProvideLayer),
      Effect.asVoid,
    ),
  );
});

// Verify the error classes from the domain package exist correctly
describe('WeeklySummaryApi error classes', () => {
  it('WeeklySummaryForbidden has correct tag', () => {
    const err = new WeeklySummaryApi.WeeklySummaryForbidden();
    expect(err._tag).toBe('WeeklySummaryForbidden');
  });

  it('WeeklySummaryNotFound has correct tag', () => {
    const err = new WeeklySummaryApi.WeeklySummaryNotFound();
    expect(err._tag).toBe('WeeklySummaryNotFound');
  });
});
