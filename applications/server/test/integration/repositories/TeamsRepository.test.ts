import { describe, expect, it } from '@effect/vitest';
import type { Discord, Team, User } from '@sideline/domain';
import { Effect, Layer, Option } from 'effect';
import { beforeEach } from 'vitest';
import { TeamsRepository } from '~/repositories/TeamsRepository.js';
import { UsersRepository } from '~/repositories/UsersRepository.js';
import { cleanDatabase, TestPgClient } from '../helpers.js';

const makeInsert = (overrides?: {
  readonly name?: string;
  readonly guild_id?: Discord.Snowflake;
  readonly created_by?: User.UserId;
  readonly achievement_channel_id?: Option.Option<Discord.Snowflake>;
}): typeof Team.Team.insert.Type => ({
  name: 'Test Team',
  guild_id: '123456789012345678' as Discord.Snowflake,
  created_by: '00000000-0000-0000-0000-000000000001' as User.UserId,
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
  achievement_channel_id: Option.none(),
  onboarding_rules_role_id: Option.none(),
  onboarding_rules_prompt_id: Option.none(),
  onboarding_locale: 'en',
  onboarding_synced_at: Option.none(),
  onboarding_sync_status: 'pending',
  onboarding_sync_error: Option.none(),
  ...overrides,
});

/** Creates a test user and returns their ID for use as `created_by` in team inserts. */
const createTestUser = UsersRepository.asEffect().pipe(
  Effect.andThen((repo) =>
    repo.upsertFromDiscord({
      discord_id: '100000000000000000',
      username: 'teamtestuser',
      avatar: Option.none(),
      discord_nickname: Option.none(),
      discord_display_name: Option.none(),
    }),
  ),
  Effect.map((user) => user.id),
);

const TestLayer = Layer.mergeAll(TeamsRepository.Default, UsersRepository.Default).pipe(
  Layer.provideMerge(TestPgClient),
);

beforeEach(() => cleanDatabase.pipe(Effect.provide(TestPgClient), Effect.runPromise));

describe('TeamsRepository', () => {
  it.effect('insert creates a team and findById returns Some', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createTestUser),
      Effect.bind('inserted', ({ userId }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert(
              makeInsert({
                name: 'Test Team',
                guild_id: '123456789012345678' as Discord.Snowflake,
                created_by: userId,
              }),
            ),
          ),
        ),
      ),
      Effect.bind('found', ({ inserted }) =>
        TeamsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(inserted.id))),
      ),
      Effect.tap(({ inserted, found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const team = Option.getOrThrow(found);
          expect(team.id).toBe(inserted.id);
          expect(team.name).toBe('Test Team');
          expect(team.guild_id).toBe('123456789012345678');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findById returns None for a non-existent id', () =>
    TeamsRepository.asEffect().pipe(
      Effect.andThen((repo) =>
        repo.findById('00000000-0000-0000-0000-000000000099' as Team.TeamId),
      ),
      Effect.tap((found) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByGuildId returns Some when team exists', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createTestUser),
      Effect.tap(({ userId }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert(
              makeInsert({
                name: 'Guild Team',
                guild_id: '987654321098765432' as Discord.Snowflake,
                created_by: userId,
              }),
            ),
          ),
        ),
      ),
      Effect.bind('found', () =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) => repo.findByGuildId('987654321098765432' as Discord.Snowflake)),
        ),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          expect(Option.isSome(found)).toBe(true);
          const team = Option.getOrThrow(found);
          expect(team.name).toBe('Guild Team');
          expect(team.guild_id).toBe('987654321098765432');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('findByGuildId returns None for a non-existent guild id', () =>
    TeamsRepository.asEffect().pipe(
      Effect.andThen((repo) => repo.findByGuildId('000000000000000000' as Discord.Snowflake)),
      Effect.tap((found) =>
        Effect.sync(() => {
          expect(Option.isNone(found)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect('update modifies team fields and returns updated team', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createTestUser),
      Effect.bind('inserted', ({ userId }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert(
              makeInsert({
                name: 'Original Name',
                guild_id: '111111111111111111' as Discord.Snowflake,
                created_by: userId,
              }),
            ),
          ),
        ),
      ),
      Effect.bind('updated', ({ inserted }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.update({
              id: inserted.id,
              name: 'Updated Name',
              description: Option.some('A great team'),
              sport: Option.some('football'),
              logo_url: Option.none(),
              welcome_channel_id: Option.none(),
              achievement_channel_id: Option.none(),
              system_log_channel_id: Option.none(),
              welcome_message_template: Option.none(),
              rules_channel_id: Option.none(),
              onboarding_rules_role_id: Option.none(),
              onboarding_locale: 'en',
            }),
          ),
        ),
      ),
      Effect.tap(({ updated }) =>
        Effect.sync(() => {
          expect(updated.name).toBe('Updated Name');
          expect(Option.getOrNull(updated.description)).toBe('A great team');
          expect(Option.getOrNull(updated.sport)).toBe('football');
          expect(Option.isNone(updated.logo_url)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect(
    'update round-trips achievement_channel_id — Some value is persisted and returned',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createTestUser),
        Effect.bind('inserted', ({ userId }) =>
          TeamsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insert(
                makeInsert({
                  name: 'Achievement Channel Team',
                  guild_id: '222222222222222222' as Discord.Snowflake,
                  created_by: userId,
                }),
              ),
            ),
          ),
        ),
        Effect.bind('updated', ({ inserted }) =>
          TeamsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.update({
                id: inserted.id,
                name: 'Achievement Channel Team',
                description: Option.none(),
                sport: Option.none(),
                logo_url: Option.none(),
                welcome_channel_id: Option.none(),
                achievement_channel_id: Option.some('999000000000000001'),
                system_log_channel_id: Option.none(),
                welcome_message_template: Option.none(),
                rules_channel_id: Option.none(),
                onboarding_rules_role_id: Option.none(),
                onboarding_locale: 'en',
              }),
            ),
          ),
        ),
        Effect.tap(({ updated }) =>
          Effect.sync(() => {
            expect(Option.isSome(updated.achievement_channel_id)).toBe(true);
            expect(Option.getOrThrow(updated.achievement_channel_id)).toBe('999000000000000001');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect(
    'insert round-trips achievement_channel_id — Some value persists through INSERT and findById',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createTestUser),
        Effect.bind('inserted', ({ userId }) =>
          TeamsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insert(
                makeInsert({
                  name: 'Achievement Insert Team',
                  guild_id: '333333333333333333' as Discord.Snowflake,
                  created_by: userId,
                  achievement_channel_id: Option.some('123000000000000001' as Discord.Snowflake),
                }),
              ),
            ),
          ),
        ),
        Effect.bind('found', ({ inserted }) =>
          TeamsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(inserted.id))),
        ),
        Effect.tap(({ found }) =>
          Effect.sync(() => {
            expect(Option.isSome(found)).toBe(true);
            const team = Option.getOrThrow(found);
            expect(Option.isSome(team.achievement_channel_id)).toBe(true);
            expect(Option.getOrThrow(team.achievement_channel_id)).toBe('123000000000000001');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );
});
