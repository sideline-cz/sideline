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

  // ---------------------------------------------------------------------------
  // INSERT column-list completeness tests (covers the "silent drop" footgun)
  // ---------------------------------------------------------------------------

  it.effect(
    'insert round-trips all 16 non-generated columns — specifically the 6 formerly-dropped ones',
    () =>
      Effect.Do.pipe(
        Effect.bind('userId', () => createTestUser),
        Effect.bind('inserted', ({ userId }) =>
          TeamsRepository.asEffect().pipe(
            Effect.andThen((repo) =>
              repo.insert({
                name: 'Full Insert Team',
                guild_id: '400000000000000001' as Discord.Snowflake,
                created_by: userId,
                description: Option.some('team description'),
                sport: Option.some('football'),
                logo_url: Option.some('https://example.com/logo.png'),
                created_at: undefined,
                updated_at: undefined,
                welcome_channel_id: Option.some('400000000000000002' as Discord.Snowflake),
                system_log_channel_id: Option.some('400000000000000003' as Discord.Snowflake),
                welcome_message_template: Option.some('Welcome {{name}}!'),
                rules_channel_id: Option.some('400000000000000004' as Discord.Snowflake),
                overview_channel_id: Option.some('400000000000000005' as Discord.Snowflake),
                achievement_channel_id: Option.some('400000000000000006' as Discord.Snowflake),
                onboarding_rules_role_id: Option.some('400000000000000007' as Discord.Snowflake),
                onboarding_rules_prompt_id: Option.some('400000000000000008' as Discord.Snowflake),
                onboarding_locale: 'en',
                onboarding_synced_at: Option.none(),
                onboarding_sync_status: 'pending',
                onboarding_sync_error: Option.none(),
              }),
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

            // Core columns
            expect(team.name).toBe('Full Insert Team');
            expect(team.guild_id).toBe('400000000000000001');
            expect(Option.getOrThrow(team.description)).toBe('team description');
            expect(Option.getOrThrow(team.sport)).toBe('football');
            expect(Option.getOrThrow(team.logo_url)).toBe('https://example.com/logo.png');

            // Previously-persisted nullable columns
            expect(Option.getOrThrow(team.welcome_channel_id)).toBe('400000000000000002');
            expect(Option.getOrThrow(team.achievement_channel_id)).toBe('400000000000000006');

            // The 6 formerly-dropped columns — these FAIL until insertQuery is fixed
            expect(Option.getOrThrow(team.system_log_channel_id)).toBe('400000000000000003');
            expect(Option.getOrThrow(team.welcome_message_template)).toBe('Welcome {{name}}!');
            expect(Option.getOrThrow(team.rules_channel_id)).toBe('400000000000000004');
            expect(Option.getOrThrow(team.overview_channel_id)).toBe('400000000000000005');
            expect(Option.getOrThrow(team.onboarding_rules_role_id)).toBe('400000000000000007');
            expect(Option.getOrThrow(team.onboarding_rules_prompt_id)).toBe('400000000000000008');
          }),
        ),
        Effect.provide(TestLayer),
      ),
  );

  it.effect('insert with all-None nullable columns persists each as NULL (Option.none())', () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createTestUser),
      Effect.bind('inserted', ({ userId }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert(
              makeInsert({
                name: 'All None Insert Team',
                guild_id: '500000000000000001' as Discord.Snowflake,
                created_by: userId,
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

          expect(Option.isNone(team.description)).toBe(true);
          expect(Option.isNone(team.sport)).toBe(true);
          expect(Option.isNone(team.logo_url)).toBe(true);
          expect(Option.isNone(team.welcome_channel_id)).toBe(true);
          expect(Option.isNone(team.system_log_channel_id)).toBe(true);
          expect(Option.isNone(team.welcome_message_template)).toBe(true);
          expect(Option.isNone(team.rules_channel_id)).toBe(true);
          expect(Option.isNone(team.overview_channel_id)).toBe(true);
          expect(Option.isNone(team.achievement_channel_id)).toBe(true);
          expect(Option.isNone(team.onboarding_rules_role_id)).toBe(true);
          expect(Option.isNone(team.onboarding_rules_prompt_id)).toBe(true);
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );

  it.effect("insert respects non-default onboarding_locale 'cs'", () =>
    Effect.Do.pipe(
      Effect.bind('userId', () => createTestUser),
      Effect.bind('inserted', ({ userId }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert(
              makeInsert({
                name: 'Czech Locale Team',
                guild_id: '600000000000000001' as Discord.Snowflake,
                created_by: userId,
              }),
            ),
          ),
        ),
      ),
      // Update to set locale to 'cs' so we can verify it persists through update
      // (the insert always defaults — we test round-trip via update here as locale
      // is not yet in the insertQuery column list, which this test helps prove)
      Effect.bind('found', ({ inserted }) =>
        TeamsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(inserted.id))),
      ),
      Effect.tap(({ found }) =>
        Effect.sync(() => {
          // For now just assert the insert succeeded with default 'en' locale
          expect(Option.isSome(found)).toBe(true);
          const team = Option.getOrThrow(found);
          expect(team.onboarding_locale).toBe('en');
        }),
      ),
      // Now insert a second team directly with 'cs' locale to verify the round-trip
      Effect.bind('userId2', () => createTestUser),
      Effect.bind('czechTeam', ({ userId2 }) =>
        TeamsRepository.asEffect().pipe(
          Effect.andThen((repo) =>
            repo.insert({
              name: 'Czech Locale Team 2',
              guild_id: '600000000000000002' as Discord.Snowflake,
              created_by: userId2,
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
              onboarding_locale: 'cs',
              onboarding_synced_at: Option.none(),
              onboarding_sync_status: 'pending',
              onboarding_sync_error: Option.none(),
            }),
          ),
        ),
      ),
      Effect.bind('czechFound', ({ czechTeam }) =>
        TeamsRepository.asEffect().pipe(Effect.andThen((repo) => repo.findById(czechTeam.id))),
      ),
      Effect.tap(({ czechFound }) =>
        Effect.sync(() => {
          expect(Option.isSome(czechFound)).toBe(true);
          const team = Option.getOrThrow(czechFound);
          expect(team.onboarding_locale).toBe('cs');
        }),
      ),
      Effect.provide(TestLayer),
    ),
  );
});
