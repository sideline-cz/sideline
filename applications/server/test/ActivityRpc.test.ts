import { afterEach, beforeEach, describe, expect, it } from '@effect/vitest';
import type { ActivityType, Discord, Team, TeamMember } from '@sideline/domain';
import { ActivityRpcModels } from '@sideline/domain';
import { DateTime, Effect, Layer, Option, Result } from 'effect';
import { ActivityLogsRepository } from '~/repositories/ActivityLogsRepository.js';
import { ActivityTypesRepository } from '~/repositories/ActivityTypesRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';

// --- Test IDs ---
const TEST_TEAM_ID = '00000000-0000-0000-0000-000000000010' as Team.TeamId;
const TEST_MEMBER_ID = '00000000-0000-0000-0000-000000000020' as TeamMember.TeamMemberId;
const TEST_GUILD_ID = '999999999999999999' as Discord.Snowflake;
const TEST_DISCORD_USER_ID = '111111111111111111' as Discord.Snowflake;
const TEST_UNKNOWN_DISCORD_USER_ID = '000000000000000002' as Discord.Snowflake;
const TEST_ACTIVITY_LOG_ID = 'activity-log-uuid-001';
const TEST_USER_ID = 'user-uuid-001';

const GYM_TYPE_ID = 'type-uuid-gym' as ActivityType.ActivityTypeId;
const RUNNING_TYPE_ID = 'type-uuid-running' as ActivityType.ActivityTypeId;
const STRETCHING_TYPE_ID = 'type-uuid-stretching' as ActivityType.ActivityTypeId;

// --- In-memory stores ---
type ActivityLogInserted = {
  team_member_id: TeamMember.TeamMemberId;
  activity_type_id: ActivityType.ActivityTypeId;
  logged_at: Date;
  duration_minutes: Option.Option<number>;
  note: Option.Option<string>;
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
  getDefaultRoleId: () => Effect.succeed(Option.none()),
  assignRole: () => Effect.void,
  unassignRole: () => Effect.void,
  setJerseyNumber: () => Effect.void,
} as any);

