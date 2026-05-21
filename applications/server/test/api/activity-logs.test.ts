import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { ActivityLog, ActivityType, Auth, Role, Team, TeamMember } from '@sideline/domain';
import { ActivityLogApi, ActivityLogDate } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Result } from 'effect';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import type { MembershipWithRole } from '~/repositories/TeamMembersRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';

// --- Test IDs ---
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_USER_ID = '00000000-0000-0000-0000-000000000001' as Auth.UserId;
const TEST_OTHER_USER_ID = '00000000-0000-0000-0000-000000000002' as Auth.UserId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_OTHER_MEMBER_ID = '00000000-0000-0000-0000-000000000021' as TeamMember.TeamMemberId;
const TEST_LOG_ID_1 = 'log-uuid-001' as ActivityLog.ActivityLogId;
const TEST_LOG_ID_2 = 'log-uuid-002' as ActivityLog.ActivityLogId;
const TEST_NONEXISTENT_LOG_ID = 'log-uuid-999' as ActivityLog.ActivityLogId;

const GYM_TYPE_ID = 'type-uuid-gym' as ActivityType.ActivityTypeId;
const RUNNING_TYPE_ID = 'type-uuid-running' as ActivityType.ActivityTypeId;

const PLAYER_PERMISSIONS: readonly Role.Permission[] = ['roster:view', 'member:view'];

// --- In-memory stores ---
type ActivityLogRecord = {
  id: ActivityLog.ActivityLogId;
  team_member_id: TeamMember.TeamMemberId;
  activity_type_id: ActivityType.ActivityTypeId;
  activity_type_name: string;
  logged_at: string;
  duration_minutes: Option.Option<number>;
  note: Option.Option<string>;
  source: ActivityLog.ActivitySource;
};

let activityLogsStore: Map<ActivityLog.ActivityLogId, ActivityLogRecord>;

const resetStores = () => {
  activityLogsStore = new Map();
  activityLogsStore.set(TEST_LOG_ID_1, {
    id: TEST_LOG_ID_1,
    team_member_id: TEST_MEMBER_ID,
    activity_type_id: GYM_TYPE_ID,
    activity_type_name: 'Gym',
    logged_at: '2026-03-25T10:00:00.000Z',
    duration_minutes: Option.some(60),
    note: Option.some('Leg day'),
    source: 'manual',
  });
  activityLogsStore.set(TEST_LOG_ID_2, {
    id: TEST_LOG_ID_2,
    team_member_id: TEST_MEMBER_ID,
    activity_type_id: RUNNING_TYPE_ID,
    activity_type_name: 'Run',
    logged_at: '2026-03-26T08:00:00.000Z',
    duration_minutes: Option.none(),
    note: Option.none(),
    source: 'manual',
  });
};

