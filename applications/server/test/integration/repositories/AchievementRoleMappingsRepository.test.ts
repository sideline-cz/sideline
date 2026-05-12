// NOTE: These tests are written in TDD mode BEFORE the implementation.
// They reference AchievementRoleMappingsRepository which does NOT yet exist.
// Tests will FAIL until the developer runs the achievement migration and
// implements the repository.

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
// This import will fail until the implementation exists:
import { AchievementRoleMappingsRepository } from '~/repositories/AchievementRoleMappingsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  AchievementRoleMappingsRepository.Default,
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

const createTeam = (guildId: Discord.Snowflake, createdBy: User.UserId) =>
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
        welcome_channel_id: Option.none(),
        system_log_channel_id: Option.none(),
        welcome_message_template: Option.none(),
        rules_channel_id: Option.none(),
        overview_channel_id: Option.none(),
        onboarding_rules_role_id: Option.none(),
        onboarding_rules_prompt_id: Option.none(),
        onboarding_locale: 'en',
        onboarding_synced_at: Option.none(),
        onboarding_sync_status: 'pending',
        onboarding_sync_error: Option.none(),
      }),
    ),
  );

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AchievementRoleMappingsRepository', () => {
  it.effect('upsert inserts new mapping', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('600000000000000001', 'role-map-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('601010101010101010' as Discord.Snowflake, userId),
      ),
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(team.id, 'fifty_activities', '900000000000000001' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('found', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'fifty_activities')),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          expect(Option.getOrNull(found)).toBe('900000000000000001');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('upsert updates existing mapping (PK conflict ON CONFLICT DO UPDATE)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('600000000000000002', 'role-map-user-2')),
      Effect.bind('team', ({ userId }) =>
        createTeam('602020202020202020' as Discord.Snowflake, userId),
      ),
      // First upsert
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(team.id, 'streak_7', '900000000000000002' as Discord.Snowflake),
          ),
        ),
      ),
      // Second upsert (update)
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(team.id, 'streak_7', '900000000000000099' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('found', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'streak_7')),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          // Should reflect the updated role id
          expect(Option.getOrNull(found)).toBe('900000000000000099');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByTeamAndSlug returns Some(roleId) when present, None otherwise', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('600000000000000003', 'role-map-user-3')),
      Effect.bind('team', ({ userId }) =>
        createTeam('603030303030303030' as Discord.Snowflake, userId),
      ),
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(team.id, 'hundred_activities', '900000000000000003' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('present', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'hundred_activities')),
        ),
      ),
      Effect.bind('absent', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'running_25')),
        ),
      ),
      Effect.tap(({ present, absent }) =>
        Effect.sync(() => {
          expect(Option.isSome(present)).toBe(true);
          expect(Option.getOrNull(present)).toBe('900000000000000003');
          expect(Option.isNone(absent)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('delete removes mapping', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('600000000000000004', 'role-map-user-4')),
      Effect.bind('team', ({ userId }) =>
        createTeam('604040404040404040' as Discord.Snowflake, userId),
      ),
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.upsert(team.id, 'duration_3000', '900000000000000004' as Discord.Snowflake),
          ),
        ),
      ),
      Effect.bind('before', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'duration_3000')),
        ),
      ),
      Effect.tap(({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.delete(team.id, 'duration_3000')),
        ),
      ),
      Effect.bind('after', ({ team }) =>
        AchievementRoleMappingsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByTeamAndSlug(team.id, 'duration_3000')),
        ),
      ),
      Effect.tap(({ before, after }) =>
        Effect.sync(() => {
          expect(Option.isSome(before)).toBe(true);
          expect(Option.isNone(after)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