const MockActivityTypesRepositoryLayer = Layer.succeed(ActivityTypesRepository, {
  findBySlug: (slug: string) => {
    const types: Record<string, { id: ActivityType.ActivityTypeId; name: string }> = {
      gym: { id: GYM_TYPE_ID, name: 'Gym' },
      running: { id: RUNNING_TYPE_ID, name: 'Run' },
      stretching: { id: STRETCHING_TYPE_ID, name: 'Stretch' },
    };
    const found = types[slug];
    return Effect.succeed(found ? Option.some(found) : Option.none());
  },
  findByTeamId: () => Effect.succeed([]),
  findById: () => Effect.succeed(Option.none()),
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

// --- Handler logic (mirrors actual RPC handler) ---
const logActivity = (payload: {
  guild_id: Discord.Snowflake;
  discord_user_id: Discord.Snowflake;
  activity_type: string;
  duration_minutes: Option.Option<number>;
  note: Option.Option<string>;
}): Effect.Effect<
  ActivityRpcModels.LogActivityResult,
  ActivityRpcModels.ActivityGuildNotFound | ActivityRpcModels.ActivityMemberNotFound,
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
            onNone: () =>
              Effect.fail<ActivityRpcModels.ActivityGuildNotFound>(
                new ActivityRpcModels.ActivityGuildNotFound(),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('user', ({ users }) =>
      users.findByDiscordId(payload.discord_user_id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail<ActivityRpcModels.ActivityMemberNotFound>(
                new ActivityRpcModels.ActivityMemberNotFound(),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.bind('member', ({ members, team, user }) =>
      members.findMembershipByIds(team.id, user.id).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail<ActivityRpcModels.ActivityMemberNotFound>(
                new ActivityRpcModels.ActivityMemberNotFound(),
              ),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.tap(({ member }) =>
      member.active ? Effect.void : Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
    ),
    Effect.bind('activityType', ({ activityTypes }) =>
      activityTypes.findBySlug(payload.activity_type).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new ActivityRpcModels.ActivityMemberNotFound()),
            onSome: Effect.succeed,
          }),
        ),
      ),
    ),
    Effect.flatMap(({ activityLogs, member, activityType }) =>
      activityLogs.insert({
        team_member_id: member.id,
        activity_type_id: activityType.id,
        logged_at: DateTime.toDateUtc(DateTime.nowUnsafe()),
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

describe('LogActivity RPC handler', () => {
  it.effect('succeeds for a valid guild member with activity_type gym', () =>
    logActivity({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'gym',
      duration_minutes: Option.none(),
      note: Option.none(),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activity_type_id).toBe(GYM_TYPE_ID);
          expect(activityLogsInserted).toHaveLength(1);
          expect(activityLogsInserted[0].activity_type_id).toBe(GYM_TYPE_ID);
          expect(Option.isNone(activityLogsInserted[0].duration_minutes)).toBe(true);
          expect(Option.isNone(activityLogsInserted[0].note)).toBe(true);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('succeeds with duration_minutes and note provided', () =>
    logActivity({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'running',
      duration_minutes: Option.some(30),
      note: Option.some('Leg day'),
    }).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result.activity_type_id).toBe(RUNNING_TYPE_ID);
          expect(activityLogsInserted).toHaveLength(1);
          expect(Option.getOrNull(activityLogsInserted[0].duration_minutes)).toBe(30);
          expect(Option.getOrNull(activityLogsInserted[0].note)).toBe('Leg day');
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('fails with ActivityGuildNotFound for an unknown guild_id', () => {
    const unknownGuildId = '000000000000000001' as Discord.Snowflake;

    return logActivity({
      guild_id: unknownGuildId,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'gym',
      duration_minutes: Option.none(),
      note: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityGuildNotFound');
          }
          expect(activityLogsInserted).toHaveLength(0);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    );
  });

  it.effect('fails with ActivityMemberNotFound for a valid guild but unknown discord user', () =>
    logActivity({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_UNKNOWN_DISCORD_USER_ID,
      activity_type: 'stretching',
      duration_minutes: Option.none(),
      note: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityMemberNotFound');
          }
          expect(activityLogsInserted).toHaveLength(0);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );

  it.effect('fails with ActivityMemberNotFound for an inactive team member', () => {
    const InactiveMemberLayer = Layer.succeed(TeamMembersRepository, {
      findMembershipByIds: (teamId: string, userId: string) => {
        if (teamId === TEST_TEAM_ID && userId === TEST_USER_ID)
          return Effect.succeed(
            Option.some({
              id: TEST_MEMBER_ID,
              team_id: TEST_TEAM_ID,
              user_id: TEST_USER_ID,
              active: false,
              role_names: [] as string[],
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
      getDefaultRoleId: () => Effect.succeed(Option.none()),
      assignRole: () => Effect.void,
      unassignRole: () => Effect.void,
      setJerseyNumber: () => Effect.void,
    } as any);

    const LayerWithInactiveMember = Layer.mergeAll(
      MockTeamsRepositoryLayer,
      MockUsersRepositoryLayer,
      InactiveMemberLayer,
      MockActivityLogsRepositoryLayer,
      MockActivityTypesRepositoryLayer,
    );

    return logActivity({
      guild_id: TEST_GUILD_ID,
      discord_user_id: TEST_DISCORD_USER_ID,
      activity_type: 'gym',
      duration_minutes: Option.none(),
      note: Option.none(),
    }).pipe(
      Effect.result,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(Result.isFailure(result)).toBe(true);
          if (Result.isFailure(result)) {
            expect(result.failure._tag).toBe('ActivityMemberNotFound');
          }
          expect(activityLogsInserted).toHaveLength(0);
        }),
      ),
      Effect.provide(LayerWithInactiveMember),
      Effect.asVoid,
    );
  });

  it.effect('accepts all valid activity types: gym, running, stretching', () =>
    Effect.Do.pipe(
      Effect.bind('gymResult', () =>
        logActivity({
          guild_id: TEST_GUILD_ID,
          discord_user_id: TEST_DISCORD_USER_ID,
          activity_type: 'gym',
          duration_minutes: Option.none(),
          note: Option.none(),
        }),
      ),
      Effect.bind('runningResult', () =>
        logActivity({
          guild_id: TEST_GUILD_ID,
          discord_user_id: TEST_DISCORD_USER_ID,
          activity_type: 'running',
          duration_minutes: Option.none(),
          note: Option.none(),
        }),
      ),
      Effect.bind('stretchingResult', () =>
        logActivity({
          guild_id: TEST_GUILD_ID,
          discord_user_id: TEST_DISCORD_USER_ID,
          activity_type: 'stretching',
          duration_minutes: Option.none(),
          note: Option.none(),
        }),
      ),
      Effect.tap(({ gymResult, runningResult, stretchingResult }) =>
        Effect.sync(() => {
          expect(gymResult.activity_type_id).toBe(GYM_TYPE_ID);
          expect(runningResult.activity_type_id).toBe(RUNNING_TYPE_ID);
          expect(stretchingResult.activity_type_id).toBe(STRETCHING_TYPE_ID);
          expect(activityLogsInserted).toHaveLength(3);
        }),
      ),
      Effect.provide(MockProvideLayer),
      Effect.asVoid,
    ),
  );
});