// --- Mock layers ---
const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
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
    if (teamId === TEST_TEAM_ID && userId === TEST_OTHER_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_OTHER_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: TEST_OTHER_USER_ID,
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

const MockInactiveMemberTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: Team.TeamId, userId: Auth.UserId) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: TEST_USER_ID,
          active: false,
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

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  findByTeamMember: (memberId: TeamMember.TeamMemberId) => {
    const logs = Array.from(activityLogsStore.values())
      .filter((l) => l.team_member_id === memberId)
      .map((l) => ({
        activity_type_id: l.activity_type_id,
        activity_type_name: l.activity_type_name,
        logged_at_date: l.logged_at.slice(0, 10),
        duration_minutes: l.duration_minutes,
      }));
    return Effect.succeed(logs);
  },
  findByMember: (memberId: TeamMember.TeamMemberId) => {
    const logs = Array.from(activityLogsStore.values()).filter(
      (l) => l.team_member_id === memberId,
    );
    return Effect.succeed(logs);
  },
  findById: (id: ActivityLog.ActivityLogId, memberId: TeamMember.TeamMemberId) => {
    const log = activityLogsStore.get(id);
    const found = log && log.team_member_id === memberId ? log : undefined;
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  insert: (input: {
    team_member_id: TeamMember.TeamMemberId;
    activity_type_id: ActivityType.ActivityTypeId;
    logged_at: Date;
    duration_minutes: Option.Option<number>;
    note: Option.Option<string>;
    source?: ActivityLog.ActivitySource;
  }) => {
    const id = crypto.randomUUID() as ActivityLog.ActivityLogId;
    const record: ActivityLogRecord = {
      id,
      source: 'manual',
      activity_type_name: 'Gym',
      ...input,
      logged_at: input.logged_at.toISOString(),
    };
    activityLogsStore.set(id, record);
    return Effect.succeed({
      id,
      activity_type_id: input.activity_type_id,
      activity_type_name: record.activity_type_name,
      logged_at: record.logged_at,
      source: record.source,
    });
  },
  update: (
    id: ActivityLog.ActivityLogId,
    memberId: TeamMember.TeamMemberId,
    input: {
      activity_type_id: Option.Option<ActivityType.ActivityTypeId>;
      duration_minutes: Option.Option<Option.Option<number>>;
      note: Option.Option<Option.Option<string>>;
      logged_at: Option.Option<Date>;
    },
  ) => {
    const existing = activityLogsStore.get(id);
    if (!existing || existing.team_member_id !== memberId)
      return Effect.fail(new ActivityLogApi.LogNotFound());
    if (existing.source === 'auto') return Effect.fail(new ActivityLogApi.AutoSourceForbidden());
    const updated: ActivityLogRecord = {
      ...existing,
      activity_type_id: Option.getOrElse(input.activity_type_id, () => existing.activity_type_id),
      duration_minutes: Option.getOrElse(input.duration_minutes, () => existing.duration_minutes),
      note: Option.getOrElse(input.note, () => existing.note),
      logged_at: Option.match(input.logged_at, {
        onNone: () => existing.logged_at,
        onSome: (d) => d.toISOString(),
      }),
    };
    activityLogsStore.set(id, updated);
    return Effect.succeed(updated);
  },
  delete: (id: ActivityLog.ActivityLogId, memberId: TeamMember.TeamMemberId) => {
    const existing = activityLogsStore.get(id);
    if (!existing || existing.team_member_id !== memberId)
      return Effect.fail(new ActivityLogApi.LogNotFound());
    if (existing.source === 'auto') return Effect.fail(new ActivityLogApi.AutoSourceForbidden());
    activityLogsStore.delete(id);
    return Effect.void;
  },
} as any);

const MockProvideLayer = Layer.mergeAll(
  MockTeamMembersRepositoryLayer,
  MockActivityLogsRepositoryLayer,
);

const MockInactiveMemberProvideLayer = Layer.mergeAll(
  MockInactiveMemberTeamMembersRepositoryLayer,
  MockActivityLogsRepositoryLayer,
);

// --- Handler logic (mirrors actual API handler) ---

const listLogs = (payload: {
  teamId: Team.TeamId;
  memberId: TeamMember.TeamMemberId;
  currentUserId: Auth.UserId;
}): Effect.Effect<
  ActivityLogApi.ActivityLogListResponse,
  ActivityLogApi.Forbidden | ActivityLogApi.MemberNotFound,
  TeamMembersRepository | ActivityLogsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('membership', ({ members }) =>
      members.findMembershipByIds(payload.teamId, payload.currentUserId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityLogApi.Forbidden()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ membership }) =>
      membership.id === payload.memberId
        ? Effect.void
        : Effect.fail(new ActivityLogApi.Forbidden()),
    ),
    Effect.bind('logs', ({ activityLogs }) => activityLogs.findByMember(payload.memberId)),
    Effect.map(
      ({ logs }) =>
        new ActivityLogApi.ActivityLogListResponse({
          logs: logs.map(
            (l) =>
              new ActivityLogApi.ActivityLogEntry({
                id: l.id,
                activityTypeId: l.activity_type_id,
                activityTypeName: l.activity_type_name,
                activityTypeEmoji: Option.none(),
                loggedAt: l.logged_at,
                durationMinutes: l.duration_minutes,
                note: l.note,
                source: l.source,
              }),
          ),
        }),
    ),
  );

