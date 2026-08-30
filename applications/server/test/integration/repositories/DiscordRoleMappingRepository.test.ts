/**
 * Regression tests for PR-6 blocker 2 (the `adopted` provenance column) and the should-fix item
 * about `Role/UpsertMapping` violating `UNIQUE(team_id, discord_role_id)`.
 */

import { describe, expect, it } from '@effect/vitest';
import { type Discord, RoleRpcModels, type User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { DiscordRoleMappingRepository } from '~/repositories/DiscordRoleMappingRepository.js';
import { RolesRepository } from '~/repositories/RolesRepository.js';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const TestLayer = Layer.mergeAll(
  DiscordRoleMappingRepository.Default,
  RolesRepository.Default,
  TeamsRepository.Default,
  UsersRepository.Default,
).pipe(Layer.provideMerge(TestPgClient));

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

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
        name: 'Discord Role Mapping Test Team',
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

const seedTeamAndTwoRoles = (suffix: string) =>
  Effect.Do.pipe(
    Effect.bind('userId', () =>
      createUser(`80000000000000000${suffix}`, `mapping-test-user-${suffix}`),
    ),
    Effect.bind('team', ({ userId }) =>
      createTeam(`81000000000000000${suffix}` as Discord.Snowflake, userId),
    ),
    Effect.bind('roleA', ({ team }) =>
      RolesRepository.asEffect().pipe(Effect.andThen((r) => r.insertRole(team.id, 'Veterans A'))),
    ),
    Effect.bind('roleB', ({ team }) =>
      RolesRepository.asEffect().pipe(Effect.andThen((r) => r.insertRole(team.id, 'Veterans B'))),
    ),
  );

describe('DiscordRoleMappingRepository', () => {
  it.effect('records adopted: true for an adopted mapping and returns it via findByRoleId', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamAndTwoRoles('1')),
      Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
      Effect.tap(({ seed, mappings }) =>
        mappings.insert(
          seed.team.id,
          seed.roleA.id,
          '900000000000000001' as Discord.Snowflake,
          true,
        ),
      ),
      Effect.bind('found', ({ seed, mappings }) =>
        mappings.findByRoleId(seed.team.id, seed.roleA.id),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          expect(Option.getOrThrow(found).adopted).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('records adopted: false for a created mapping', () =>
    Effect.Do.pipe(
      Effect.bind('seed', () => seedTeamAndTwoRoles('2')),
      Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
      Effect.tap(({ seed, mappings }) =>
        mappings.insert(
          seed.team.id,
          seed.roleA.id,
          '900000000000000002' as Discord.Snowflake,
          false,
        ),
      ),
      Effect.bind('found', ({ seed, mappings }) =>
        mappings.findByRoleId(seed.team.id, seed.roleA.id),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.getOrThrow(found).adopted).toBe(false);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'should-fix regression: a second role adopting the same discord_role_id fails with DiscordRoleAlreadyMapped, not a bare SqlError',
    () =>
      Effect.Do.pipe(
        Effect.bind('seed', () => seedTeamAndTwoRoles('3')),
        Effect.bind('mappings', () => DiscordRoleMappingRepository.asEffect()),
        Effect.tap(({ seed, mappings }) =>
          mappings.insert(
            seed.team.id,
            seed.roleA.id,
            '900000000000000003' as Discord.Snowflake,
            true,
          ),
        ),
        Effect.bind('failure', ({ seed, mappings }) =>
          mappings
            .insert(seed.team.id, seed.roleB.id, '900000000000000003' as Discord.Snowflake, true)
            .pipe(Effect.flip),
        ),
        Effect.tap(({ failure }) =>
          Effect.sync(() => {
            expect(failure).toBeInstanceOf(RoleRpcModels.DiscordRoleAlreadyMapped);
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
