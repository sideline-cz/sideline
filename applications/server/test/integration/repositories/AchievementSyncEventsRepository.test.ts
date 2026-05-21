// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference AchievementSyncEventsRepository and AchievementRoleMappingsRepository
// which do NOT yet exist. Tests will FAIL until the developer runs the achievement
// migration and implements those repositories.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
// These imports will fail until the implementation exists:
import { AchievementSyncEventsRepository } from '~/repositories/AchievementSyncEventsRepository.js';
import { TeamMembersRepository } from '~/repositories/TeamMembersRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  AchievementSyncEventsRepository.Default,
  AchievementRoleMappingsRepository.Default,
  TeamMembersRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const createUser = (discordId: string, username: string) =>
  UsersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.upsertFromDiscord({
        discord_id: discordId,
        username,
        avatar: Option.none(),
        discord_nickname: Option.none(),
        discord_display_name: Option.none(),
      }),
    ),
    Effect.map((u) => u.id),
  );

const createTeam = (
  guildId: Discord.Snowflake,
  createdBy: User.UserId,
  welcomeChannelId: Option.Option<Discord.Snowflake> = Option.none(),
  achievementChannelId: Option.Option<Discord.Snowflake> = Option.none(),
) =>
  TeamsRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.insert({
        name: 'Test Team',
        guild_id: guildId,
        created_by: createdBy,
        description: Option.none(),
        sport: Option.none(),
        logo_url: Option.none(),
        created_at: undefined,
        updated_at: undefined,
        welcome_channel_id: welcomeChannelId,
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        overview_channel_id: Option.none(),
        achievement_channel_id: achievementChannelId,
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

const addTeamMember = (teamId: Team.TeamId, userId: User.UserId) =>
  TeamMembersRepository.asEffect().pipe(
    Effect.andThen((repo) =>
      repo.addMember({
        team_id: teamId,
        user_id: userId,
        active: true,
        joined_at: undefined,
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AchievementSyncEventsRepository', () => {
  it.effect('emit inserts row with guild_id looked up from teams', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000001', 'sync-evt-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('501010101010101010' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'first_activity')),
        ),
      ),
      Effect.bind('events', ({ tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ events, team }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(1);
          const evt = events[0]!;
          expect(evt.guild_id).toBe('501010101010101010');
          expect(evt.achievement_slug).toBe('first_activity');
          expect(evt.team_id).toBe(team.id);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findUnprocessed returns events with achievement_channel_id JOINed from teams', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000002', 'sync-evt-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam(
          '502020202020202020' as Discord.Snowflake,
          userId,
          Option.none(),
          Option.some('600000000000000001' as Discord.Snowflake),
        ),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'ten_activities')),
        ),
      ),
      Effect.bind('events', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(1);
          const evt = events[0]!;
          expect(Option.isSome(evt.achievement_channel_id)).toBe(true);
          expect(Option.getOrNull(evt.achievement_channel_id)).toBe('600000000000000001');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findUnprocessed returns achievement_channel_id=None when team has it disabled', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000008', 'sync-evt-user-8')),
      Effect.bind('team', ({ userId }) =>
        createTeam('508080808080808080' as Discord.Snowflake, userId, Option.none(), Option.none()),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'streak_30')),
        ),
      ),
      Effect.bind('events', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(1);
          const evt = events[0]!;
          expect(Option.isNone(evt.achievement_channel_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'findUnprocessed returns discord_role_id from achievement_role_mappings when mapping exists',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000003', 'sync-evt-user-3')),
        Effect.bind('team', ({ userId }) =>
          createTeam('503030303030303030' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        // Upsert a role mapping for fifty_activities
        Effect.tap(({ team }) =>
          AchievementRoleMappingsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.upsert(team.id, 'fifty_activities', '700000000000000001' as Discord.Snowflake),
            ),
          ),
        ),
        Effect.tap(({ team, tm }) =>
          AchievementSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.emit(team.id, tm.id, 'fifty_activities')),
          ),
        ),
        Effect.bind('events', () =>
          AchievementSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findUnprocessed(10)),
          ),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect(events).toHaveLength(1);
            const evt = events[0]!;
            expect(Option.isSome(evt.discord_role_id)).toBe(true);
            expect(Option.getOrNull(evt.discord_role_id)).toBe('700000000000000001');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'findUnprocessed returns discord_role_id=null when no mapping (LEFT JOIN behavior)',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createUser('500000000000000004', 'sync-evt-user-4')),
        Effect.bind('team', ({ userId }) =>
          createTeam('504040404040404040' as Discord.Snowflake, userId),
        ),
        Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
        Effect.tap(({ team, tm }) =>
          AchievementSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.emit(team.id, tm.id, 'streak_7')),
          ),
        ),
        Effect.bind('events', () =>
          AchievementSyncEventsRepository.asEffect().pipe(
            Effect.andThen((repo) => repo.findUnprocessed(10)),
          ),
        ),
        Effect.tap(({ events }) =>
          Effect.sync(() => {
            expect(events).toHaveLength(1);
            const evt = events[0]!;
            expect(Option.isNone(evt.discord_role_id)).toBe(true);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('findUnprocessed returns discord_user_id from users via team_members', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000005', 'sync-evt-user-5')),
      Effect.bind('user', () =>
        UsersRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsertFromDiscord({
              discord_id: '800000000000000001',
              username: 'discord-user-5',
              avatar: Option.none(),
              discord_nickname: Option.none(),
              discord_display_name: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('team', ({ userId }) =>
        createTeam('505050505050505050' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, user }) => addTeamMember(team.id, user.id)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'streak_3')),
        ),
      ),
      Effect.bind('events', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ events }) =>
        Effect.sync(() => {
          expect(events).toHaveLength(1);
          const evt = events[0]!;
          expect(evt.discord_user_id).toBe('800000000000000001');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('markProcessed sets processed_at', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000006', 'sync-evt-user-6')),
      Effect.bind('team', ({ userId }) =>
        createTeam('506060606060606060' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'duration_600')),
        ),
      ),
      Effect.bind('beforeMark', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ beforeMark }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markProcessed(beforeMark[0]?.id)),
        ),
      ),
      Effect.bind('afterMark', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ beforeMark, afterMark }) =>
        Effect.sync(() => {
          expect(beforeMark).toHaveLength(1);
          // After marking processed, no longer in unprocessed list
          expect(afterMark).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('markFailed sets error and processed_at', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('500000000000000007', 'sync-evt-user-7')),
      Effect.bind('team', ({ userId }) =>
        createTeam('507070707070707070' as Discord.Snowflake, userId),
      ),
      Effect.bind('tm', ({ team, userId }) => addTeamMember(team.id, userId)),
      Effect.tap(({ team, tm }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.emit(team.id, tm.id, 'gym_25')),
        ),
      ),
      Effect.bind('beforeMark', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ beforeMark }) =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.markFailed(beforeMark[0]?.id, 'Discord rate limited')),
        ),
      ),
      Effect.bind('afterMark', () =>
        AchievementSyncEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(10)),
        ),
      ),
      Effect.tap(({ beforeMark, afterMark }) =>
        Effect.sync(() => {
          expect(beforeMark).toHaveLength(1);
          // After marking failed (sets processed_at), no longer in unprocessed list
          expect(afterMark).toHaveLength(0);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
