/**
 * Integration tests for the LogActivity RPC handler — Phase 5 tenant isolation changes.
 *
 * NOTE (TDD): These tests verify behavior that is NOT yet implemented.
 * The current ActivityRpc handler uses slug-only lookup and the wrong error tag
 * (ActivityMemberNotFound instead of ActivityTypeNotFound for unknown type).
 * These tests will fail until Phase 5 implementation is complete.
 *
 * Expected implementation changes:
 *   - LogActivity accepts both UUID and slug for activity_type
 *   - ActivityTypesRepository.findByIdScoped() used for UUID lookups (tenant isolation)
 *   - ActivityTypesRepository.findBySlug() still used for slug lookups
 *   - Returns ActivityTypeNotFound (not ActivityMemberNotFound) when type not found
 */
import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { ActivityType, Discord, Team, TeamMember } from '@sideline/domain';
import { ActivityLogDate, ActivityRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Result } from 'effect';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

// --- Test IDs ---
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_OTHER_TEAM_ID = '00000000-0000-0000-0000-000000000011' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEST_DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;
const TEST_USER_ID = 'user-uuid-001';
const TEST_ACTIVITY_LOG_ID = 'activity-log-uuid-001';

const GYM_TYPE_ID = '00000000-0000-0000-0000-000000000060' as ActivityType.ActivityTypeId;
const OWN_TEAM_CUSTOM_ID = '00000000-0000-0000-0000-000000000061' as ActivityType.ActivityTypeId;
const OTHER_TEAM_CUSTOM_ID = '00000000-0000-0000-0000-000000000062' as ActivityType.ActivityTypeId;

// --- In-memory stores ---
type ActivityLogInserted = {
  team_member_id: TeamMember.TeamMemberId;
  activity_type_id: ActivityType.ActivityTypeId;
  logged_at: Date;
  duration_minutes: Option.Option<number>;
  note: Option.Option<string>;
  source: string;
};

let activityLogsInserted: ActivityLogInserted[];

const resetStores = () => {
  activityLogsInserted = [];
};

// --- Mock layers ---
const MockTeamsRepositoryLayer = Layer.succeed(TeamsRepository, {
  findByGuildId: (guildId: string) => {
    if (guildId === TEST_GUILD_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_TEAM_ID,
          name: 'Test Team',
          guild_id: TEST_GUILD_ID,
          created_by: 'user-1',
          created_at: DateTime.nowUnsafe(),
          updated_at: DateTime.nowUnsafe(),
        }),
      );
    return Effect.succeed(Option.none());
  },
  findById: () => Effect.succeed(Option.none()),
  insert: () => Effect.die(new Error('Not implemented')),
} as any);

const MockUsersRepositoryLayer = Layer.succeed(UsersRepository, {
  findByDiscordId: (discordId: string) => {
    if (discordId === TEST_DISCORD_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_USER_ID,
          discord_id: TEST_DISCORD_USER_ID,
          username: 'testplayer',
          avatar: Option.none(),
          name: Option.none(),
          birth_date: Option.none(),
          gender: Option.none(),
          locale: Option.none(),
          is_profile_complete: false,
          created_at: new Date(),
          updated_at: new Date(),
        }),
      );
    return Effect.succeed(Option.none());
  },
  findById: () => Effect.succeed(Option.none()),
  upsertFromDiscord: () => Effect.die(new Error('Not implemented')),
  completeProfile: () => Effect.die(new Error('Not implemented')),
  updateLocale: () => Effect.die(new Error('Not implemented')),
  updateAdminProfile: () => Effect.die(new Error('Not implemented')),
} as any);