const createLog = (payload: {
  teamId: Team.TeamId;
  memberId: TeamMember.TeamMemberId;
  currentUserId: Auth.UserId;
  activityTypeId: ActivityType.ActivityTypeId;
  durationMinutes: Option.Option<number>;
  note: Option.Option<string>;
  loggedAtDate: Option.Option<string>;
}): Effect.Effect<
  ActivityLogApi.ActivityLogEntry,
  | ActivityLogApi.Forbidden
  | ActivityLogApi.MemberNotFound
  | ActivityLogApi.MemberInactive
  | ActivityLogApi.InvalidLoggedAtDate,
  TeamMembersRepository | ActivityLogsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('membership', ({ members }) =>
      members.findMembershipByIds(payload.teamId, payload.currentUserId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityLogApi.Forbidden()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ membership }) =>
      membership.id === payload.memberId
        ? Effect.void
        : Effect.fail(new ActivityLogApi.Forbidden()),
    ),
    Effect.tap(({ membership }) =>
      membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
    ),
    Effect.bind('loggedAt', () => {
      if (Option.isSome(payload.loggedAtDate)) {
        const parsed = ActivityLogDate.parseLoggedAtDateInPrague(payload.loggedAtDate.value);
        return Option.isSome(parsed)
          ? Effect.succeed(parsed.value)
          : Effect.fail(new ActivityLogApi.InvalidLoggedAtDate());
      }
      return Effect.succeed(DateTime.toDateUtc(DateTime.nowUnsafe()));
    }),
    Effect.flatMap(({ activityLogs, loggedAt }) =>
      activityLogs.insert({
        team_member_id: payload.memberId,
        activity_type_id: payload.activityTypeId,
        logged_at: loggedAt,
        duration_minutes: payload.durationMinutes,
        note: payload.note,
        source: 'manual',
      }),
    ),
    Effect.map(
      (inserted) =>
        new ActivityLogApi.ActivityLogEntry({
          id: inserted.id,
          activityTypeId: inserted.activity_type_id,
          activityTypeName: inserted.activity_type_name,
          activityTypeEmoji: Option.none(),
          loggedAt: inserted.logged_at,
          durationMinutes: payload.durationMinutes,
          note: payload.note,
          source: inserted.source,
        }),
    ),
  );

const updateLog = (payload: {
  teamId: Team.TeamId;
  memberId: TeamMember.TeamMemberId;
  logId: ActivityLog.ActivityLogId;
  currentUserId: Auth.UserId;
  activityTypeId: Option.Option<ActivityType.ActivityTypeId>;
  durationMinutes: Option.Option<Option.Option<number>>;
  note: Option.Option<Option.Option<string>>;
  loggedAtDate: Option.Option<string>;
}): Effect.Effect<
  ActivityLogApi.ActivityLogEntry,
  | ActivityLogApi.Forbidden
  | ActivityLogApi.LogNotFound
  | ActivityLogApi.MemberInactive
  | ActivityLogApi.AutoSourceForbidden
  | ActivityLogApi.InvalidLoggedAtDate,
  TeamMembersRepository | ActivityLogsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('membership', ({ members }) =>
      members.findMembershipByIds(payload.teamId, payload.currentUserId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityLogApi.Forbidden()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ membership }) =>
      membership.id === payload.memberId
        ? Effect.void
        : Effect.fail(new ActivityLogApi.Forbidden()),
    ),
    Effect.tap(({ membership }) =>
      membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
    ),
    Effect.bind('loggedAtOpt', () => {
      if (Option.isSome(payload.loggedAtDate)) {
        const parsed = ActivityLogDate.parseLoggedAtDateInPrague(payload.loggedAtDate.value);
        return Option.isSome(parsed)
          ? Effect.succeed(Option.some(parsed.value))
          : Effect.fail(new ActivityLogApi.InvalidLoggedAtDate());
      }
      return Effect.succeed(Option.none<Date>());
    }),
    Effect.flatMap(({ activityLogs, loggedAtOpt }) =>
      activityLogs.update(payload.logId, payload.memberId, {
        activity_type_id: payload.activityTypeId,
        logged_at: loggedAtOpt,
        duration_minutes: payload.durationMinutes,
        note: payload.note,
      }),
    ),
    Effect.map(
      (updated) =>
        new ActivityLogApi.ActivityLogEntry({
          id: updated.id,
          activityTypeId: updated.activity_type_id,
          activityTypeName: updated.activity_type_name,
          activityTypeEmoji: Option.none(),
          loggedAt: updated.logged_at,
          durationMinutes: updated.duration_minutes,
          note: updated.note,
          source: updated.source,
        }),
    ),
  );

const deleteLog = (payload: {
  teamId: Team.TeamId;
  memberId: TeamMember.TeamMemberId;
  logId: ActivityLog.ActivityLogId;
  currentUserId: Auth.UserId;
}): Effect.Effect<
  void,
  | ActivityLogApi.Forbidden
  | ActivityLogApi.LogNotFound
  | ActivityLogApi.MemberInactive
  | ActivityLogApi.AutoSourceForbidden,
  TeamMembersRepository | ActivityLogsRepository
