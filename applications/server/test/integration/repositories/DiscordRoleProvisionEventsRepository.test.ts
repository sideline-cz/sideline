// TDD mode — integration test for DiscordRoleProvisionEventsRepository.
//
// Test #10 is skipped (it.skip) because DiscordRoleProvisionEventsRepository
// does NOT exist yet. The developer must:
//   1. Create the migration (discord_role_provision_events table with
//      UNIQUE (team_id, kind, ref_id) + ON CONFLICT DO NOTHING on insert).
//   2. Implement DiscordRoleProvisionEventsRepository in
//      applications/server/src/repositories/DiscordRoleProvisionEventsRepository.ts
//   3. Remove the `it.skip` and run `pnpm test` to verify.
//
// Pattern: mirrors AchievementRoleMappingsRepository.test.ts

import { describe, expect, it } from '@effect/vitest';
import type { Discord, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
// This import will fail until the repository is implemented:
import { DiscordRoleProvisionEventsRepository } from '~/repositories/DiscordRoleProvisionEventsRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  DiscordRoleProvisionEventsRepository.Default,
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
        achievement_channel_id: Option.none(),
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

describe('DiscordRoleProvisionEventsRepository', () => {
  it('#10 enqueue is idempotent — calling twice leaves only one row (UNIQUE constraint + ON CONFLICT DO NOTHING)', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createUser('700000000000000001', 'drpe-user-1')),
      Effect.bind('team', ({ userId }) =>
        createTeam('701010101010101010' as Discord.Snowflake, userId),
      ),
      // First enqueue call
      Effect.tap(({ team }) =>
        DiscordRoleProvisionEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.enqueue(
              team.id,
              '701010101010101010' as Discord.Snowflake,
              'builtin_achievement',
              'ten_activities',
              'Bronze Achiever',
            ),
          ),
        ),
      ),
      // Second enqueue call — identical args, must be idempotent (ON CONFLICT DO NOTHING)
      Effect.tap(({ team }) =>
        DiscordRoleProvisionEventsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.enqueue(
              team.id,
              '701010101010101010' as Discord.Snowflake,
              'builtin_achievement',
              'ten_activities',
              'Bronze Achiever',
            ),
          ),
        ),
      ),
      // Count the rows — must be exactly 1
      Effect.bind('rows', ({ team }) =>
        DiscordRoleProvisionEventsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findUnprocessed(team.id)),
        ),
      ),
      Effect.tap(({ rows }) =>
        Effect.sync(() => {
          // Idempotency: second enqueue is silently ignored by ON CONFLICT DO NOTHING
          expect(rows).toHaveLength(1);
          expect(rows[0]).toMatchObject({
            kind: 'builtin_achievement',
            ref_id: 'ten_activities',
            desired_name: 'Bronze Achiever',
          });
        }),
      ),
      Effect.provide(TestLayer),
    ));
});