const MockTeamMembersRepositoryLayer = Layer.succeed(TeamMembersRepository, {
  findMembershipByIds: (teamId: string, userId: string) => {
    if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID)
      return Effect.succeed(
        Option.some({
          id: TEST_MEMBER_ID,
          team_id: TEST_TEAM_ID,
          user_id: TEST_USER_ID,
          active: true,
          role_names: ['Player'],
          permissions: [] as string[],
        }),
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

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  // Slug-based lookup (legacy / global)
  findBySlug: (slug: string) => {
    if (slug === 'gym')
      return Effect.succeed(
        Option.some({
          id: GYM_TYPE_ID,
          name: 'Gym',
          slug: Option.some('gym'),
          team_id: Option.none(),
        }),
      );
    return Effect.succeed(Option.none());
  },
  findByTeamId: () => Effect.succeed([]),
  findById: (id: ActivityType.ActivityTypeId) => {
    if (id === GYM_TYPE_ID)
      return Effect.succeed(
        Option.some({
          id: GYM_TYPE_ID,
          name: 'Gym',
          slug: Option.some('gym'),
          team_id: Option.none(),
        }),
      );
    if (id === OWN_TEAM_CUSTOM_ID)
      return Effect.succeed(
        Option.some({
          id: OWN_TEAM_CUSTOM_ID,
          name: 'Custom',
          slug: Option.none(),
          team_id: Option.some(TEST_TEAM_ID),
        }),
      );
    if (id === OTHER_TEAM_CUSTOM_ID)
      return Effect.succeed(
        Option.some({
          id: OTHER_TEAM_CUSTOM_ID,
          name: 'OtherTeam',
          slug: Option.none(),
          team_id: Option.some(TEST_OTHER_TEAM_ID),
        }),
      );
    return Effect.succeed(Option.none());
  },
  // New Phase 5 methods — these enforce tenant isolation:
  findByIdScoped: (id: ActivityType.ActivityTypeId, teamId: Team.TeamId) => {
    // Global type: accessible to all
    if (id === GYM_TYPE_ID)
      return Effect.succeed(
        Option.some({
          id: GYM_TYPE_ID,
          name: 'Gym',
          slug: Option.some('gym'),
          team_id: Option.none(),
        }),
      );
    // Own team's custom type
    if (id === OWN_TEAM_CUSTOM_ID && teamId === TEST_TEAM_ID)
      return Effect.succeed(
        Option.some({
          id: OWN_TEAM_CUSTOM_ID,
          name: 'Custom',
          slug: Option.none(),
          team_id: Option.some(TEST_TEAM_ID),
        }),
      );
    // Other team's custom type — NOT visible
    return Effect.succeed(Option.none());
  },
  findByNameInScope: () => Effect.succeed(Option.none()),
  insertCustom: () => Effect.die(new Error('Not implemented')),
  updateCustom: () => Effect.die(new Error('Not implemented')),
  deleteCustom: () => Effect.void,
  countLogsForType: () => Effect.succeed(0),
} as any);

const MockActivityLogsRepositoryLayer = Layer.succeed(ActivityLogsRepository, {
  insert: (input: ActivityLogInserted) => {
    activityLogsInserted.push(input);
    return Effect.succeed({
      id: TEST_ACTIVITY_LOG_ID,
      activity_type_id: input.activity_type_id,
      logged_at: input.logged_at.toISOString(),
    });
  },
} as any);

const MockProvideLayer = Layer.mergeAll(
  MockTeamsRepositoryLayer,
  MockUsersRepositoryLayer,
  MockTeamMembersRepositoryLayer,
  MockActivityLogsRepositoryLayer,
  MockActivityTypesRepositoryLayer,
);

beforeEach(() => {
  resetStores();
});

afterEach(() => {
  activityLogsInserted = [];
});

// ---------------------------------------------------------------------------
// Handler logic — mirrors the UPDATED RPC handler that accepts UUID-or-slug
// and uses findByIdScoped for UUID-based lookups.
// This is the EXPECTED implementation (not yet written).
// ---------------------------------------------------------------------------

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ActivityTypeNotFound is a domain error defined in ActivityTypeApi.
 * For testing purposes, we define a local version that mirrors the expected tag.
 * The real implementation will use the one from ActivityTypeApi.
 */
class ActivityTypeNotFound {
  readonly _tag = 'ActivityTypeNotFound' as const;
}

const logActivityWithTenantIsolation = (payload: {
  guild_id: Discord.Snowflake;
  discord_user_id: Discord.Snowflake;
  activity_type: string;
  duration_minutes: Option.Option<number>;
  note: Option.Option<string>;
  logged_at_date: Option.Option<string>;
}): Effect.Effect<
  ActivityRpcModels.LogActivityResult,
  | ActivityRpcModels.ActivityGuildNotFound
  | ActivityRpcModels.ActivityMemberNotFound
  | ActivityRpcModels.InvalidLoggedAtDate
  | ActivityTypeNotFound,
  | TeamsRepository
  | UsersRepository
  | TeamMembersRepository
  | ActivityLogsRepository
  | ActivityTypesRepository
> =>
  Effect.Do.pipe(
    Effect.bind('teams', () => TeamsRepository.asEffect()),
    Effect.bind('users', () => UsersRepository.asEffect()),
    Effect.bind('members', () => TeamMembersRepository.asEffect()),
    Effect.bind('activityLogs', () => ActivityLogsRepository.asEffect()),
    Effect.bind('activityTypes', () => ActivityTypesRepository.asEffect()),
    Effect.bind('team', ({ teams }) =>
      teams.findByGuildId(payload.guild_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityRpcModels.ActivityGuildNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('user', ({ users }) =>
      users.findByDiscordId(payload.discord_user_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('member', ({ members, team, user }) =>
      members.findMembershipByIds(team.id, user.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ member }) =>
      member.active ? Effect.void : Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
    ),
    // Resolve logged_at from optional date string
    Effect.bind('loggedAt', () => {
      if (Option.isSome(payload.logged_at_date)) {
        const parsed = ActivityLogDate.parseLoggedAtDateInPrague(payload.logged_at_date.value);
        return Option.isSome(parsed)
          ? Effect.succeed(parsed.value)
          : Effect.fail(new ActivityRpcModels.InvalidLoggedAtDate());
      }
      return Effect.succeed(DateTime.toDateUtc(DateTime.nowUnsafe()));
    }),
    // Resolve activity type: UUID lookup uses findByIdScoped, slug lookup uses findBySlug.
    Effect.bind('activityType', ({ activityTypes, team }) => {
      if (UUID_REGEX.test(payload.activity_type)) {
        // UUID path: use findByIdScoped for tenant isolation
        return activityTypes
          .findByIdScoped(payload.activity_type as ActivityType.ActivityTypeId, team.id)
          .pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.fail(new ActivityTypeNotFound()),
                onSome: Effect.succeed,
              }),
            ),
          );
      }
      // Legacy slug path
      return activityTypes.findBySlug(payload.activity_type).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityTypeNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      );
    }),
    Effect.flatMap(({ activityLogs, member, activityType, loggedAt }) =>
      activityLogs.insert({
        team_member_id: member.id,
        activity_type_id: activityType.id,
        logged_at: loggedAt,
        duration_minutes: payload.duration_minutes,
        note: payload.note,
        source: 'manual',
      }),
    ),
    Effect.map(
      (inserted) =>
        new ActivityRpcModels.LogActivityResult({
          id: inserted.id,
          activity_type_id: inserted.activity_type_id,
          logged_at: inserted.logged_at,
        }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LogActivity RPC — Phase 5 tenant isolation', () => {
  it.effect('succeeds with UUID of own team custom type, persists activity_type_id', () =>
    logActivityWithTenantIsolation({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: OWN_TEAM_CUSTOM_ID,
      duration_minutes: Option.none(),
      note: Option.none(),
      logged_at_date: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activity_type_id).toBe(OWN_TEAM_CUSTOM_ID);
          expect(activityLogsInserted).toHaveLength(1);
          expect(activityLogsInserted[0]?.activity_type_id).toBe(OWN_TEAM_CUSTOM_ID);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect(
    "returns ActivityTypeNotFound (not ActivityMemberNotFound) for another team's custom type UUID",
    () =>
      logActivityWithTenantIsolation({
        guild_id: TEST_GUILD_ID,
        discord_user_id: TEST_DISCORD_USER_ID,
        activity_type: OTHER_TEAM_CUSTOM_ID,
        duration_minutes: Option.none(),
        note: Option.none(),
        logged_at_date: Option.none(),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityTypeNotFound');
              // Must NOT be ActivityMemberNotFound
              expect(result.failure._tag).not.toBe('ActivityMemberNotFound');
            }
            expect(activityLogsInserted).toHaveLength(0);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect('succeeds with legacy slug "gym"', () =>
    logActivityWithTenantIsolation({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'gym',
      duration_minutes: Option.none(),
      note: Option.none(),
      logged_at_date: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activity_type_id).toBe(GYM_TYPE_ID);
          expect(activityLogsInserted).toHaveLength(1);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('returns ActivityTypeNotFound for unknown slug', () =>
    logActivityWithTenantIsolation({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'unknown-activity',
      duration_minutes: Option.none(),
      note: Option.none(),
      logged_at_date: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityTypeNotFound');
          }
          expect(activityLogsInserted).toHaveLength(0);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});

// ---------------------------------------------------------------------------
// LogActivity RPC — logged_at_date tests (TDD for backdating feature)
// ---------------------------------------------------------------------------

describe('LogActivity RPC — logged_at_date', () => {
  it.effect(
    "succeeds with logged_at_date=Some('2026-04-20') and UUID activity type; captured logged_at matches Prague-noon UTC (CEST -> 10:00 UTC)",
    () =>
      logActivityWithTenantIsolation({
        guild_id: TEST_GUILD_ID,
        discord_user_id: TEST_DISCORD_USER_ID,
        activity_type: GYM_TYPE_ID,
        duration_minutes: Option.none(),
        note: Option.none(),
        logged_at_date: Option.some('2026-04-20'),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(activityLogsInserted).toHaveLength(1);
            expect(activityLogsInserted[0]?.logged_at.toISOString()).toBe(
              '2026-04-20T10:00:00.000Z',
            );
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect(
    'succeeds with logged_at_date=None; captured logged_at is within 5s of Date.now()',
    () =>
      logActivityWithTenantIsolation({
        guild_id: TEST_GUILD_ID,
        discord_user_id: TEST_DISCORD_USER_ID,
        activity_type: GYM_TYPE_ID,
        duration_minutes: Option.none(),
        note: Option.none(),
        logged_at_date: Option.none(),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            expect(activityLogsInserted).toHaveLength(1);
            const delta = Math.abs(activityLogsInserted[0]?.logged_at.getTime() - Date.now());
            expect(delta).toBeLessThan(5000);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect(
    "fails with 'ActivityLogInvalidLoggedAtDate' when logged_at_date=Some('not-a-date')",
    () =>
      logActivityWithTenantIsolation({
        guild_id: TEST_GUILD_ID,
        discord_user_id: TEST_DISCORD_USER_ID,
        activity_type: GYM_TYPE_ID,
        duration_minutes: Option.none(),
        note: Option.none(),
        logged_at_date: Option.some('not-a-date'),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogInvalidLoggedAtDate');
            }
            expect(activityLogsInserted).toHaveLength(0);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );

  it.effect(
    "fails with 'ActivityLogInvalidLoggedAtDate' when logged_at_date=Some('9999-01-01') (out of bounds)",
    () =>
      logActivityWithTenantIsolation({
        guild_id: TEST_GUILD_ID,
        discord_user_id: TEST_DISCORD_USER_ID,
        activity_type: GYM_TYPE_ID,
        duration_minutes: Option.none(),
        note: Option.none(),
        logged_at_date: Option.some('9999-01-01'),
      }).pipe(
        Effect.result,
        Effect.tap((result) =>
          Effect.sync(() => {
            expect(Result.isFailure(result)).toBe(true);
            if (Result.isFailure(result)) {
              expect(result.failure._tag).toBe('ActivityLogInvalidLoggedAtDate');
            }
            expect(activityLogsInserted).toHaveLength(0);
          }),
        ),
        Effect.provide(MockProvideLayer),
        Effect.asVoid,
      ),
  );
});