> =>
  Effect.Do.pipe(
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('membership', ({ members }) =>
      members.findMembershipByIds(payload.teamId, payload.currentUserId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityLogApi.Forbidden()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ membership }) =>
      membership.id === payload.memberId
        ? Effect.void
        : Effect.fail(new ActivityLogApi.Forbidden()),
    ),
    Effect.tap(({ membership }) =>
      membership.active ? Effect.void : Effect.fail(new ActivityLogApi.MemberInactive()),
    ),
    Effect.flatMap(({ activityLogs }) => activityLogs.delete(payload.logId, payload.memberId)),
  );

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  resetStores();
});

describe('listLogs handler', () => {
  it.effect('returns logs for own profile', () =>
    listLogs({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.logs).toHaveLength(2);
          expect(result.logs[0].id).toBe(TEST_LOG_ID_1);
          expect(result.logs[0].activityTypeId).toBe(GYM_TYPE_ID);
          expect(result.logs[0].activityTypeName).toBe('Gym');
          expect(Option.getOrNull(result.logs[0].durationMinutes)).toBe(60);
          expect(Option.getOrNull(result.logs[0].note)).toBe('Leg day');
          expect(result.logs[1].id).toBe(TEST_LOG_ID_2);
          expect(result.logs[1].activityTypeId).toBe(RUNNING_TYPE_ID);
          expect(Option.isNone(result.logs[1].durationMinutes)).toBe(true);
          expect(Option.isNone(result.logs[1].note)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 when memberId is not current user', () =>
    listLogs({
      teamId: TEST_TEAM_ID,
      memberId: TEST_OTHER_MEMBER_ID,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogForbidden');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});

describe('createLog handler', () => {
  it.effect('succeeds for active own profile', () =>
    createLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: GYM_TYPE_ID,
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activityTypeId).toBe(GYM_TYPE_ID);
          expect(Option.isNone(result.durationMinutes)).toBe(true);
          expect(Option.isNone(result.note)).toBe(true);
          expect(activityLogsStore.size).toBe(3);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 for other member profile', () =>
    createLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_OTHER_MEMBER_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: RUNNING_TYPE_ID,
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogForbidden');
          }
          expect(activityLogsStore.size).toBe(2);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 for inactive member', () =>
    createLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: GYM_TYPE_ID,
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogMemberInactive');
          }
          expect(activityLogsStore.size).toBe(2);
        }),
      ),
      Effect.provide(MockInactiveMemberProvideLayer),
      Effect.asVoid,
    ),
  );
});

describe('updateLog handler', () => {
  it.effect('succeeds with partial fields (only activityTypeId)', () =>
    updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.some(RUNNING_TYPE_ID),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.id).toBe(TEST_LOG_ID_1);
          expect(result.activityTypeId).toBe(RUNNING_TYPE_ID);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 404 for non-existent log', () =>
    updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_NONEXISTENT_LOG_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.some(GYM_TYPE_ID),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogNotFound');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 when updating log for another member', () =>
    updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_OTHER_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.some(GYM_TYPE_ID),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogForbidden');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 for inactive member on update', () =>
    updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.some(GYM_TYPE_ID),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogMemberInactive');
          }
        }),
      ),
      Effect.provide(MockInactiveMemberProvideLayer),
      Effect.asVoid,
    ),
  );
});

describe('deleteLog handler', () => {
  it.effect('succeeds for own log', () =>
    deleteLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          expect(activityLogsStore.has(TEST_LOG_ID_1)).toBe(false);
          expect(activityLogsStore.size).toBe(1);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 404 for non-existent log', () =>
    deleteLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_NONEXISTENT_LOG_ID,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogNotFound');
          }
          expect(activityLogsStore.size).toBe(2);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 when deleting log for another member', () =>
    deleteLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_OTHER_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogForbidden');
          }
          expect(activityLogsStore.size).toBe(2);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns 403 for inactive member on delete', () =>
    deleteLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogMemberInactive');
          }
          expect(activityLogsStore.size).toBe(2);
        }),
      ),
      Effect.provide(MockInactiveMemberProvideLayer),
      Effect.asVoid,
    ),
  );
});

// --- Additional IDs for source-guard tests ---
const TEST_AUTO_LOG_ID = 'log-uuid-auto-001' as ActivityLog.ActivityLogId;
const TRAINING_TYPE_ID = 'type-uuid-training' as ActivityType.ActivityTypeId;

describe('auto-source guard on updateLog', () => {
  it.effect('returns 403 when updating an auto-source log', () => {
    activityLogsStore.set(TEST_AUTO_LOG_ID, {
      id: TEST_AUTO_LOG_ID,
      team_member_id: TEST_MEMBER_ID,
      activity_type_id: TRAINING_TYPE_ID,
      activity_type_name: 'Training',
      logged_at: '2026-03-27T09:00:00.000Z',
      duration_minutes: Option.none(),
      note: Option.none(),
      source: 'auto',
    });
    return updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_AUTO_LOG_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.some(GYM_TYPE_ID),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogAutoSourceForbidden');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });
});

describe('auto-source guard on deleteLog', () => {
  it.effect('returns 403 when deleting an auto-source log', () => {
    activityLogsStore.set(TEST_AUTO_LOG_ID, {
      id: TEST_AUTO_LOG_ID,
      team_member_id: TEST_MEMBER_ID,
      activity_type_id: TRAINING_TYPE_ID,
      activity_type_name: 'Training',
      logged_at: '2026-03-27T09:00:00.000Z',
      duration_minutes: Option.none(),
      note: Option.none(),
      source: 'auto',
    });
    return deleteLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_AUTO_LOG_ID,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityLogAutoSourceForbidden');
          }
          expect(activityLogsStore.has(TEST_AUTO_LOG_ID)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });
});

describe('listLogs includes source field', () => {
  it.effect('returns correct source for manual and auto logs', () => {
    activityLogsStore.set(TEST_AUTO_LOG_ID, {
      id: TEST_AUTO_LOG_ID,
      team_member_id: TEST_MEMBER_ID,
      activity_type_id: TRAINING_TYPE_ID,
      activity_type_name: 'Training',
      logged_at: '2026-03-27T09:00:00.000Z',
      duration_minutes: Option.none(),
      note: Option.none(),
      source: 'auto',
    });
    return listLogs({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.logs).toHaveLength(3);
          const manualLog = result.logs.find((l) => l.id === TEST_LOG_ID_1);
          const autoLog = result.logs.find((l) => l.id === TEST_AUTO_LOG_ID);
          expect(manualLog).toBeDefined();
          expect(manualLog?.source).toBe('manual');
          expect(autoLog).toBeDefined();
          expect(autoLog?.source).toBe('auto');
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });
});

describe('createLog sets source to manual', () => {
  it.effect('newly created log has source manual', () =>
    createLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: GYM_TYPE_ID,
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.source).toBe('manual');
          const storedRecord = Array.from(activityLogsStore.values()).find(
            (r) => r.id === result.id,
          );
          expect(storedRecord?.source).toBe('manual');
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// loggedAtDate tests — TDD for backdating / future-dating feature
// ---------------------------------------------------------------------------

const TEST_AUTO_LOG_ID_3 = 'log-uuid-auto-003' as ActivityLog.ActivityLogId;

describe('createLog with loggedAtDate', () => {
  it.effect(
    "succeeds with loggedAtDate=Some('2026-05-15') and persists Prague-noon UTC (CEST -> 10:00 UTC)",
    () =>
      createLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        currentUserId: TEST_USER_ID,
        activityTypeId: GYM_TYPE_ID,
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some('2026-05-15'),
      }).pipe(
        Effect.tap((result) =>
          Effect.sync(() => {
            const storedRecord = Array.from(activityLogsStore.values()).find(
              (r) => r.id === result.id,
            );
            expect(storedRecord).toBeDefined();
            if (storedRecord) {
              expect(storedRecord.logged_at).toBe('2026-05-15T10:00:00.000Z');
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect('succeeds with loggedAtDate=None and logged_at is within 5s of now', () =>
    createLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      currentUserId: TEST_USER_ID,
      activityTypeId: GYM_TYPE_ID,
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.tap((result) => {
        const storedRecord = Array.from(activityLogsStore.values()).find((r) => r.id === result.id);
        return Effect.sync(() => {
          expect(storedRecord).toBeDefined();
          if (storedRecord) {
            const delta = Math.abs(Date.parse(storedRecord.logged_at) - Date.now());
            expect(delta).toBeLessThan(5000);
          }
        });
      }),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect(
    "fails with 'ActivityLogInvalidLoggedAtDate' when loggedAtDate=Some('9999-01-01') (out of bounds)",
    () =>
      createLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        currentUserId: TEST_USER_ID,
        activityTypeId: GYM_TYPE_ID,
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some('9999-01-01'),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogInvalidLoggedAtDate');
            }
            expect(activityLogsStore.size).toBe(2);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect(
    "fails with 'ActivityLogInvalidLoggedAtDate' when loggedAtDate=Some('2025-02-29') (invalid calendar)",
    () =>
      createLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        currentUserId: TEST_USER_ID,
        activityTypeId: GYM_TYPE_ID,
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some('2025-02-29'),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogInvalidLoggedAtDate');
            }
            expect(activityLogsStore.size).toBe(2);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );
});

describe('updateLog with loggedAtDate', () => {
  it.effect(
    "succeeds with loggedAtDate=Some('2026-01-15') and persists Prague-noon UTC (CET -> 11:00 UTC)",
    () =>
      updateLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        logId: TEST_LOG_ID_1,
        currentUserId: TEST_USER_ID,
        activityTypeId: Option.none(),
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some('2026-01-15'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            const storedRecord = activityLogsStore.get(TEST_LOG_ID_1);
            expect(storedRecord).toBeDefined();
            if (storedRecord) {
              expect(storedRecord.logged_at).toBe('2026-01-15T11:00:00.000Z');
            }
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect('succeeds with loggedAtDate=None and logged_at is unchanged from initial seed', () =>
    updateLog({
      teamId: TEST_TEAM_ID,
      memberId: TEST_MEMBER_ID,
      logId: TEST_LOG_ID_1,
      currentUserId: TEST_USER_ID,
      activityTypeId: Option.none(),
      durationMinutes: Option.none(),
      note: Option.none(),
      loggedAtDate: Option.none(),
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          const storedRecord = activityLogsStore.get(TEST_LOG_ID_1);
          expect(storedRecord).toBeDefined();
          if (storedRecord) {
            expect(storedRecord.logged_at).toBe('2026-03-25T10:00:00.000Z');
          }
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect(
    "fails with 'ActivityLogInvalidLoggedAtDate' when loggedAtDate=Some('not-a-date')",
    () =>
      updateLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        logId: TEST_LOG_ID_1,
        currentUserId: TEST_USER_ID,
        activityTypeId: Option.none(),
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some('not-a-date'),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogInvalidLoggedAtDate');
            }
            const storedRecord = activityLogsStore.get(TEST_LOG_ID_1);
            expect(storedRecord?.logged_at).toBe('2026-03-25T10:00:00.000Z');
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect(
    'auto-source precedence: updateLog with valid loggedAtDate on auto-source log fails with ActivityLogAutoSourceForbidden, not ActivityLogInvalidLoggedAtDate',
    () => {
      activityLogsStore.set(TEST_AUTO_LOG_ID_3, {
        id: TEST_AUTO_LOG_ID_3,
        team_member_id: TEST_MEMBER_ID,
        activity_type_id: TRAINING_TYPE_ID,
        activity_type_name: 'Training',
        logged_at: '2026-03-27T09:00:00.000Z',
        duration_minutes: Option.none(),
        note: Option.none(),
        source: 'auto',
      });
      const todayPrague = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague' }).format(
        new Date(),
      );
      const [ty, tm, td] = todayPrague.split('-').map(Number);
      const todayUTC = new Date(Date.UTC(ty, tm - 1, td));
      const targetUTC = new Date(todayUTC.getTime() - 10 * 86400000);
      const validDateStr = `${targetUTC.getUTCFullYear()}-${String(targetUTC.getUTCMonth() + 1).padStart(2, '0')}-${String(targetUTC.getUTCDate()).padStart(2, '0')}`;
      return updateLog({
        teamId: TEST_TEAM_ID,
        memberId: TEST_MEMBER_ID,
        logId: TEST_AUTO_LOG_ID_3,
        currentUserId: TEST_USER_ID,
        activityTypeId: Option.none(),
        durationMinutes: Option.none(),
        note: Option.none(),
        loggedAtDate: Option.some(validDateStr),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogAutoSourceForbidden');
              expect(result.failure._tag).not.toBe('ActivityLogInvalidLoggedAtDate');
            }
            const storedRecord = activityLogsStore.get(TEST_AUTO_LOG_ID_3);
            expect(storedRecord?.logged_at).toBe('2026-03-27T09:00:00.000Z');
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      );
    },
  );
});
